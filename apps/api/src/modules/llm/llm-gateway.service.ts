import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { LlmProvidersService, ResolvedLlmConfig } from '../llm-providers/llm-providers.service';
import { LlmChatMessage, LlmChatOptions, LlmChatResult } from './dto/llm-chat.dto';
import { buildProviderChatParams } from './llm-chat-params';
import { postJson } from './llm-http-client';
import { DEFAULT_LLM_TIMEOUT_MS } from './llm-timeout.constants';

export class LlmTimeoutError extends Error {
  readonly code = 'LLM_TIMEOUT';

  constructor(message: string, readonly appStep: string | undefined, readonly timeoutMs: number, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmProviderError extends Error {
  readonly code = 'LLM_PROVIDER_ERROR';

  constructor(message: string, readonly appStep: string | undefined, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmProviderError';
  }
}

export class LlmJsonInvalidError extends Error {
  readonly code = 'LLM_JSON_INVALID';

  constructor(message: string, readonly appStep: string | undefined, readonly rawText: string, readonly cause?: unknown) {
    super(message);
    this.name = 'LlmJsonInvalidError';
  }
}

/**
 * API 内统一 LLM 网关。第一版兼容 OpenAI /chat/completions，
 * 为 Agent Planner 提供超时、重试和统一错误格式。
 */
@Injectable()
export class LlmGatewayService {
  private readonly logger = new StructuredLogger(LlmGatewayService.name);
  private readonly envBaseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:8318/v1';
  private readonly envApiKey = process.env.LLM_API_KEY ?? '';
  private readonly envModel = process.env.LLM_MODEL ?? 'gpt-4o';

  constructor(private readonly llmProviders: LlmProvidersService) {}

  async chat(messages: LlmChatMessage[], options: LlmChatOptions = {}): Promise<LlmChatResult> {
    const config = this.resolveConfig(options.appStep);
    const retries = options.retries ?? 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestChat(config, messages, options);
      } catch (error) {
        lastError = this.normalizeLlmError(error, options);
        if (lastError instanceof LlmTimeoutError) throw lastError;
      }
    }

    if (lastError instanceof LlmProviderError || lastError instanceof LlmTimeoutError) throw lastError;
    throw new LlmProviderError(`LLM 请求失败：${lastError instanceof Error ? lastError.message : String(lastError)}`, options.appStep, lastError);
  }

  /**
   * 请求 LLM 并解析 JSON，用于后续 Planner 输出结构化 Plan。
   * 只负责提取和解析 JSON，不执行任何 Tool，避免模型输出绕过 Agent Policy。
   */
  async chatJson<T = unknown>(messages: LlmChatMessage[], options: LlmChatOptions = {}): Promise<{ data: T; result: LlmChatResult }> {
    const result = await this.chat(messages, options);
    return { data: this.parseJson<T>(result.text, options.appStep), result };
  }

