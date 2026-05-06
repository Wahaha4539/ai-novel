import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { LlmProvidersService, ResolvedLlmConfig } from '../llm-providers/llm-providers.service';
import { LlmChatMessage, LlmChatOptions, LlmChatResult } from './dto/llm-chat.dto';

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
        lastError = error;
      }
    }

    throw new Error(`LLM 请求失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  /**
   * 请求 LLM 并解析 JSON，用于后续 Planner 输出结构化 Plan。
   * 只负责提取和解析 JSON，不执行任何 Tool，避免模型输出绕过 Agent Policy。
   */
  async chatJson<T = unknown>(messages: LlmChatMessage[], options: LlmChatOptions = {}): Promise<{ data: T; result: LlmChatResult }> {
    const result = await this.chat(messages, options);
    return { data: this.parseJson<T>(result.text), result };
  }

  private parseJson<T>(text: string): T {
    const trimmed = text.trim();
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1];
    const raw = fenced ?? trimmed;
    const candidate = this.extractJsonCandidate(raw);
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      throw new Error(`LLM JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private extractJsonCandidate(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

    // 部分 OpenAI-compatible 服务会在 JSON 前后附加说明；只截取最外层 JSON，交给 schema 校验继续兜底。
    const objectStart = trimmed.indexOf('{');
    const arrayStart = trimmed.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    const start = starts.length ? Math.min(...starts) : -1;
    const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
    return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  }

  private resolveConfig(appStep?: string): ResolvedLlmConfig {
    try {
      return this.llmProviders.resolveForStep(appStep);
    } catch {
      return { baseUrl: this.envBaseUrl, apiKey: this.envApiKey, model: this.envModel, params: {}, source: 'env_fallback' };
    }
  }

  private async requestChat(config: ResolvedLlmConfig, messages: LlmChatMessage[], options: LlmChatOptions): Promise<LlmChatResult> {
    if (!config.apiKey) {
      throw new Error('缺少 LLM API Key，无法调用 AI。');
    }

    const startedAt = Date.now();
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? (config.params.temperature as number | undefined) ?? 0.2,
        max_tokens: options.maxTokens ?? 2000,
        ...(options.tools ? { tools: options.tools } : {}),
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${detail.slice(0, 500)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const text = this.extractText(payload);
    if (!text) throw new Error(`LLM 返回内容为空：${JSON.stringify(payload).slice(0, 500)}`);

    const result = {
      text,
      model: String(payload.model ?? config.model),
      usage: payload.usage as Record<string, number> | undefined,
      elapsedMs: Date.now() - startedAt,
      rawPayloadSummary: { id: payload.id, model: payload.model, usage: payload.usage },
    };
    this.logger.log('llm.gateway.chat.completed', { appStep: options.appStep, model: result.model, tokenUsage: result.usage, elapsedMs: result.elapsedMs });
    return result;
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
