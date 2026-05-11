import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { WRITE_CHAPTER_SYSTEM_PROMPT, WRITE_CHAPTER_USER_TEMPLATE } from './seed-prompts/write-chapter';

// 加载仓库根目录 .env，保持单一配置来源。
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

const prisma = new PrismaClient();

const REQUIRED_LLM_STEPS = [
  'agent_planner',
  'planner', // 兼容 generate_outline_preview / build_import_preview 当前仍使用的历史 appStep。
  'generate',
  'summary',
  'memory_review',
  'fact_extractor.events',
  'fact_extractor.states',
  'fact_extractor.foreshadows',
] as const;

const REQUIRED_AGENT_TABLES = ['AgentRun', 'AgentPlan', 'AgentStep', 'AgentArtifact', 'AgentApproval'] as const;

interface ScriptOptions {
  dryRun: boolean;
  skipProviderConfig: boolean;
  skipPromptTemplate: boolean;
  skipBackfill: boolean;
  projectId?: string;
  chapterId?: string;
  backfillBatchSize: number;
  maxChunks?: number;
  reembedAllOnDimMismatch: boolean;
}

interface ProviderConfig {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  extraConfig: Record<string, unknown>;
  isDefault: boolean;
}

interface EmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface MemoryChunkTarget {
  id: string;
  memoryType: string;
  content: string;
  summary: string | null;
  metadata: unknown;
}

interface EmbeddingResponseItem {
  index?: number;
  embedding?: unknown;
}

interface EmbeddingResponsePayload {
  data?: EmbeddingResponseItem[];
  model?: string;
  usage?: unknown;
}

interface MaintenanceSummary {
  vectorExtensionReady: boolean;
  providersConfigured: boolean;
  promptTemplateReady: boolean;
  backfilledCount: number;
  backfillFailedCount: number;
  remainingNullEmbeddings: number;
  dimStats: Array<{ dim: number; count: number }>;
  hardFailures: string[];
}

/**
 * 入口：按质量关键链路的依赖顺序执行 DB 配置补齐、向量补齐与质量检查。
 * 输入来自 .env 与可选 CLI 参数；输出为控制台报告；副作用为写入 Provider/Routing/PromptTemplate/MemoryChunk。
 */
async function main() {
  const options = parseOptions(process.argv.slice(2));
  const summary: MaintenanceSummary = {
    vectorExtensionReady: false,
    providersConfigured: false,
    promptTemplateReady: false,
    backfilledCount: 0,
    backfillFailedCount: 0,
    remainingNullEmbeddings: 0,
    dimStats: [],
    hardFailures: [],
  };

  console.log('🔧 DB maintenance started');
  console.log(`   scope: projectId=${options.projectId ?? '*'}, chapterId=${options.chapterId ?? '*'}`);
  if (options.dryRun) console.log('   mode: dry-run（只检查，不写库）');

  summary.vectorExtensionReady = await ensureVectorExtension(options);
  await checkAgentSchema(summary);

  if (!options.skipProviderConfig) {
    summary.providersConfigured = await ensureLlmProvidersAndRoutings(options);
  } else {
    console.log('⏭️  skip provider/routing config');
  }

  if (!options.skipPromptTemplate) {
    summary.promptTemplateReady = await ensureWriteChapterPromptTemplate(options);
  } else {
    console.log('⏭️  skip write_chapter PromptTemplate config');
  }

  const beforeDimStats = await getEmbeddingDimensionStats(options);
  if (beforeDimStats.length > 1 && options.reembedAllOnDimMismatch) {
    console.warn(`⚠️  检测到 embedding 维度不一致，将按配置统一重算：${formatDimStats(beforeDimStats)}`);
    const result = await backfillMemoryEmbeddings(options, { forceAllInScope: true });
    summary.backfilledCount += result.updatedCount;
    summary.backfillFailedCount += result.failedCount;
  } else if (!options.skipBackfill) {
    const result = await backfillMemoryEmbeddings(options, { forceAllInScope: false });
    summary.backfilledCount += result.updatedCount;
    summary.backfillFailedCount += result.failedCount;
  } else {
    console.log('⏭️  skip MemoryChunk embedding backfill');
  }

  await runMemoryEmbeddingChecks(options, summary);
  await runQualityChecks(options);

  printSummary(summary);
  if (summary.hardFailures.length > 0) {
    throw new Error(`DB maintenance finished with hard failures:\n- ${summary.hardFailures.join('\n- ')}`);
  }
}

