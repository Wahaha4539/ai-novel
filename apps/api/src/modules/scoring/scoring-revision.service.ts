import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import {
  PlatformProfileKey,
  ScoringContractError,
  ScoringDimensionScore,
  ScoringIssue,
  ScoringTargetType,
  isPlatformProfileKey,
  isScoringTargetType,
  validateScoringReportPayload,
  validateScoringTargetSnapshot,
} from './scoring-contracts';
import { buildScoringRevisionPrompt } from './scoring-revision-prompt';
import {
  CreateScoringRevisionInput,
  SCORING_REVISION_TARGETS,
  assertScoringRevisionInput,
} from './scoring-revision.types';

@Injectable()
export class ScoringRevisionService {
  constructor(private readonly prisma: PrismaService) {}

  async createRevision(projectId: string, scoringRunId: string, value: unknown) {
    const request = assertScoringRevisionInput(value ?? { scoringRunId }, scoringRunId);
    const run = await this.prisma.scoringRun.findFirst({ where: { id: scoringRunId, projectId } });
    if (!run) throw new NotFoundException(`Scoring run not found in project: ${scoringRunId}`);

    const targetType = this.requireTargetType(run.targetType);
    const profileKey = this.requireProfileKey(run.platformProfile);
    const weights = assertPlatformProfileCoversTarget(targetType, profileKey);
    const targetSnapshot = this.validateTargetSnapshot(run.targetSnapshot, targetType);
    const report = this.validateReport(run, targetType, profileKey, weights);
    const selected = this.selectRevisionScope(request, report.dimensions, report.blockingIssues, report.revisionPriorities);
    const mapping = SCORING_REVISION_TARGETS[targetType];
    const prompt = buildScoringRevisionPrompt({
      scoringRunId: run.id,
      targetType,
      targetSnapshot,
      platformProfileKey: profileKey,
      dimensions: report.dimensions,
      selectedDimensions: selected.dimensions,
      issues: report.blockingIssues,
      selectedIssues: selected.issues,
      revisionPriorities: report.revisionPriorities,
      selectedRevisionPriorities: selected.revisionPriorities,
      request,
      mapping,
      overallScore: run.overallScore,
      verdict: run.verdict,
      summary: run.summary,
    });
    const now = new Date();
    const agentRun = await this.prisma.agentRun.create({
      data: {
        projectId,
        chapterId: run.chapterId ?? undefined,
        agentType: 'CreativeAgent',
        taskType: 'score_driven_revision',
        status: 'planning',
        mode: 'plan',
        goal: prompt.prompt,
        input: {
          projectId,
          message: prompt.prompt,
          scoringRevision: {
            scoringRunId: run.id,
            entryPoint: request.entryPoint,
            targetType,
            agentTarget: mapping.agentTarget,
            selectedIssueIndexes: request.selectedIssueIndexes ?? [],
            selectedDimensions: selected.dimensions.map((dimension) => dimension.key),
            selectedRevisionPriorities: selected.revisionPriorities,
          },
          context: prompt.context,
        } as unknown as Prisma.InputJsonValue,
        heartbeatAt: now,
      },
    });

    const artifact = await this.prisma.agentArtifact.create({
      data: {
        agentRunId: agentRun.id,
        artifactType: 'scoring_revision_prompt',
        title: 'Score-driven revision prompt',
        content: {
          prompt: prompt.prompt,
          context: prompt.context,
          approvalBoundary: approvalBoundary(),
        } as unknown as Prisma.InputJsonValue,
        status: 'preview',
      },
    });

    return {
      scoringRunId: run.id,
      agentRunId: agentRun.id,
      artifactId: artifact.id,
      status: agentRun.status,
      taskType: agentRun.taskType,
      targetType,
      mapping,
      prompt: prompt.prompt,
      platformProfile: prompt.platformProfile,
      selectedDimensions: selected.dimensions,
      selectedIssues: selected.issues,
      revisionPriorities: selected.revisionPriorities,
      approvalBoundary: approvalBoundary(),
    };
  }

