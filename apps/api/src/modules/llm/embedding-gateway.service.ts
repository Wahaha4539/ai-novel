import { Injectable } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { LlmProvidersService, ResolvedLlmConfig } from '../llm-providers/llm-providers.service';
import { LlmEmbeddingOptions, LlmEmbeddingResult } from './dto/llm-chat.dto';

/**
 * API 内统一 Embedding 网关，兼容 OpenAI /embeddings。
 * 输入文本数组；输出向量数组；不产生业务写库副作用。
 */
@Injectable()
export class EmbeddingGatewayService {
  private readonly logger = new StructuredLogger(EmbeddingGatewayService.name);
  private readonly envBaseUrl = process.env.EMBEDDING_BASE_URL ?? 'http://localhost:18319/v1';
  private readonly envApiKey = process.env.EMBEDDING_API_KEY ?? '';
  private readonly envModel = process.env.EMBEDDING_MODEL ?? 'bge-base-zh';

  constructor(private readonly llmProviders: LlmProvidersService) {}

  /** 批量生成文本向量；调用失败会抛出统一错误，上层不得静默降级到低质量召回。 */
  async embedTexts(texts: string[], options: LlmEmbeddingOptions = {}): Promise<LlmEmbeddingResult> {
    const normalizedTexts = texts.map((item) => item.trim()).filter(Boolean);
    if (!normalizedTexts.length) return { vectors: [], model: this.envModel, rawPayloadSummary: { skipped: true, reason: 'empty_input' } };

    const appStep = options.appStep ?? 'embedding';
    const config = this.resolveConfig(appStep);
    const retries = options.retries ?? 1;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await this.requestEmbedding(config, normalizedTexts, options, { appStep, attemptNo: attempt + 1, maxAttempts: retries + 1 });
      } catch (error) {
        lastError = error;
      }
    }

    this.logger.error('embedding.request.exhausted', lastError, { appStep, inputCount: normalizedTexts.length, retries });
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

  private async requestEmbedding(config: ResolvedLlmConfig, input: string[], options: LlmEmbeddingOptions, trace: { appStep: string; attemptNo: number; maxAttempts: number }): Promise<LlmEmbeddingResult> {
    const url = `${config.baseUrl.replace(/\/+$/, '')}/embeddings`;
    const timeoutMs = options.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    const logContext = {
      appStep: trace.appStep,
      attemptNo: trace.attemptNo,
      maxAttempts: trace.maxAttempts,
      source: config.source,
      baseUrl: config.baseUrl,
      url,
      model: config.model,
      apiKeyConfigured: Boolean(config.apiKey),
      inputCount: input.length,
      totalInputChars: input.reduce((sum, item) => sum + item.length, 0),
      maxInputChars: Math.max(...input.map((item) => item.length)),
      timeoutMs,
    };

    // 调试日志只记录长度、路由和模型等元数据，避免把正文内容或 API Key 写入日志文件。
    this.logger.log('embedding.request.started', logContext);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // 本地 BGE embedding 服务通常无鉴权；配置 API Key 时才传 Authorization。
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: config.model, input }),
        signal: AbortSignal.timeout(timeoutMs),
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

      this.logger.log('embedding.request.completed', {
        ...logContext,
        status: response.status,
        responseModel: String(payload.model ?? config.model),
        vectorCount: vectors.length,
        dimension: vectors[0]?.length ?? 0,
        usage: payload.usage,
        elapsedMs: Date.now() - startedAt,
      });

      return { vectors, model: String(payload.model ?? config.model), usage: payload.usage as Record<string, number> | undefined, rawPayloadSummary: { model: payload.model, usage: payload.usage, count: vectors.length } };
    } catch (error) {
      this.logger.warn('embedding.request.failed', {
        ...logContext,
        elapsedMs: Date.now() - startedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}