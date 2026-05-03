import { ConflictException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLlmProviderDto } from './dto/create-llm-provider.dto';
import { UpdateLlmProviderDto } from './dto/update-llm-provider.dto';
import { SetRoutingDto } from './dto/set-routing.dto';

/** Allowed app steps for LLM routing — Agent-Centric API 内链路会复用这些步骤做模型路由。 */
const VALID_APP_STEPS = ['guided', 'agent_planner', 'generate', 'polish', 'summary', 'memory_review', 'embedding', 'fact_extractor.events', 'fact_extractor.states', 'fact_extractor.foreshadows'] as const;
const CONFIG_CACHE_STARTUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolved LLM configuration ready for API calls.
 * Contains everything needed to make an OpenAI-Compatible request.
 */
export interface ResolvedLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  params: Record<string, unknown>;
  /** Where this config came from — useful for logging */
  source: 'routing' | 'default_provider' | 'env_fallback';
}

type CachedLlmProvider = {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
  isDefault: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type CachedLlmRouting = {
  id: string;
  appStep: string;
  providerId: string;
  modelOverride: string | null;
  paramsOverride: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  provider: CachedLlmProvider;
};

type LlmConfigCache = {
  providers: CachedLlmProvider[];
  routings: CachedLlmRouting[];
};

@Injectable()
export class LlmProvidersService implements OnModuleInit {
  /** Process-local LLM config snapshot; loaded once at API startup and refreshed only after admin writes. */
  private cache: LlmConfigCache = { providers: [], routings: [] };
  private readonly logger = new Logger(LlmProvidersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Load LLM routing/provider config once when Nest finishes bootstrapping this module. */
  async onModuleInit() {
    await this.reloadConfigCacheWithStartupRetry();
  }

  // ── Provider CRUD ─────────────────────────────────────

  /** List all providers (apiKey masked for security) */
  listProviders() {
    return this.cache.providers.map((provider) => this.toPublicProvider(provider));
  }

  /** Get a single provider by ID (apiKey masked) */
  getProvider(id: string) {
    const provider = this.cache.providers.find((item) => item.id === id);
    if (!provider) throw new NotFoundException(`Provider 不存在: ${id}`);
    return this.toPublicProvider(provider);
  }

  /** Create a new LLM provider */
  async createProvider(dto: CreateLlmProviderDto) {
    // If marking as default, clear existing default first
    if (dto.isDefault) {
      await this.clearDefaultFlag();
    }

    const provider = await this.prisma.llmProvider.create({
      data: {
        name: dto.name,
        providerType: dto.providerType ?? 'openai_compatible',
        baseUrl: dto.baseUrl,
        apiKey: dto.apiKey,
        defaultModel: dto.defaultModel,
        extraConfig: (dto.extraConfig ?? {}) as object,
        isDefault: dto.isDefault ?? false,
      },
    });

    await this.reloadRuntimeConfigCaches();
    return { ...provider, apiKey: this.maskApiKey(provider.apiKey) };
  }

  /** Update an existing provider */
  async updateProvider(id: string, dto: UpdateLlmProviderDto) {
    const existing = await this.prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Provider 不存在: ${id}`);

    // If setting as default, clear other defaults first
    if (dto.isDefault === true) {
      await this.clearDefaultFlag();
    }

    const updated = await this.prisma.llmProvider.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.baseUrl !== undefined && { baseUrl: dto.baseUrl }),
        ...(dto.apiKey !== undefined && { apiKey: dto.apiKey }),
        ...(dto.defaultModel !== undefined && { defaultModel: dto.defaultModel }),
        ...(dto.extraConfig !== undefined && { extraConfig: dto.extraConfig as object }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    await this.reloadRuntimeConfigCaches();
    return { ...updated, apiKey: this.maskApiKey(updated.apiKey) };
  }

  /** Delete a provider (cascades to routing) */
  async deleteProvider(id: string) {
    const existing = await this.prisma.llmProvider.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Provider 不存在: ${id}`);

    await this.prisma.llmProvider.delete({ where: { id } });
    await this.reloadRuntimeConfigCaches();
    return { deleted: true };
  }

  /** Test the provider's current default model with one minimal chat request and expose the raw reply for UI diagnosis. */
  async testConnectivity(id: string): Promise<{ success: boolean; error?: string; chatTests?: Array<{ model: string; appSteps: string[]; success: boolean; replyContent?: string; error?: string }> }> {
    const provider = this.cache.providers.find((item) => item.id === id);
    if (!provider) throw new NotFoundException(`Provider 不存在: ${id}`);

    const chatTest = await this.testChatCompletion(provider, provider.defaultModel, ['当前模型']);
    if (!chatTest.success) return { success: false, chatTests: [chatTest], error: `简单对话测试失败：model=${chatTest.model}；${chatTest.error}` };
    return { success: true, chatTests: [chatTest] };
  }

  /** 发送一句极短的 chat/completions 请求，验证模型名、Key 和接口兼容性都能真实工作。 */
  private async testChatCompletion(provider: CachedLlmProvider, model: string, appSteps: string[]): Promise<{ model: string; appSteps: string[]; success: boolean; replyContent?: string; error?: string }> {
    try {
      const response = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '测试连通性，请只回复 OK。' }], temperature: 0, max_tokens: 16 }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const detail = await response.text();
        return { model, appSteps, success: false, error: `${response.status}: ${detail.slice(0, 500)}` };
      }
      const payload = await response.json() as Record<string, unknown>;
      const reply = this.extractChatReply(payload).trim();
      return { model, appSteps, success: Boolean(reply), replyContent: reply, ...(reply ? {} : { error: 'chat/completions 返回内容为空' }) };
    } catch (err) {
      return { model, appSteps, success: false, error: err instanceof Error ? err.message : 'chat/completions 请求失败' };
    }
  }

  /** 兼容 OpenAI 文本、content parts 和 MiMo reasoning_content，只用于连通性测试取一小段预览。 */
  private extractChatReply(payload: Record<string, unknown>): string {
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const parts = content.filter((item: Record<string, unknown>) => typeof item.text === 'string').map((item: Record<string, unknown>) => item.text as string).join('');
      if (parts.trim()) return parts;
    }

    // MiMo 小写模型会出现 content 为空、reasoning_content 有返回文本的情况，测试页需要把它展示出来。
    const reasoningContent = message?.reasoning_content ?? message?.reasoningContent;
    return typeof reasoningContent === 'string' ? reasoningContent : '';
  }

  // ── Routing CRUD ──────────────────────────────────────

  /** Get all step routings (fixed known steps, some may be unset) */
  listRoutings() {
    // Build a map of all known app steps, filling in null for unset ones.
    return VALID_APP_STEPS.map((step) => {
      const routing = this.cache.routings.find((r) => r.appStep === step);
      return {
        appStep: step,
        routing: routing
          ? {
              id: routing.id,
              appStep: routing.appStep,
              providerId: routing.providerId,
              modelOverride: routing.modelOverride,
              paramsOverride: routing.paramsOverride,
              createdAt: routing.createdAt,
              updatedAt: routing.updatedAt,
              provider: {
                id: routing.provider.id,
                name: routing.provider.name,
                defaultModel: routing.provider.defaultModel,
                isActive: routing.provider.isActive,
              },
            }
          : null,
      };
    });
  }

  /** Set or update routing for a specific app step */
  async setRouting(appStep: string, dto: SetRoutingDto) {
    // Validate app step
    if (!VALID_APP_STEPS.includes(appStep as typeof VALID_APP_STEPS[number])) {
      throw new ConflictException(`无效的应用步骤: ${appStep}。可选值: ${VALID_APP_STEPS.join(', ')}`);
    }

    // Verify provider exists from the startup cache; no read query is needed before the write.
    const provider = this.cache.providers.find((item) => item.id === dto.providerId);
    if (!provider) throw new NotFoundException(`Provider 不存在: ${dto.providerId}`);

    // Upsert: create or update the routing for this step
    const routing = await this.prisma.llmRouting.upsert({
      where: { appStep },
      create: {
        appStep,
        providerId: dto.providerId,
        modelOverride: dto.modelOverride,
        paramsOverride: (dto.paramsOverride ?? {}) as object,
      },
      update: {
        providerId: dto.providerId,
        modelOverride: dto.modelOverride,
        paramsOverride: (dto.paramsOverride ?? {}) as object,
      },
      include: {
        provider: {
          select: { id: true, name: true, defaultModel: true },
        },
      },
    });
    await this.reloadRuntimeConfigCaches();
    return routing;
  }

  /** Remove routing for a step (step falls back to default provider → env) */
  async deleteRouting(appStep: string) {
    const existing = await this.prisma.llmRouting.findUnique({ where: { appStep } });
    if (!existing) return { deleted: false };
    await this.prisma.llmRouting.delete({ where: { appStep } });
    await this.reloadRuntimeConfigCaches();
    return { deleted: true };
  }

  // ── Resolution Logic ──────────────────────────────────

  /**
   * Resolve LLM config for a given app step.
   * Fallback chain: step routing → default provider → environment variables.
   *
   * @param appStep - Optional step identifier. When omitted, skips routing lookup.
   */
  resolveForStep(appStep?: string): ResolvedLlmConfig {
    // 1. Try step-specific routing
    if (appStep) {
      const routing = this.cache.routings.find((item) => item.appStep === appStep);

      if (routing?.provider?.isActive) {
        return {
          baseUrl: routing.provider.baseUrl,
          apiKey: routing.provider.apiKey,
          model: routing.modelOverride ?? routing.provider.defaultModel,
          params: { ...routing.provider.extraConfig, ...routing.paramsOverride },
          source: 'routing',
        };
      }
    }

    // 2. Try default provider
    const defaultProvider = this.cache.providers.find((provider) => provider.isDefault && provider.isActive);

    if (defaultProvider) {
      return {
        baseUrl: defaultProvider.baseUrl,
        apiKey: defaultProvider.apiKey,
        model: defaultProvider.defaultModel,
        params: defaultProvider.extraConfig,
        source: 'default_provider',
      };
    }

    // 3. Fall back to environment variables
    const envBaseUrl = process.env.LLM_BASE_URL;
    const envApiKey = process.env.LLM_API_KEY;
    const envModel = process.env.LLM_MODEL;

    if (envBaseUrl && envApiKey) {
      return {
        baseUrl: envBaseUrl,
        apiKey: envApiKey,
        model: envModel ?? 'gpt-4o',
        params: {},
        source: 'env_fallback',
      };
    }

    throw new Error('未配置任何 LLM Provider，也没有环境变量兜底。请在 LLM 配置页面创建一个 Provider。');
  }

  // ── Helpers ───────────────────────────────────────────

  /** Mask API key for safe display: show first 4 + last 4 chars */
  private maskApiKey(key: string): string {
    if (!key || key.length <= 8) return '****';
    return `${key.slice(0, 4)}${'*'.repeat(Math.min(key.length - 8, 16))}${key.slice(-4)}`;
  }

  /** Convert the cached secret-bearing provider into the safe DTO returned to web clients. */
  private toPublicProvider(provider: CachedLlmProvider) {
    return {
      id: provider.id,
      name: provider.name,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      apiKey: this.maskApiKey(provider.apiKey),
      defaultModel: provider.defaultModel,
      extraConfig: provider.extraConfig,
      isDefault: provider.isDefault,
      isActive: provider.isActive,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt,
      /** Which app steps are routed to this provider */
      routedSteps: this.cache.routings
        .filter((routing) => routing.providerId === provider.id)
        .map((routing) => routing.appStep),
    };
  }

  /** Clear isDefault flag on all providers (before setting a new default) */
  private async clearDefaultFlag() {
    await this.prisma.llmProvider.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  /**
   * Loads the startup LLM config snapshot with bounded retry.
   *
   * This protects API boot from short PostgreSQL/proxy flaps; runtime admin writes
   * still call reloadConfigCache directly so real write failures surface immediately.
   */
  private async reloadConfigCacheWithStartupRetry(): Promise<void> {
    const maxAttempts = CONFIG_CACHE_STARTUP_RETRY_DELAYS_MS.length + 1;
    let lastError: unknown = new Error('加载 LLM Provider 配置失败');

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.reloadConfigCache();
        if (attempt > 1) this.logger.log(`LLM Provider 配置加载成功，第 ${attempt}/${maxAttempts} 次尝试。`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;

        const delayMs = CONFIG_CACHE_STARTUP_RETRY_DELAYS_MS[attempt - 1];
        // 启动阶段的配置缓存依赖远程数据库；P1001 等短暂连通性问题不应直接终止开发服务。
        this.logger.warn(`LLM Provider 配置加载失败，第 ${attempt}/${maxAttempts} 次：${getErrorMessage(error)}。${delayMs}ms 后重试。`);
        await delay(delayMs);
      }
    }

    throw lastError;
  }

  /**
   * Refresh the process-local LLM config snapshot from DB.
   * Runtime LLM calls read only this snapshot, so generation no longer queries DB per request.
   */
  private async reloadConfigCache() {
    const [providers, routings] = await Promise.all([
      this.prisma.llmProvider.findMany({
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      }),
      this.prisma.llmRouting.findMany({ include: { provider: true } }),
    ]);

    this.cache = {
      providers: providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        defaultModel: provider.defaultModel,
        extraConfig: (provider.extraConfig ?? {}) as Record<string, unknown>,
        isDefault: provider.isDefault,
        isActive: provider.isActive,
        createdAt: provider.createdAt,
        updatedAt: provider.updatedAt,
      })),
      routings: routings.map((routing) => ({
        id: routing.id,
        appStep: routing.appStep,
        providerId: routing.providerId,
        modelOverride: routing.modelOverride,
        paramsOverride: (routing.paramsOverride ?? {}) as Record<string, unknown>,
        createdAt: routing.createdAt,
        updatedAt: routing.updatedAt,
        provider: {
          id: routing.provider.id,
          name: routing.provider.name,
          providerType: routing.provider.providerType,
          baseUrl: routing.provider.baseUrl,
          apiKey: routing.provider.apiKey,
          defaultModel: routing.provider.defaultModel,
          extraConfig: (routing.provider.extraConfig ?? {}) as Record<string, unknown>,
          isDefault: routing.provider.isDefault,
          isActive: routing.provider.isActive,
          createdAt: routing.provider.createdAt,
          updatedAt: routing.provider.updatedAt,
        },
      })),
    };
  }

  /** Refresh API local cache; Worker-era reload is intentionally removed from the Agent-Centric API runtime. */
  private async reloadRuntimeConfigCaches() {
    await this.reloadConfigCache();
  }
}