/**
 * 解析 CLI 与环境变量，CLI 优先级高于 .env。
 * 输出会限制 batch/maxChunks，避免误把过大的批量请求打到 embedding 服务。
 */
function parseOptions(args: string[]): ScriptOptions {
  const argMap = new Map<string, string | boolean>();
  for (const arg of args) {
    if (!arg.startsWith('--')) continue;
    const [rawKey, rawValue] = arg.slice(2).split('=', 2);
    argMap.set(rawKey, rawValue ?? true);
  }

  const projectId = stringOption(argMap, 'projectId') ?? process.env.DB_MAINTENANCE_PROJECT_ID;
  const chapterId = stringOption(argMap, 'chapterId') ?? process.env.DB_MAINTENANCE_CHAPTER_ID;
  const maxChunksValue = stringOption(argMap, 'maxChunks') ?? process.env.DB_MAINTENANCE_BACKFILL_MAX_CHUNKS;

  return {
    dryRun: booleanOption(argMap, 'dry-run', envBoolean('DB_MAINTENANCE_DRY_RUN')),
    skipProviderConfig: booleanOption(argMap, 'skip-provider-config', envBoolean('DB_MAINTENANCE_SKIP_PROVIDER_CONFIG')),
    skipPromptTemplate: booleanOption(argMap, 'skip-prompt-template', envBoolean('DB_MAINTENANCE_SKIP_PROMPT_TEMPLATE')),
    skipBackfill: booleanOption(argMap, 'skip-backfill', envBoolean('DB_MAINTENANCE_SKIP_BACKFILL')),
    projectId,
    chapterId,
    backfillBatchSize: clampNumber(Number(stringOption(argMap, 'batchSize') ?? process.env.DB_MAINTENANCE_BACKFILL_BATCH_SIZE ?? 16), 1, 64),
    maxChunks: maxChunksValue ? Math.max(0, Number(maxChunksValue)) : undefined,
    reembedAllOnDimMismatch: booleanOption(argMap, 'reembed-all-on-dim-mismatch', envBoolean('DB_MAINTENANCE_REEMBED_ALL_ON_DIM_MISMATCH')),
  };
}

/** 确保 pgvector 扩展可用，并用一次 vector cast 做运行时验证。 */
async function ensureVectorExtension(options: ScriptOptions): Promise<boolean> {
  if (options.dryRun) {
    const installed = await hasVectorExtension();
    console.log(`${installed ? '✅' : '❌'} pgvector extension ${installed ? 'already installed' : 'not installed'}`);
    return installed;
  }

  await prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS vector');
  await prisma.$queryRawUnsafe(`SELECT '[1,2,3]'::vector <=> '[1,2,4]'::vector AS distance`);
  console.log('✅ pgvector extension ready');
  return true;
}

