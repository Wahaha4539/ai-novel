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
        jsonSchema: buildScoringJsonSchema(),
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

    return this.prisma.scoringRun.create({
      data: {
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
      },
    });
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

export type LoadedScoringTargetForTests = LoadedScoringTarget;
