import { StructuredLogger } from '../../../common/logging/structured-logger';
import type { LlmChatMessage, LlmChatOptions } from '../../llm/dto/llm-chat.dto';
import type { LlmGatewayService } from '../../llm/llm-gateway.service';
import type { ToolContext } from '../base-tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';

type MaybePromise<T> = T | Promise<T>;

export type StructuredOutputRepairLogger = Pick<StructuredLogger, 'log' | 'error'>;

export interface StructuredOutputRepairOptions<T> {
  toolName: string;
  loggerEventPrefix: string;
  llm: Pick<LlmGatewayService, 'chatJson'>;
  context: ToolContext;
  data: unknown;
  normalize: (data: unknown) => MaybePromise<T>;
  shouldRepair: (input: {
    error: unknown;
    data: unknown;
    attempt: number;
  }) => boolean;
  buildRepairMessages: (input: {
    invalidOutput: unknown;
    validationError: string;
    attempt: number;
  }) => LlmChatMessage[];
  progress?: {
    phaseMessage: string;
    timeoutMs: number;
  };
  llmOptions?: Pick<LlmChatOptions, 'appStep' | 'timeoutMs' | 'temperature' | 'maxTokens' | 'jsonSchema'>;
  maxRepairAttempts?: number;
  initialModel?: string;
  logger?: StructuredOutputRepairLogger;
}

const defaultLogger = new StructuredLogger('StructuredOutputRepair');

export async function normalizeWithLlmRepair<T>(options: StructuredOutputRepairOptions<T>): Promise<T> {
  try {
    return await options.normalize(options.data);
  } catch (error) {
    return repairAfterNormalizeFailure(options, options.data, error);
  }
}

async function repairAfterNormalizeFailure<T>(
  options: StructuredOutputRepairOptions<T>,
  initialData: unknown,
  initialError: unknown,
): Promise<T> {
  const maxRepairAttempts = options.maxRepairAttempts ?? 1;
  const logger = options.logger ?? defaultLogger;
  let invalidOutput = initialData;
  let validationError = initialError;

  for (let attempt = 1; attempt <= maxRepairAttempts; attempt += 1) {
    if (!options.shouldRepair({ error: validationError, data: invalidOutput, attempt })) {
      throw validationError;
    }

    const validationErrorMessage = errorMessage(validationError);
    await options.context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: options.progress?.phaseMessage ?? `正在修复 ${options.toolName} 的结构化输出`,
      timeoutMs: options.progress?.timeoutMs ?? options.llmOptions?.timeoutMs,
    });

    const messages = options.buildRepairMessages({
      invalidOutput,
      validationError: validationErrorMessage,
      attempt,
    });
    const timeoutMs = options.llmOptions?.timeoutMs ?? options.progress?.timeoutMs;
    const repairLogContext = {
      agentRunId: options.context.agentRunId,
      projectId: options.context.projectId,
      mode: options.context.mode,
      toolName: options.toolName,
      attempt,
      maxRepairAttempts,
      validationError: validationErrorMessage,
      timeoutMs: timeoutMs ?? null,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
      initialModel: options.initialModel ?? null,
    };
    const startedAt = Date.now();
    logger.log(`${options.loggerEventPrefix}.llm_repair.started`, repairLogContext);

    let repairedData: unknown;
    let repairModel: string | undefined;
    let tokenUsage: Record<string, number> | undefined;
    try {
      const response = await options.llm.chatJson<unknown>(
        messages,
        {
          appStep: options.llmOptions?.appStep,
          timeoutMs,
          retries: 0,
          jsonMode: true,
          jsonSchema: options.llmOptions?.jsonSchema,
          temperature: options.llmOptions?.temperature,
          maxTokens: options.llmOptions?.maxTokens,
        },
      );
      recordToolLlmUsage(options.context, options.llmOptions?.appStep ?? options.toolName, response.result);
      repairedData = response.data;
      repairModel = response.result.model;
      tokenUsage = response.result.usage;
    } catch (error) {
      options.context.recordRepairDiagnostic?.({
        toolName: options.toolName,
        attempted: true,
        attempts: attempt,
        repairedFromErrors: [validationErrorMessage],
        failedError: errorMessage(error),
      });
      logger.error(`${options.loggerEventPrefix}.llm_repair.failed`, error, {
        ...repairLogContext,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }

    try {
      const normalized = await options.normalize(repairedData);
      options.context.recordRepairDiagnostic?.({
        toolName: options.toolName,
        attempted: true,
        attempts: attempt,
        repairedFromErrors: [validationErrorMessage],
        ...(repairModel ? { model: repairModel } : {}),
      });
      logger.log(`${options.loggerEventPrefix}.llm_repair.completed`, {
        ...repairLogContext,
        elapsedMs: Date.now() - startedAt,
        repairModel: repairModel ?? null,
        model: repairModel ?? null,
        tokenUsage,
      });
      return normalized;
    } catch (error) {
      options.context.recordRepairDiagnostic?.({
        toolName: options.toolName,
        attempted: true,
        attempts: attempt,
        repairedFromErrors: [validationErrorMessage],
        ...(repairModel ? { model: repairModel } : {}),
        failedError: errorMessage(error),
      });
      logger.error(`${options.loggerEventPrefix}.llm_repair.failed`, error, {
        ...repairLogContext,
        elapsedMs: Date.now() - startedAt,
        repairModel: repairModel ?? null,
        model: repairModel ?? null,
        tokenUsage,
      });
      invalidOutput = repairedData;
      validationError = error;
    }
  }

  throw validationError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