/** 查询 pg_extension，避免 dry-run 模式产生写库副作用。 */
async function hasVectorExtension(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ installed: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS installed
  `;
  return Boolean(rows[0]?.installed);
}

/**
 * 根据 .env 补齐 LlmProvider 与 LlmRouting。
 * LLM 步骤走 LLM_*；embedding 只走专门的 EMBEDDING_* / BGE 服务，不写入 LLM 路由。
 */
async function ensureLlmProvidersAndRoutings(options: ScriptOptions): Promise<boolean> {
  const llmConfig = readProviderConfig({
    name: process.env.LLM_PROVIDER_NAME ?? 'env_llm_primary',
    baseUrl: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    defaultModelFallback: 'gpt-4o',
    extraConfigEnv: process.env.LLM_PROVIDER_EXTRA_CONFIG_JSON,
    isDefault: true,
  });

  if (options.dryRun) {
    console.log(`🔎 dry-run provider config: llm=${llmConfig.name}`);
    return await verifyRequiredRoutingsExist();
  }

  const llmProvider = await upsertProvider(llmConfig);

  for (const appStep of REQUIRED_LLM_STEPS) {
    await prisma.llmRouting.upsert({
      where: { appStep },
      create: { appStep, providerId: llmProvider.id, paramsOverride: {} },
      update: { providerId: llmProvider.id, modelOverride: null, paramsOverride: {} },
    });
  }

  console.log(`✅ LLM providers/routings ready (${REQUIRED_LLM_STEPS.length} routes)`);
  return true;
}

/** 从环境变量生成 Provider 配置；缺关键字段直接失败，避免写入不可用路由。 */
function readProviderConfig(input: {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  defaultModelFallback: string;
  extraConfigEnv?: string;
  isDefault: boolean;
}): ProviderConfig {
  if (!input.baseUrl || !input.apiKey) {
    throw new Error(`缺少 Provider 环境变量：${input.name} 需要 baseUrl 和 apiKey`);
  }
  return {
    name: input.name,
    providerType: 'openai_compatible',
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    defaultModel: input.model ?? input.defaultModelFallback,
    extraConfig: parseJsonObject(input.extraConfigEnv, `${input.name}.extraConfig`),
    isDefault: input.isDefault,
  };
}

/** 使用 name 作为幂等键补齐 Provider；schema 未声明唯一约束，因此先查后写。 */
async function upsertProvider(config: ProviderConfig) {
  if (config.isDefault) {
    await prisma.llmProvider.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
  }

  const existing = await prisma.llmProvider.findFirst({ where: { name: config.name } });
  if (existing) {
    return prisma.llmProvider.update({
      where: { id: existing.id },
      data: {
        providerType: config.providerType,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        defaultModel: config.defaultModel,
        extraConfig: config.extraConfig as Prisma.InputJsonValue,
        isDefault: config.isDefault,
        isActive: true,
      },
    });
  }

  return prisma.llmProvider.create({
    data: {
      name: config.name,
      providerType: config.providerType,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      defaultModel: config.defaultModel,
      extraConfig: config.extraConfig as Prisma.InputJsonValue,
      isDefault: config.isDefault,
      isActive: true,
    },
  });
}

/** dry-run 下校验必须 appStep 是否已有可用路由。 */
async function verifyRequiredRoutingsExist(): Promise<boolean> {
  const rows = await prisma.llmRouting.findMany({
    where: { appStep: { in: [...REQUIRED_LLM_STEPS] } },
    include: { provider: true },
  });
  const routed = new Set(rows.filter((row) => row.provider.isActive).map((row) => row.appStep));
  const missing = REQUIRED_LLM_STEPS.filter((step) => !routed.has(step));
  if (missing.length > 0) console.warn(`⚠️  missing active LLM routings: ${missing.join(', ')}`);
  return missing.length === 0;
}

/** 补齐全局默认 write_chapter PromptTemplate；模板内容复用现有 seed prompt。 */
async function ensureWriteChapterPromptTemplate(options: ScriptOptions): Promise<boolean> {
  const existing = await prisma.promptTemplate.findFirst({
    where: { projectId: null, stepKey: 'write_chapter', isDefault: true },
  });

  if (existing?.systemPrompt?.trim() && existing.userTemplate?.trim()) {
    console.log('✅ default write_chapter PromptTemplate already ready');
    return true;
  }

  if (options.dryRun) {
    console.warn('⚠️  default write_chapter PromptTemplate missing or empty');
    return false;
  }

  const sameName = await prisma.promptTemplate.findFirst({
    where: { projectId: null, stepKey: 'write_chapter', name: '章节生成（默认）' },
  });

  if (sameName) {
    await prisma.promptTemplate.update({
      where: { id: sameName.id },
      data: {
        description: '专业级章节正文写作，含MRU推进法、感官描写、对话技术、去AI味规则',
        systemPrompt: WRITE_CHAPTER_SYSTEM_PROMPT,
        userTemplate: WRITE_CHAPTER_USER_TEMPLATE,
        isDefault: true,
        tags: ['写作', '正文', '章节'],
      },
    });
  } else {
    await prisma.promptTemplate.create({
      data: {
        projectId: null,
        stepKey: 'write_chapter',
        name: '章节生成（默认）',
        description: '专业级章节正文写作，含MRU推进法、感官描写、对话技术、去AI味规则',
        systemPrompt: WRITE_CHAPTER_SYSTEM_PROMPT,
        userTemplate: WRITE_CHAPTER_USER_TEMPLATE,
        isDefault: true,
        tags: ['写作', '正文', '章节'],
      },
    });
  }

  console.log('✅ default write_chapter PromptTemplate ready');
  return true;
}

/**
 * 为 MemoryChunk 补齐或重算 embedding。
 * 默认只处理 embedding IS NULL；forceAllInScope 用于维度不一致时统一重算当前 scope。
 */
async function backfillMemoryEmbeddings(options: ScriptOptions, mode: { forceAllInScope: boolean }) {
  if (options.skipBackfill && !mode.forceAllInScope) return { updatedCount: 0, failedCount: 0 };

  const embeddingConfig = await resolveEmbeddingConfig();
  let updatedCount = 0;
  let failedCount = 0;
  let scannedCount = 0;

  while (options.maxChunks === undefined || scannedCount < options.maxChunks) {
    const remainingBudget = options.maxChunks === undefined ? options.backfillBatchSize : Math.min(options.backfillBatchSize, options.maxChunks - scannedCount);
    if (remainingBudget <= 0) break;

    const chunks = await findMemoryChunksForEmbedding(options, remainingBudget, mode.forceAllInScope);
    if (chunks.length === 0) break;
    scannedCount += chunks.length;

    if (options.dryRun) {
      console.log(`🔎 dry-run would ${mode.forceAllInScope ? 're-embed' : 'backfill'} ${chunks.length} MemoryChunk rows`);
      updatedCount += chunks.length;
      break;
    }

    try {
      const input = chunks.map((chunk) => buildEmbeddingText(chunk));
      const vectors = await requestEmbeddings(embeddingConfig, input);
      for (const [index, chunk] of chunks.entries()) {
        await prisma.memoryChunk.update({
          where: { id: chunk.id },
          data: {
            embedding: vectors[index] as Prisma.InputJsonValue,
            metadata: mergeMetadata(chunk.metadata, {
              embeddingModel: embeddingConfig.model,
              embeddingBackfilledBy: 'db_maintenance_script',
              embeddingBackfilledAt: new Date().toISOString(),
            }) as Prisma.InputJsonValue,
          },
        });
        updatedCount += 1;
      }
    } catch (error) {
      failedCount += chunks.length;
      console.error(`❌ embedding batch failed (${chunks.length} rows): ${error instanceof Error ? error.message : String(error)}`);
      // 当前批次失败时停止继续请求，避免错误配置导致大量重复失败。
      break;
    }

    if (chunks.length < remainingBudget) break;
  }

  console.log(`✅ MemoryChunk embedding ${mode.forceAllInScope ? 're-embed' : 'backfill'} done: updated=${updatedCount}, failed=${failedCount}`);
  return { updatedCount, failedCount };
}

/** 按 scope 查询待补齐或待重算的 MemoryChunk。 */
async function findMemoryChunksForEmbedding(options: ScriptOptions, take: number, forceAllInScope: boolean): Promise<MemoryChunkTarget[]> {
  const extra = forceAllInScope ? [] : [Prisma.sql`embedding IS NULL`];
  const where = buildMemoryScopeWhere(options, extra);
  return prisma.$queryRaw<MemoryChunkTarget[]>(Prisma.sql`
    SELECT id::text, "memoryType", content, summary, metadata
    FROM "MemoryChunk"
    ${where}
    ORDER BY "updatedAt" DESC
    LIMIT ${take}
  `);
}

/** 从专门的 EMBEDDING_* 环境变量解析 embedding 配置。 */
async function resolveEmbeddingConfig(): Promise<EmbeddingConfig> {
  const baseUrl = process.env.EMBEDDING_BASE_URL ?? 'http://localhost:18319/v1';
  const apiKey = process.env.EMBEDDING_API_KEY ?? '';
  const model = process.env.EMBEDDING_MODEL ?? 'local-hash-zh-768';
  return { baseUrl, apiKey, model };
}

/** 调用 OpenAI-Compatible /embeddings；会校验返回数量、维度和数值类型。 */
async function requestEmbeddings(config: EmbeddingConfig, input: string[]): Promise<number[][]> {
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Worker 的 BGE embedding 服务默认不需要鉴权；配置了 EMBEDDING_API_KEY 时才附加 Bearer。
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.model, input }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${response.status} ${detail.slice(0, 500)}`);
  }

  const payload = (await response.json()) as EmbeddingResponsePayload;
  const data = Array.isArray(payload.data) ? payload.data : [];
  // OpenAI 返回通常已按输入排序；若兼容服务提供 index，则显式排序以避免错位写入。
  const ordered = data.every((item) => typeof item.index === 'number') ? [...data].sort((a, b) => Number(a.index) - Number(b.index)) : data;
  const vectors = ordered.map((item) => item.embedding).filter(isNumberVector);
  if (vectors.length !== input.length) throw new Error(`Embedding 返回数量不匹配：期望 ${input.length}，实际 ${vectors.length}`);
  if (vectors.some((vector) => vector.length === 0)) throw new Error('Embedding 返回了空向量');
  return vectors;
}