  private parseJson<T>(text: string, appStep?: string): T {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    const raw = fenced ?? trimmed;
    const candidate = this.extractJsonCandidate(raw);
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      throw new LlmJsonInvalidError(`LLM JSON 解析失败：${error instanceof Error ? error.message : String(error)}`, appStep, candidate.slice(0, 2000), error);
    }
  }

  private extractJsonCandidate(text: string): string {
    const trimmed = text.trim();
    const start = this.findJsonStartIndex(trimmed);
    if (start < 0) return trimmed;
    const end = this.findJsonEndIndex(trimmed, start);
    return end >= 0 ? trimmed.slice(start, end + 1) : trimmed.slice(start);
  }

  private findJsonStartIndex(text: string): number {
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (char === '{') return index;
      if (char === '[' && this.isPlausibleArrayStart(text, index)) return index;
    }
    return -1;
  }

  private isPlausibleArrayStart(text: string, index: number): boolean {
    let next = index + 1;
    while (next < text.length && /\s/.test(text[next])) next += 1;
    if (next >= text.length) return true;
    return '{}["]-0123456789tfn'.includes(text[next]);
  }

  private findJsonEndIndex(text: string, start: number): number {
    const stack = [text[start] === '{' ? '}' : ']'];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === '{') {
        stack.push('}');
      } else if (char === '[') {
        stack.push(']');
      } else if (char === '}' || char === ']') {
        const expected = stack.pop();
        if (char !== expected) return -1;
        if (stack.length === 0) return index;
      }
    }

    return -1;
  }

  private resolveConfig(appStep?: string): ResolvedLlmConfig {
    try {
      return this.llmProviders.resolveForStep(appStep);
    } catch {
      return { providerName: process.env.LLM_PROVIDER_NAME ?? 'env_fallback', baseUrl: this.envBaseUrl, apiKey: this.envApiKey, model: this.envModel, params: {}, source: 'env_fallback' };
    }
  }

  private async requestChat(config: ResolvedLlmConfig, messages: LlmChatMessage[], options: LlmChatOptions): Promise<LlmChatResult> {
    if (!config.apiKey) {
      throw new LlmProviderError('缺少 LLM API Key，无法调用 AI。', options.appStep);
    }

    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const logContext = this.buildRequestLogContext(config, messages, options, timeoutMs, startedAt);
    let response: { status: number; bodyText: string };
    try {
      response = await postJson(
        `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        {
          model: config.model,
          messages,
          ...buildProviderChatParams(config.params),
          temperature: options.temperature ?? (config.params.temperature as number | undefined) ?? 0.2,
          max_tokens: options.maxTokens ?? 2000,
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        },
        timeoutMs,
      );
    } catch (error) {
      const normalized = this.normalizeLlmError(error, { ...options, timeoutMs });
      this.logger.error('llm.gateway.chat.failed', normalized, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        cause: this.describeError(error),
      });
      throw normalized;
    }

    if (response.status < 200 || response.status >= 300) {
      const detail = response.bodyText;
      const message = `${response.status} ${detail.slice(0, 500)}`;
      if (response.status === 408 || response.status === 504 || /timeout|timed out|deadline exceeded/i.test(detail)) {
        const error = new LlmTimeoutError(`LLM 请求超时：${message}`, options.appStep, timeoutMs);
        this.logger.error('llm.gateway.chat.failed', error, {
          ...logContext,
          elapsedMs: Date.now() - startedAt,
          httpStatus: response.status,
          responseTextPreview: detail.slice(0, 500),
        });
        throw error;
      }
      const error = new LlmProviderError(`LLM 请求失败：${message}`, options.appStep);
      this.logger.error('llm.gateway.chat.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        httpStatus: response.status,
        responseTextPreview: detail.slice(0, 500),
      });
      throw error;
    }

    const payload = this.parseProviderJson(response.bodyText, options.appStep);
    const text = this.extractText(payload);
    if (!text) {
      const error = new LlmProviderError(`LLM 返回内容为空：${JSON.stringify(payload).slice(0, 500)}`, options.appStep);
      this.logger.error('llm.gateway.chat.failed', error, {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        rawPayloadSummary: { id: payload.id, model: payload.model, usage: payload.usage },
      });
      throw error;
    }

    const result = {
      text,
      model: String(payload.model ?? config.model),
      usage: payload.usage as Record<string, number> | undefined,
      elapsedMs: Date.now() - startedAt,
      rawPayloadSummary: { id: payload.id, model: payload.model, usage: payload.usage },
    };
    this.logger.log('llm.gateway.chat.completed', { ...logContext, model: result.model, tokenUsage: result.usage, elapsedMs: result.elapsedMs });
    return result;
  }

  private buildRequestLogContext(config: ResolvedLlmConfig, messages: LlmChatMessage[], options: LlmChatOptions, timeoutMs: number, startedAt: number): Record<string, unknown> {
    return {
      appStep: options.appStep,
      providerName: config.providerName,
      source: config.source,
      baseUrl: config.baseUrl,
      model: config.model,
      timeoutMs,
      maxTokens: options.maxTokens ?? 2000,
      temperature: options.temperature ?? (config.params.temperature as number | undefined) ?? 0.2,
      messageCount: messages.length,
      totalMessageChars: messages.reduce((sum, message) => sum + message.content.length, 0),
      startedAt: new Date(startedAt).toISOString(),
    };
  }

  private describeError(error: unknown, depth = 0): Record<string, unknown> | string {
    if (!error || typeof error !== 'object') return String(error);
    const record = error as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    if (typeof record.name === 'string') output.name = record.name;
    if (typeof record.message === 'string') output.message = record.message;
    if (typeof record.code === 'string' || typeof record.code === 'number') output.code = record.code;
    if (depth < 2 && record.cause !== undefined) output.cause = this.describeError(record.cause, depth + 1);
    return output;
  }

  private normalizeLlmError(error: unknown, options: LlmChatOptions): unknown {
    if (error instanceof LlmTimeoutError || error instanceof LlmProviderError || error instanceof LlmJsonInvalidError) return error;
    const timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {};
    const name = typeof record.name === 'string' ? record.name : '';
    const message = error instanceof Error ? error.message : String(error);
    const timeoutCode = this.findErrorCode(error, ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
    if (name === 'TimeoutError' || name === 'AbortError' || timeoutCode || /timeout|timed out|aborted/i.test(message)) {
      return new LlmTimeoutError(`LLM 在 ${Math.round(timeoutMs / 1000)}s 内未返回`, options.appStep, timeoutMs, error);
    }
    return new LlmProviderError(message, options.appStep, error);
  }

  private parseProviderJson(text: string, appStep?: string): Record<string, unknown> {
    try {
      const payload = JSON.parse(text) as unknown;
      return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    } catch (error) {
      throw new LlmProviderError(`LLM 返回非 JSON 响应：${error instanceof Error ? error.message : String(error)}`, appStep, error);
    }
  }

  private findErrorCode(error: unknown, codes: string[], depth = 0): string | undefined {
    if (!error || typeof error !== 'object' || depth > 4) return undefined;
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    if (code && codes.includes(code)) return code;
    return this.findErrorCode(record.cause, codes, depth + 1);
  }

  private extractText(payload: Record<string, unknown>): string {
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content
        .filter((item: Record<string, unknown>) => typeof item.text === 'string')
        .map((item: Record<string, unknown>) => item.text as string)
        .join('');
      if (parts.trim()) return parts;
    }

    // 兼容 MiMo 等 OpenAI-compatible 服务：可读文本可能被放在 reasoning_content，content 为空字符串。
    const reasoningContent = message?.reasoning_content ?? message?.reasoningContent;
    return typeof reasoningContent === 'string' ? reasoningContent : '';
  }
}
