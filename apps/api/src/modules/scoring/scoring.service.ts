import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { buildScoringJsonSchema, buildScoringPromptMessages } from './scoring-prompts';
import {
  PlatformProfileKey,
  ScoringContractError,
  ScoringDimensionScore,
  ScoringTargetType,
  isPlatformProfileKey,
  validateScoringReportPayload,
} from './scoring-contracts';
import { assertScoringTargetSelector, ScoringTargetSelector } from './scoring-targets';
import { LoadedScoringTarget, ScoringTargetLoaderService } from './scoring-target-loader.service';
import { ListScoringRunsQueryDto } from './dto/list-scoring-runs-query.dto';

export interface CreateScoringRunInput {
  targetType: ScoringTargetType;
  targetId?: string;
  targetRef?: Record<string, unknown>;
  draftId?: string;
  draftVersion?: number;
  profileKey: PlatformProfileKey;
}

export interface CreateScoringBatchRunInput {
  targetType: ScoringTargetType;
  targetId?: string;
  targetRef?: Record<string, unknown>;
  draftId?: string;
  draftVersion?: number;
  profileKeys: PlatformProfileKey[];
}

export interface ScoringComparisonQuery {
  targetType: ScoringTargetType;
  targetId?: string;
  draftId?: string;
  baselineProfileKey?: PlatformProfileKey;
}

export interface ScoringTrendQuery {
  targetType?: ScoringTargetType;
  profileKey?: PlatformProfileKey;
}

export interface ScoringRuntimeOptions {
  agentRunId?: string;
}