/** 执行 MemoryChunk 空 embedding 与维度一致性检查；硬失败会阻止静默通过。 */
async function runMemoryEmbeddingChecks(options: ScriptOptions, summary: MaintenanceSummary) {
  const counts = await prisma.$queryRaw<Array<{ total: number; with_embedding: number; missing_embedding: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS total,
           COUNT(embedding)::int AS with_embedding,
           COUNT(*) FILTER (WHERE embedding IS NULL)::int AS missing_embedding
    FROM "MemoryChunk"
    ${buildMemoryScopeWhere(options)}
  `);
  const count = counts[0] ?? { total: 0, with_embedding: 0, missing_embedding: 0 };
  summary.remainingNullEmbeddings = Number(count.missing_embedding);
  console.log(`🔎 MemoryChunk embedding: total=${count.total}, with_embedding=${count.with_embedding}, missing=${count.missing_embedding}`);

  summary.dimStats = await getEmbeddingDimensionStats(options);
  console.log(`🔎 MemoryChunk embedding dims: ${formatDimStats(summary.dimStats)}`);

  if (summary.remainingNullEmbeddings > 0) {
    summary.hardFailures.push(`仍存在 ${summary.remainingNullEmbeddings} 条 MemoryChunk.embedding IS NULL`);
  }
  if (summary.dimStats.length > 1) {
    summary.hardFailures.push(`MemoryChunk embedding 维度不一致：${formatDimStats(summary.dimStats)}；请设置 DB_MAINTENANCE_REEMBED_ALL_ON_DIM_MISMATCH=true 后重跑`);
  }
}

/** 查询当前 scope 下非空 embedding 的维度分布。 */
async function getEmbeddingDimensionStats(options: Pick<ScriptOptions, 'projectId' | 'chapterId'>): Promise<Array<{ dim: number; count: number }>> {
  return prisma.$queryRaw<Array<{ dim: number; count: number }>>(Prisma.sql`
    SELECT jsonb_array_length(embedding::jsonb)::int AS dim, COUNT(*)::int AS count
    FROM "MemoryChunk"
    ${buildMemoryScopeWhere(options, [Prisma.sql`embedding IS NOT NULL`])}
    GROUP BY dim
    ORDER BY count DESC, dim ASC
  `);
}

/** 检查 Agent trace 所需表与关键索引/唯一约束是否存在。 */
async function checkAgentSchema(summary: MaintenanceSummary) {
  const existingTables = new Set<string>();
  for (const table of REQUIRED_AGENT_TABLES) {
    if (await tableExists(table)) {
      existingTables.add(table);
    } else {
      summary.hardFailures.push(`缺少 Agent 表：${table}`);
    }
  }

  const indexChecks = [
    { table: 'AgentStep', indexName: 'AgentStep_agentRunId_mode_planVersion_stepNo_key', name: 'AgentStep(agentRunId, mode, planVersion, stepNo) unique', unique: true, columns: ['agentRunId', 'mode', 'planVersion', 'stepNo'] },
    { table: 'AgentArtifact', indexName: 'AgentArtifact_agentRunId_artifactType_idx', name: 'AgentArtifact(agentRunId, artifactType) index', unique: false, columns: ['agentRunId', 'artifactType'] },
    { table: 'AgentApproval', indexName: 'AgentApproval_agentRunId_status_idx', name: 'AgentApproval(agentRunId, status) index', unique: false, columns: ['agentRunId', 'status'] },
  ];

  for (const check of indexChecks) {
    // 表本身不存在时索引检查没有意义，避免后续质量统计因缺表直接中断。
    if (!existingTables.has(check.table)) continue;
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = ${check.table}
          AND indexname = ${check.indexName}
          AND indexdef ILIKE ${check.unique ? '%UNIQUE%' : '%'}
      ) AS exists
    `);
    if (!rows[0]?.exists) summary.hardFailures.push(`缺少 Agent 索引/约束：${check.name}`);
  }

  console.log('✅ Agent schema check finished');
}

