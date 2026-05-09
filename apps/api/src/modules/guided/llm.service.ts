import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { LlmProvidersService, ResolvedLlmConfig } from '../llm-providers/llm-providers.service';
import { buildProviderChatParams } from '../llm/llm-chat-params';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** App step identifier for provider routing (guided / generate / polish) */
  appStep?: string;
}

/**
 * Unified LLM chat service.
 * Resolves provider config via the 3-layer fallback chain:
 *   step routing → default provider → environment variables.
 */
@Injectable()
export class LlmService {
  private readonly logger = new StructuredLogger(LlmService.name);

  /** Cached env fallback values (read once at startup) */
  private readonly envBaseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:8318/v1';
  private readonly envApiKey = process.env.LLM_API_KEY ?? '';
  private readonly envModel = process.env.LLM_MODEL ?? 'gpt-4o';

  constructor(private readonly llmProviders: LlmProvidersService) {}

  /**
   * Send a chat completion request.
   * Uses appStep to resolve the correct provider; falls back to env vars.
   */
  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    // Resolve LLM config from DB or env
    const config = await this.resolveConfig(options?.appStep);

    if (!config.apiKey) {
      throw new Error('缺少 LLM API Key，无法调用 AI。请在 LLM 配置中设置 Provider。');
    }

    const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify({
      model: config.model,
      messages,
      ...buildProviderChatParams(config.params),
      temperature: options?.temperature ?? (config.params.temperature as number | undefined) ?? 0.8,
    });

    const t0 = Date.now();
    const msgPreview = messages.map((m) => `[${m.role}](${m.content.length}ch)`).join(' ');
    console.log(`[LLM] → ${config.model} src=${config.source} msgs=${messages.length} temp=${options?.temperature ?? 0.8} maxTokensSent=none requestedMaxTokens=${options?.maxTokens ?? 'none'} ${msgPreview}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(DEFAULT_LLM_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text();
      this.logger.error('guided.llm.chat.failed', new Error(`LLM request failed: ${response.status}`), {
        appStep: options?.appStep,
        source: config.source,
        baseUrl: config.baseUrl,
        model: config.model,
        elapsedMs: Date.now() - t0,
        httpStatus: response.status,
        rawProviderResponseLength: detail.length,
        rawProviderResponseText: detail,
      });
      throw new Error(`LLM 请求失败: ${response.status} ${detail.slice(0, 500)}`);
    }

    const bodyText = await response.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText) as Record<string, unknown>;
    } catch (error) {
      this.logger.error('guided.llm.chat.failed', error, {
        appStep: options?.appStep,
        source: config.source,
        baseUrl: config.baseUrl,
        model: config.model,
        elapsedMs: Date.now() - t0,
        httpStatus: response.status,
        rawProviderResponseLength: bodyText.length,
        rawProviderResponseText: bodyText,
      });
      throw error;
    }
    const text = this.extractText(payload);

    if (!text) {
      this.logger.error('guided.llm.chat.failed', new Error('LLM returned empty content'), {
        appStep: options?.appStep,
        source: config.source,
        baseUrl: config.baseUrl,
        model: config.model,
        elapsedMs: Date.now() - t0,
        rawProviderResponseLength: bodyText.length,
        rawProviderResponseText: bodyText,
      });
      throw new Error(`LLM 返回内容为空: ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const usage = payload.usage as Record<string, number> | undefined;
    const tokens = usage ? `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}` : '';
    console.log(`[LLM] ← ${config.model} ${text.length}ch ${elapsed}s ${tokens}`);
    this.logger.log('guided.llm.chat.completed', {
      appStep: options?.appStep,
      source: config.source,
      baseUrl: config.baseUrl,
      model: String(payload.model ?? config.model),
      tokenUsage: usage,
      elapsedMs: Date.now() - t0,
      rawResponseLength: text.length,
      rawResponseText: text,
      rawProviderResponseLength: bodyText.length,
      rawProviderResponseText: bodyText,
    });
    return text;
  }

  /**
   * Resolve config from the startup-loaded provider snapshot.
   * If the snapshot has no usable provider, use raw env vars as absolute fallback.
   */
  private resolveConfig(appStep?: string): ResolvedLlmConfig {
    try {
      return this.llmProviders.resolveForStep(appStep);
    } catch {
      // Absolute fallback: use env vars directly (e.g. during initial setup)
      return {
        baseUrl: this.envBaseUrl,
        apiKey: this.envApiKey,
        model: this.envModel,
        params: {},
        source: 'env_fallback',
      };
    }
  }

  /** Extract text content from OpenAI-compatible response payload */
  private extractText(payload: Record<string, unknown>): string {
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) return '';

    const message = choices[0].message as Record<string, unknown> | undefined;
    if (!message) return '';

    const content = message.content;
    if (typeof content === 'string') return content;

    // Handle structured content (e.g. array of text blocks)
    if (Array.isArray(content)) {
      return content
        .filter(
          (item: Record<string, unknown>) =>
            typeof item === 'object' &&
            (item.type === 'text' || item.type === 'output_text') &&
            typeof item.text === 'string',
        )
        .map((item: Record<string, unknown>) => item.text as string)
        .join('');
    }

    const reasoningContent = message.reasoning_content ?? message.reasoningContent;
    if (typeof reasoningContent === 'string') return reasoningContent;

    return '';
  }

}
