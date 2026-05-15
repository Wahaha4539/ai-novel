import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { ScoringController } from './scoring.controller';
import { ScoringService } from './scoring.service';

const targetType = 'chapter_craft_brief' as const;

function report(profileKey: 'generic_longform' | 'qidian_like', scoreOffset = 0) {
  const weights = assertPlatformProfileCoversTarget(targetType, profileKey);
  return {
    targetType,
    platformProfile: profileKey,
    overallScore: 80 + scoreOffset,
    verdict: 'pass',
    summary: `${profileKey} summary`,
    extractedElements: { mainCharacters: ['protagonist'] },
    dimensions: Object.entries(weights).map(([key, weight], index) => ({
      key,
      label: key,
      score: 70 + scoreOffset + index,
      weight,
      weightedScore: Number((((70 + scoreOffset + index) * weight) / 100).toFixed(4)),
      confidence: 'high',
      evidence: `${key} evidence`,
      reason: `${key} reason`,
      suggestion: `${key} suggestion`,
    })),
    blockingIssues: [],
    revisionPriorities: ['Keep concrete scene pressure'],
  };
}

function loadedTarget() {
  return {
    targetType,
    targetId: 'chapter-1',
    chapterId: 'chapter-1',
    targetRef: { chapterId: 'chapter-1' },
    targetSnapshot: {
      targetType,
      targetId: 'chapter-1',
      targetRef: { chapterId: 'chapter-1' },
      assetSummary: {
        targetType,
        title: 'Chapter 1 craft brief',
        chapterNo: 1,
        source: 'Chapter.craftBrief',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
      content: { craftBrief: { actionBeats: ['enter', 'search', 'escape'] } },
      sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1', chapterNo: 1 },
    },
    sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1', chapterNo: 1 },
  };
}

function createService(llmReports: unknown[]) {
  const calls = { created: [] as unknown[], loadTarget: 0, chat: 0 };
  const prisma = {
    project: { findUnique: async () => ({ id: 'project-1' }) },
    scoringRun: {
      create: async (args: unknown) => {
        calls.created.push(args);
        return { id: `run-${calls.created.length}`, ...(args as { data: Record<string, unknown> }).data };
      },
      findMany: async () => [],
    },
  };
  const targetLoader = {
    loadTarget: async () => {
      calls.loadTarget += 1;
      return loadedTarget();
    },
  };
  const llm = {
    chatJson: async () => {
      const data = llmReports[calls.chat];
      calls.chat += 1;
      return { data, result: { text: '{}', model: 'model', rawPayloadSummary: {} } };
    },
  };
  return { service: new ScoringService(prisma as never, targetLoader as never, llm as never), calls };
}

async function run() {
  {
    const { service, calls } = createService([report('generic_longform'), report('qidian_like', 4)]);
    const runs = await service.createBatchRuns('project-1', {
      targetType,
      targetId: 'chapter-1',
      profileKeys: ['generic_longform', 'qidian_like'],
    });
    assert.equal(runs.length, 2);
    assert.equal(calls.loadTarget, 1);
    assert.equal(calls.created.length, 2);
    assert.deepEqual(calls.created.map((item) => (item as { data: Record<string, unknown> }).data.platformProfile), ['generic_longform', 'qidian_like']);
  }

  {
    const invalid = report('qidian_like') as Record<string, unknown>;
    delete invalid.dimensions;
    const { service, calls } = createService([report('generic_longform'), invalid]);
    await assert.rejects(
      () => service.createBatchRuns('project-1', { targetType, targetId: 'chapter-1', profileKeys: ['generic_longform', 'qidian_like'] }),
      BadRequestException,
    );
    assert.equal(calls.created.length, 0);
  }

  {
    const runs = [
      persistedRun('generic_longform', 78, 0, new Date('2026-05-16T00:00:00.000Z')),
      persistedRun('qidian_like', 86, 8, new Date('2026-05-16T01:00:00.000Z')),
      persistedRun('generic_longform', 70, -5, new Date('2026-05-15T00:00:00.000Z')),
    ];
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: { findMany: async () => runs },
    };
    const service = new ScoringService(prisma as never, {} as never, {} as never);
    const comparison = await service.getPlatformComparison('project-1', { targetType, targetId: 'chapter-1' });
    assert.equal(comparison.profiles.length, 2);
    assert.equal(comparison.profiles.find((item) => item.platformProfile === 'qidian_like')?.overallScore, 86);
    assert.ok(comparison.keyDimensionDifferences.length > 0);
    assert.ok(comparison.keyDimensionDifferences[0].spread > 0);
  }

  {
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        findMany: async ({ where }: { where: Record<string, unknown> }) => [
          trendRun('trend-2', 2, 74, 'chapter_outline'),
          trendRun('trend-1', 1, 82, 'chapter_outline'),
          trendRun('trend-draft', 1, 90, 'chapter_draft', 'draft-1'),
        ].filter((item) => !where.targetType || item.targetType === where.targetType),
      },
    };
    const service = new ScoringService(prisma as never, {} as never, {} as never);
    const trends = await service.getChapterTrends('project-1', { targetType: 'chapter_outline', profileKey: 'generic_longform' });
    assert.deepEqual(trends.points.map((point) => point.chapterNo), [1, 2]);
    assert.equal(trends.points[0].overallScore, 82);
  }

  {
    const scoringService = {
      createBatchRuns: async () => [{ id: 'run-1' }, { id: 'run-2' }],
      getPlatformComparison: async () => ({ profiles: [] }),
      getChapterTrends: async () => ({ points: [] }),
    };
    const controller = new ScoringController(scoringService as never, {} as never);
    assert.equal((await controller.createBatchRun('project-1', { targetType, targetId: 'chapter-1', profileKeys: ['generic_longform'] })).length, 2);
    assert.deepEqual(await controller.getComparison('project-1', { targetType, targetId: 'chapter-1' }), { profiles: [] });
    assert.deepEqual(await controller.getTrends('project-1', { targetType }), { points: [] });
  }
}