/** 当前 schema 下的大小写敏感表存在性检查；避免 to_regclass/search_path 对带引号表名的歧义。 */
async function tableExists(tableName: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ${tableName}
    ) AS exists
  `);
  return Boolean(rows[0]?.exists);
}

/** 输出旧 fallback/低质量数据的统计，只告警不自动删除，避免误伤人工可复核资料。 */
async function runQualityChecks(options: ScriptOptions) {
  const memorySkippedRows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "MemoryChunk"
    ${buildMemoryScopeWhere(options, [Prisma.sql`metadata::jsonb ? 'embeddingSkippedReason'`])}
  `);

  const fallbackArtifactRows = (await tableExists('AgentArtifact'))
    ? await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM "AgentArtifact"
        WHERE title ILIKE '%fallback%' OR content::text ILIKE '%fallback%' OR content::text ILIKE '%兜底%'
      `
    : null;

  const lowQualityEvents = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "StoryEvent" se
    ${buildProjectChapterWhere('se', options, [Prisma.sql`(trim(description) = '' OR title ILIKE '%摘要生成失败%' OR description ILIKE '%摘要生成失败%')`])}
  `);

  const lowQualityStates = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "CharacterStateSnapshot" cs
    ${buildProjectChapterWhere('cs', options, [Prisma.sql`(trim("stateValue") = '' OR "characterName" ILIKE '%未知%' OR "characterName" ILIKE '%unknown%')`])}
  `);

  const lowQualityForeshadows = await prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
    SELECT COUNT(*)::int AS count
    FROM "ForeshadowTrack" ft
    ${buildProjectChapterWhere('ft', options, [Prisma.sql`(detail IS NULL OR trim(detail) = '' OR title ILIKE '%摘要生成失败%')`])}
  `);

  const searchMethods = await prisma.$queryRaw<Array<{ search_method: string | null; count: number }>>(Prisma.sql`
    SELECT cd."generationContext"::jsonb #>> '{retrievalPayload,diagnostics,searchMethod}' AS search_method,
           COUNT(*)::int AS count
    FROM "ChapterDraft" cd
    INNER JOIN "Chapter" c ON c.id = cd."chapterId"
    ${buildChapterDraftScopeWhere(options)}
    GROUP BY search_method
    ORDER BY count DESC
  `);

  console.log('🔎 quality check warnings:');
  console.log(`   MemoryChunk.metadata.embeddingSkippedReason: ${memorySkippedRows[0]?.count ?? 0}`);
  console.log(`   AgentArtifact fallback-like artifacts: ${fallbackArtifactRows ? fallbackArtifactRows[0]?.count ?? 0 : 'skipped_missing_table'}`);
  console.log(`   low-quality StoryEvent rows: ${lowQualityEvents[0]?.count ?? 0}`);
  console.log(`   low-quality CharacterStateSnapshot rows: ${lowQualityStates[0]?.count ?? 0}`);
  console.log(`   low-quality ForeshadowTrack rows: ${lowQualityForeshadows[0]?.count ?? 0}`);
  console.log(`   ChapterDraft retrieval searchMethod: ${searchMethods.map((row) => `${row.search_method ?? 'null'}=${row.count}`).join(', ') || 'none'}`);
}

