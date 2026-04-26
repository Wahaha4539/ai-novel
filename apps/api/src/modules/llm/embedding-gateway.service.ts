import { Injectable } from '@nestjs/common';
import { LlmProvidersService, ResolvedLlmConfig } from '../llm-providers/llm-providers.service';
import { LlmEmbeddingOptions, LlmEmbeddingResult } from './dto/llm-chat.dto';

/**
 * API 内统一 Embedding 网关，兼容 OpenAI /embeddings。
 * 输入文本数组；输出向量数组；不产生业务写库副作用。
 */
@Injectable()
export class EmbeddingGatewayService {
  private readonly envBaseUrl = process.env.EMBEDDING_BASE_URL ?? 'http://localhost:18319/v1';
  private readonly envApiKey = process.env.EMBEDDING_API_KEY ?? '';
  private readonly envModel = process.env.EMBEDDING_MODEL ?? 'bge-base-zh';

  constructor(private readonly llmProviders: LlmProvidersService) {}

  /** 批量生成文本向量；调用失败会抛出统一错误，上层不得静默降级到低质量召回。 */
  async embedTexts(texts: string[], options: LlmEmbeddingOptions = {}): Promise<LlmEmbeddingResult> {
    const normalizedTexts = texts.map((item) => item.trim()).filter(Boolean);
    if (!normalizedTexts.length) return { vectors: [], model: this.envModel, rawPayloadSummary: { skipped: true, reason: 'empty_input' } };

    const config = this.resolveConfig(options.appStep ?? 'embedding');
    const retries = options.retries ?? 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestEmbedding(config, normalizedTexts, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw new Error(`Embedding 请求失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }

  private resolveConfig(appStep?: string): ResolvedLlmConfig {
    try {
      const routed = this.llmProviders.resolveForStep(appStep);
      if (routed.source === 'routing') return routed;
    } catch {
      // 未配置 DB 路由时继续使用独立 embedding 服务默认配置；不要回退到 LLM。
    }
    // 与 Worker 对齐：embedding 是独立 BGE OpenAI-Compatible 服务，API Key 可为空。
    return { baseUrl: this.envBaseUrl, apiKey: this.envApiKey, model: this.envModel, params: {}, source: 'env_fallback' };
  }

  private async requestEmbedding(config: ResolvedLlmConfig, input: string[], options: LlmEmbeddingOptions): Promise<LlmEmbeddingResult> {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 本地 BGE embedding 服务通常无鉴权；配置 API Key 时才传 Authorization。
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: config.model, input }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${response.status} ${detail.slice(0, 500)}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const data = Array.isArray(payload.data) ? payload.data : [];
    const vectors = data
      .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).embedding : undefined))
      .filter((embedding): embedding is number[] => Array.isArray(embedding) && embedding.every((value) => typeof value === 'number'));

    if (vectors.length !== input.length) throw new Error(`Embedding 返回数量不匹配：期望 ${input.length}，实际 ${vectors.length}`);
    return { vectors, model: String(payload.model ?? config.model), usage: payload.usage as Record<string, number> | undefined, rawPayloadSummary: { model: payload.model, usage: payload.usage, count: vectors.length } };
  }
}