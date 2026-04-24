import { ConflictException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLlmProviderDto } from './dto/create-llm-provider.dto';
import { UpdateLlmProviderDto } from './dto/update-llm-provider.dto';
import { SetRoutingDto } from './dto/set-routing.dto';

/** Allowed app steps for LLM routing — fixed set of 3 */
const VALID_APP_STEPS = ['guided', 'generate', 'polish'] as const;

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

  constructor(private readonly prisma: PrismaService) {}

  /** Load LLM routing/provider config once when Nest finishes bootstrapping this module. */
  async onModuleInit() {
    await this.reloadConfigCache();
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

  /** Test connectivity by calling the provider's /v1/models endpoint */
  async testConnectivity(id: string): Promise<{ success: boolean; models?: string[]; error?: string }> {
    const provider = this.cache.providers.find((item) => item.id === id);
    if (!provider) throw new NotFoundException(`Provider 不存在: ${id}`);

    const url = `${provider.baseUrl.replace(/\/+$/, '')}/models`;
    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const detail = await response.text();
        return { success: false, error: `${response.status}: ${detail.slice(0, 300)}` };
      }

      const payload = (await response.json()) as { data?: Array<{ id: string }> };
      const models = (payload.data ?? []).map((m) => m.id).slice(0, 20);
      return { success: true, models };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : '连接失败' };
    }
  }

  // ── Routing CRUD ──────────────────────────────────────

  /** Get all step routings (3 fixed steps, some may be unset) */
  listRoutings() {
    // Build a map of all 3 steps, filling in null for unset ones
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

  /**
   * Refresh API local cache and ask worker to reload its own process-local snapshot.
   * Worker refresh is best-effort so config CRUD remains usable even if worker is temporarily offline.
   */
  private async reloadRuntimeConfigCaches() {
    await this.reloadConfigCache();
    await this.notifyWorkerConfigReload();
  }

  /** Notify worker that DB-backed LLM config changed and its startup snapshot must be reloaded. */
  private async notifyWorkerConfigReload() {
    const workerBaseUrl = process.env.WORKER_BASE_URL;
    if (!workerBaseUrl) return;

    try {
      const response = await fetch(`${workerBaseUrl.replace(/\/+$/, '')}/internal/llm-config/reload`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        console.warn(`[LLM] worker config reload failed: ${response.status} ${await response.text()}`);
      }
    } catch (err) {
      console.warn(`[LLM] worker config reload skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