/** 构建 MemoryChunk scope WHERE，支持 project/chapter 和附加谓词。 */
function buildMemoryScopeWhere(options: Pick<ScriptOptions, 'projectId' | 'chapterId'>, extra: Prisma.Sql[] = []): Prisma.Sql {
  const clauses = [...extra];
  if (options.projectId) clauses.push(Prisma.sql`"projectId" = ${options.projectId}::uuid`);
  if (options.chapterId) clauses.push(Prisma.sql`"sourceType" = 'chapter' AND "sourceId" = ${options.chapterId}::uuid`);
  return clauses.length > 0 ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}

/** 为带 projectId/chapterId 的事实表构建 scope WHERE。 */
function buildProjectChapterWhere(alias: string, options: Pick<ScriptOptions, 'projectId' | 'chapterId'>, extra: Prisma.Sql[] = []): Prisma.Sql {
  const identifier = Prisma.raw(alias);
  const clauses = [...extra];
  if (options.projectId) clauses.push(Prisma.sql`${identifier}."projectId" = ${options.projectId}::uuid`);
  if (options.chapterId) clauses.push(Prisma.sql`${identifier}."chapterId" = ${options.chapterId}::uuid`);
  return clauses.length > 0 ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}

/** ChapterDraft 需通过 Chapter 表获取 project scope。 */
function buildChapterDraftScopeWhere(options: Pick<ScriptOptions, 'projectId' | 'chapterId'>): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (options.projectId) clauses.push(Prisma.sql`c."projectId" = ${options.projectId}::uuid`);
  if (options.chapterId) clauses.push(Prisma.sql`cd."chapterId" = ${options.chapterId}::uuid`);
  return clauses.length > 0 ? Prisma.sql`WHERE ${Prisma.join(clauses, ' AND ')}` : Prisma.empty;
}