@Injectable()
export class ScoringService {
  private readonly llmTimeoutMs = DEFAULT_LLM_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetLoader: ScoringTargetLoaderService,
    private readonly llm: LlmGatewayService,
  ) {}

  async createRun(projectId: string, input: CreateScoringRunInput, runtime: ScoringRuntimeOptions = {}) {
    await this.assertProjectExists(projectId);
    const selector = assertScoringTargetSelector(input) as ScoringTargetSelector;
    if (!isPlatformProfileKey(input.profileKey)) {
      throw new BadRequestException(`Unsupported scoring profile: ${input.profileKey}`);
    }
    const profileKey = input.profileKey;
    const loadedTarget = await this.targetLoader.loadTarget(projectId, selector);
    const data = await this.buildCreateData(projectId, selector, loadedTarget, profileKey, runtime);
    return this.prisma.scoringRun.create({ data });
  }

  async createBatchRuns(projectId: string, input: CreateScoringBatchRunInput) {
    await this.assertProjectExists(projectId);
    const selector = assertScoringTargetSelector({ ...input, profileKey: input.profileKeys?.[0] ?? 'generic_longform' }) as ScoringTargetSelector;
    const profileKeys = this.normalizeBatchProfileKeys(input.profileKeys);
    const loadedTarget = await this.targetLoader.loadTarget(projectId, selector);
    const data = [];
    for (const profileKey of profileKeys) {
      data.push(await this.buildCreateData(projectId, selector, loadedTarget, profileKey));
    }
    const creates = data.map((item) => this.prisma.scoringRun.create({ data: item }));
    const transaction = (this.prisma as unknown as { $transaction?: <T>(items: Promise<T>[]) => Promise<T[]> }).$transaction;
    return transaction ? transaction.call(this.prisma, creates) : Promise.all(creates);
  }

  async listRuns(projectId: string, query: ListScoringRunsQueryDto = {}) {
    await this.assertProjectExists(projectId);
    return this.prisma.scoringRun.findMany({
      where: {
        projectId,
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(query.targetId ? { targetId: query.targetId } : {}),
        ...(query.profileKey ? { platformProfile: query.profileKey } : {}),
        ...(query.chapterId ? { chapterId: query.chapterId } : {}),
        ...(query.draftId ? { draftId: query.draftId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listAssets(projectId: string) {
    await this.assertProjectExists(projectId);
    const [assets, latestRuns] = await Promise.all([
      this.targetLoader.listAssets(projectId),
      this.prisma.scoringRun.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          id: true,
          targetType: true,
          targetId: true,
          draftId: true,
          platformProfile: true,
          overallScore: true,
          verdict: true,
          createdAt: true,
        },
      }),
    ]);

    const latestRunByAsset = new Map<string, typeof latestRuns[number]>();
    for (const run of latestRuns) {
      const key = scoringAssetKey(run.targetType, run.targetId, run.draftId);
      if (!latestRunByAsset.has(key)) latestRunByAsset.set(key, run);
    }

    return assets.map((asset) => {
      const run = latestRunByAsset.get(scoringAssetKey(asset.targetType, asset.targetId ?? null, asset.draftId ?? null));
      return {
        ...asset,
        hasScoringReports: Boolean(run),
        latestRun: run
          ? {
              id: run.id,
              platformProfile: run.platformProfile,
              overallScore: run.overallScore,
              verdict: run.verdict,
              createdAt: run.createdAt.toISOString(),
            }
          : null,
      };
    });
  }

  async getRun(projectId: string, runId: string) {
    await this.assertProjectExists(projectId);
    const run = await this.prisma.scoringRun.findFirst({ where: { id: runId, projectId } });
    if (!run) throw new NotFoundException(`Scoring run not found: ${runId}`);
    return run;
  }

  async getPlatformComparison(projectId: string, query: ScoringComparisonQuery) {
    await this.assertProjectExists(projectId);
    if (!query.targetType) throw new BadRequestException('targetType is required for scoring comparison.');
    if (!query.targetId && !query.draftId) throw new BadRequestException('targetId or draftId is required for scoring comparison.');

    const runs = await this.prisma.scoringRun.findMany({
      where: {
        projectId,
        targetType: query.targetType,
        ...(query.targetId ? { targetId: query.targetId } : {}),
        ...(query.draftId ? { draftId: query.draftId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const latestByProfile = new Map<string, typeof runs[number]>();
    for (const run of runs) {
      if (!latestByProfile.has(run.platformProfile)) latestByProfile.set(run.platformProfile, run);
    }
    const profiles = [...latestByProfile.values()].sort((left, right) => left.platformProfile.localeCompare(right.platformProfile));
    const baseline = latestByProfile.get(query.baselineProfileKey ?? 'generic_longform') ?? profiles[0] ?? null;
    return {
      targetType: query.targetType,
      targetId: query.targetId ?? null,
      draftId: query.draftId ?? null,
      baselineProfileKey: baseline?.platformProfile ?? null,
      profiles: profiles.map((run) => summarizeComparisonRun(run)),
      keyDimensionDifferences: buildDimensionDifferences(profiles),
    };
  }

  async getChapterTrends(projectId: string, query: ScoringTrendQuery = {}) {
    await this.assertProjectExists(projectId);
    const runs = await this.prisma.scoringRun.findMany({
      where: {
        projectId,
        chapterId: { not: null },
        ...(query.targetType ? { targetType: query.targetType } : {}),
        ...(query.profileKey ? { platformProfile: query.profileKey } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        chapter: { select: { id: true, chapterNo: true, title: true } },
      },
    });
    const latest = new Map<string, typeof runs[number]>();
    for (const run of runs) {
      const chapterNo = run.chapter?.chapterNo ?? numberFromRecord(run.sourceTrace, 'chapterNo');
      if (!chapterNo) continue;
      const key = `${run.chapterId}:${run.targetType}:${run.platformProfile}:${run.draftId ?? ''}`;
      if (!latest.has(key)) latest.set(key, run);
    }
    const points = [...latest.values()]
      .map((run) => ({
        scoringRunId: run.id,
        chapterId: run.chapterId,
        chapterNo: run.chapter?.chapterNo ?? numberFromRecord(run.sourceTrace, 'chapterNo'),
        chapterTitle: run.chapter?.title ?? null,
        targetType: run.targetType,
        draftId: run.draftId ?? null,
        platformProfile: run.platformProfile,
        overallScore: run.overallScore,
        verdict: run.verdict,
        createdAt: run.createdAt.toISOString(),
      }))
      .sort((left, right) => {
        const chapterDelta = (left.chapterNo ?? 0) - (right.chapterNo ?? 0);
        return chapterDelta || left.platformProfile.localeCompare(right.platformProfile) || left.targetType.localeCompare(right.targetType);
      });
    return { points };
  }

  private async buildCreateData(
    projectId: string,
    selector: ScoringTargetSelector,
    loadedTarget: LoadedScoringTarget,
    profileKey: PlatformProfileKey,
    runtime: ScoringRuntimeOptions = {},
  ) {
    const weights = assertPlatformProfileCoversTarget(selector.targetType, profileKey);
    const prompt = buildScoringPromptMessages({
      targetType: selector.targetType,
      platformProfile: profileKey,
      targetSnapshot: loadedTarget.targetSnapshot,
    });

    const { data, result } = await this.llm.chatJson<unknown>(
      [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      {
        appStep: 'scoring',
        temperature: 0.1,
        maxTokens: 2400,
        timeoutMs: this.llmTimeoutMs,
        retries: 0,
        jsonSchema: buildScoringJsonSchema({ targetType: selector.targetType, platformProfile: profileKey }),
      },
    );

    let report;
    try {
      report = validateScoringReportPayload(data, {
        targetType: selector.targetType,
        platformProfile: profileKey,
        expectedDimensionWeights: weights,
      });
    } catch (error) {
      if (error instanceof ScoringContractError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    return {
      projectId,
      chapterId: loadedTarget.chapterId ?? null,
      draftId: loadedTarget.draftId ?? null,
      agentRunId: runtime.agentRunId ?? null,
      targetType: loadedTarget.targetType,
      targetId: loadedTarget.targetId ?? null,
      targetRef: toJson(loadedTarget.targetRef ?? {}),
      platformProfile: profileKey,
      profileVersion: prompt.profileVersion,
      promptVersion: prompt.promptVersion,
      rubricVersion: prompt.rubricVersion,
      overallScore: report.overallScore,
      verdict: report.verdict,
      summary: report.summary,
      dimensions: toJson(report.dimensions),
      issues: toJson(report.blockingIssues),
      revisionPriorities: toJson(report.revisionPriorities),
      extractedElements: toJson(report.extractedElements),
      targetSnapshot: toJson(loadedTarget.targetSnapshot),
      sourceTrace: toJson({
        ...loadedTarget.sourceTrace,
        agentRunId: runtime.agentRunId ?? null,
      }),
      llmMetadata: toJson({
        model: result.model,
        usage: result.usage ?? null,
        elapsedMs: result.elapsedMs ?? null,
        rawPayloadSummary: result.rawPayloadSummary ?? null,
      }),
    };
  }

  private normalizeBatchProfileKeys(value: PlatformProfileKey[] | undefined): PlatformProfileKey[] {
    if (!Array.isArray(value) || !value.length) throw new BadRequestException('profileKeys must include at least one scoring profile.');
    return [...new Set(value.map((item, index) => {
      if (!isPlatformProfileKey(item)) throw new BadRequestException(`Unsupported scoring profile at profileKeys[${index}]: ${item}`);
      return item;
    }))];
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException(`Project not found: ${projectId}`);
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function scoringAssetKey(targetType: string, targetId?: string | null, draftId?: string | null) {
  return `${targetType}:${targetId ?? ''}:${draftId ?? ''}`;
}

function summarizeComparisonRun(run: {
  id: string;
  platformProfile: string;
  profileVersion: string;
  overallScore: number;
  verdict: string;
  summary: string;
  dimensions: Prisma.JsonValue;
  createdAt: Date;
}) {
  return {
    id: run.id,
    platformProfile: run.platformProfile,
    profileVersion: run.profileVersion,
    overallScore: run.overallScore,
    verdict: run.verdict,
    summary: run.summary,
    createdAt: run.createdAt.toISOString(),
    dimensions: readDimensions(run.dimensions),
  };
}

function buildDimensionDifferences(runs: Array<{ platformProfile: string; dimensions: Prisma.JsonValue }>) {
  const byDimension = new Map<string, Array<{ platformProfile: string; score: number; label: string }>>();
  for (const run of runs) {
    for (const dimension of readDimensions(run.dimensions)) {
      const items = byDimension.get(dimension.key) ?? [];
      items.push({ platformProfile: run.platformProfile, score: dimension.score, label: dimension.label || dimension.key });
      byDimension.set(dimension.key, items);
    }
  }
  return [...byDimension.entries()]
    .map(([dimensionKey, items]) => {
      const sorted = [...items].sort((left, right) => right.score - left.score);
      return {
        dimensionKey,
        label: sorted[0]?.label ?? dimensionKey,
        spread: sorted.length >= 2 ? Number((sorted[0].score - sorted[sorted.length - 1].score).toFixed(2)) : 0,
        highest: sorted[0] ?? null,
        lowest: sorted[sorted.length - 1] ?? null,
      };
    })
    .filter((item) => item.spread > 0)
    .sort((left, right) => right.spread - left.spread)
    .slice(0, 8);
}

function readDimensions(value: Prisma.JsonValue): ScoringDimensionScore[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record.key !== 'string' || typeof record.score !== 'number') return [];
    return [{
      key: record.key,
      label: typeof record.label === 'string' ? record.label : record.key,
      score: record.score,
      weight: typeof record.weight === 'number' ? record.weight : 0,
      weightedScore: typeof record.weightedScore === 'number' ? record.weightedScore : 0,
      confidence: record.confidence === 'low' || record.confidence === 'medium' || record.confidence === 'high' ? record.confidence : 'low',
      evidence: typeof record.evidence === 'string' ? record.evidence : '',
      reason: typeof record.reason === 'string' ? record.reason : '',
      suggestion: typeof record.suggestion === 'string' ? record.suggestion : '',
    }];
  });
}

function numberFromRecord(value: Prisma.JsonValue, key: string): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const numberValue = (value as Record<string, unknown>)[key];
  return typeof numberValue === 'number' && Number.isFinite(numberValue) ? numberValue : null;
}

export type LoadedScoringTargetForTests = LoadedScoringTarget;