function persistedRun(profileKey: 'generic_longform' | 'qidian_like', overallScore: number, scoreOffset: number, createdAt: Date) {
  return {
    id: `run-${profileKey}-${createdAt.getTime()}`,
    projectId: 'project-1',
    chapterId: 'chapter-1',
    draftId: null,
    agentRunId: null,
    targetType,
    targetId: 'chapter-1',
    targetRef: { chapterId: 'chapter-1' },
    platformProfile: profileKey,
    profileVersion: `profile.${profileKey}.v1`,
    promptVersion: 'multidimensional_scoring.prompt.v1',
    rubricVersion: 'multidimensional_scoring.rubric.v1',
    overallScore,
    verdict: 'pass',
    summary: `${profileKey} summary`,
    dimensions: report(profileKey, scoreOffset).dimensions,
    issues: [],
    revisionPriorities: [],
    extractedElements: {},
    targetSnapshot: loadedTarget().targetSnapshot,
    sourceTrace: loadedTarget().sourceTrace,
    llmMetadata: {},
    createdAt,
    updatedAt: createdAt,
  };
}

function trendRun(id: string, chapterNo: number, overallScore: number, target: string, draftId: string | null = null) {
  return {
    id,
    projectId: 'project-1',
    chapterId: `chapter-${chapterNo}`,
    draftId,
    targetType: target,
    targetId: `chapter-${chapterNo}`,
    platformProfile: 'generic_longform',
    overallScore,
    verdict: 'pass',
    createdAt: new Date(`2026-05-16T0${chapterNo}:00:00.000Z`),
    sourceTrace: { chapterNo },
    chapter: { id: `chapter-${chapterNo}`, chapterNo, title: `Chapter ${chapterNo}` },
  };
}

run().then(() => {
  console.log('scoring comparison/trends: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