/** 拼接 summary/content，和运行时代码保持接近的 embedding 输入。 */
function buildEmbeddingText(chunk: MemoryChunkTarget): string {
  return `${chunk.summary ?? ''}\n${chunk.content}`.trim().slice(0, 4000);
}

/** 合并 metadata，同时清理历史 embeddingSkippedReason，避免低质量标记残留。 */
function mergeMetadata(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? { ...(existing as Record<string, unknown>) } : {};
  delete base.embeddingSkippedReason;
  return { ...base, ...patch };
}

/** 类型守卫：确认 embedding 是 number[]。 */
function isNumberVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item));
}

/** JSON 环境变量必须是 object，避免把数组/字符串写入 Provider.extraConfig。 */
function parseJsonObject(raw: string | undefined, label: string): Record<string, unknown> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON object`);
  return parsed as Record<string, unknown>;
}

function stringOption(argMap: Map<string, string | boolean>, key: string): string | undefined {
  const value = argMap.get(key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOption(argMap: Map<string, string | boolean>, key: string, fallback = false): boolean {
  const value = argMap.get(key);
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function envBoolean(key: string): boolean {
  return ['1', 'true', 'yes', 'y'].includes((process.env[key] ?? '').toLowerCase());
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function formatDimStats(rows: Array<{ dim: number; count: number }>): string {
  return rows.length > 0 ? rows.map((row) => `${row.dim}=${row.count}`).join(', ') : 'none';
}

/** 打印最终摘要；不包含任何 API Key。 */
function printSummary(summary: MaintenanceSummary) {
  console.log('\n📋 DB maintenance summary');
  console.log(`   vectorExtensionReady: ${summary.vectorExtensionReady}`);
  console.log(`   providersConfigured: ${summary.providersConfigured}`);
  console.log(`   promptTemplateReady: ${summary.promptTemplateReady}`);
  console.log(`   backfilledCount: ${summary.backfilledCount}`);
  console.log(`   backfillFailedCount: ${summary.backfillFailedCount}`);
  console.log(`   remainingNullEmbeddings: ${summary.remainingNullEmbeddings}`);
  console.log(`   dimStats: ${formatDimStats(summary.dimStats)}`);
  if (summary.hardFailures.length > 0) {
    console.error(`   hardFailures:\n   - ${summary.hardFailures.join('\n   - ')}`);
  }
}

main()
  .catch((error) => {
    console.error('❌ DB maintenance failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