  private requireTargetType(value: string): ScoringTargetType {
    if (!isScoringTargetType(value)) {
      throw new BadRequestException(`Unsupported scoring target type on run: ${value}`);
    }
    return value;
  }

  private requireProfileKey(value: string): PlatformProfileKey {
    if (!isPlatformProfileKey(value)) {
      throw new BadRequestException(`Unsupported scoring profile on run: ${value}`);
    }
    return value;
  }

  private validateTargetSnapshot(value: unknown, targetType: ScoringTargetType) {
    try {
      return validateScoringTargetSnapshot(value, targetType);
    } catch (error) {
      if (error instanceof ScoringContractError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private validateReport(
    run: {
      targetType: string;
      platformProfile: string;
      overallScore: number;
      verdict: string;
      summary: string;
      extractedElements: Prisma.JsonValue;
      dimensions: Prisma.JsonValue;
      issues: Prisma.JsonValue;
      revisionPriorities: Prisma.JsonValue;
    },
    targetType: ScoringTargetType,
    profileKey: PlatformProfileKey,
    weights: Record<string, number>,
  ) {
    try {
      return validateScoringReportPayload(
        {
          targetType: run.targetType,
          platformProfile: run.platformProfile,
          overallScore: run.overallScore,
          verdict: run.verdict,
          summary: run.summary,
          extractedElements: run.extractedElements,
          dimensions: run.dimensions,
          blockingIssues: run.issues,
          revisionPriorities: run.revisionPriorities,
        },
        {
          targetType,
          platformProfile: profileKey,
          expectedDimensionWeights: weights,
        },
      );
    } catch (error) {
      if (error instanceof ScoringContractError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private selectRevisionScope(
    request: CreateScoringRevisionInput,
    dimensions: ScoringDimensionScore[],
    issues: ScoringIssue[],
    revisionPriorities: string[],
  ) {
    const entryPoint = request.entryPoint ?? 'report';
    if (entryPoint === 'dimension' && !request.selectedDimensions?.length) {
      throw new BadRequestException('dimension revision requires selectedDimensions.');
    }
    if (entryPoint === 'issue' && !request.selectedIssueIndexes?.length) {
      throw new BadRequestException('issue revision requires selectedIssueIndexes.');
    }
    if (entryPoint === 'priority' && !request.selectedRevisionPriorities?.length) {
      throw new BadRequestException('priority revision requires selectedRevisionPriorities.');
    }

    const dimensionByKey = new Map(dimensions.map((dimension) => [dimension.key, dimension]));
    const selectedDimensions = request.selectedDimensions?.length
      ? request.selectedDimensions.map((key) => {
          const dimension = dimensionByKey.get(key);
          if (!dimension) throw new BadRequestException(`selectedDimensions references an unknown dimension: ${key}`);
          return dimension;
        })
      : dimensions;

    const selectedIssues = request.selectedIssueIndexes?.length
      ? request.selectedIssueIndexes.map((index) => {
          const issue = issues[index];
          if (!issue) throw new BadRequestException(`selectedIssueIndexes references an unknown issue index: ${index}`);
          return issue;
        })
      : issues;

    const prioritySet = new Set(revisionPriorities);
    const selectedRevisionPriorities = request.selectedRevisionPriorities?.length
      ? request.selectedRevisionPriorities.map((priority) => {
          if (!prioritySet.has(priority)) {
            throw new BadRequestException(`selectedRevisionPriorities references an unknown priority: ${priority}`);
          }
          return priority;
        })
      : revisionPriorities;

    return {
      dimensions: selectedDimensions,
      issues: selectedIssues,
      revisionPriorities: selectedRevisionPriorities,
    };
  }
}

function approvalBoundary() {
  return {
    createsAgentTaskOnly: true,
    directlyPersistsAssets: false,
    requiresAgentPreviewValidationApprovalPersistFlow: true,
  };
}
