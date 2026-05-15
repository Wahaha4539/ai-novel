import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { ScoringService } from './scoring.service';
import { ScoringTargetLoaderService } from './scoring-target-loader.service';

const projectWeights = assertPlatformProfileCoversTarget('project_outline', 'generic_longform');
const volumeWeights = assertPlatformProfileCoversTarget('volume_outline', 'generic_longform');

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'project-1',
    title: '长夜账册',
    genre: '玄幻',
    theme: '信任与代价',
    tone: '悬疑',
    logline: '主角追查失踪账册，卷入黑市和宗门权力斗争。',
    synopsis: '项目简介',
    outline: '总大纲：主角从黑市线索追到宗门内斗，逐步揭开账册背后的献祭规则。',
    updatedAt: new Date('2026-05-16T00:00:00.000Z'),
    creativeProfile: null,
    ...overrides,
  };
}

function volume(overrides: Record<string, unknown> = {}) {
  return {
    id: 'volume-1',
    projectId: 'project-1',
    volumeNo: 1,
    title: '黑市账册',
    synopsis: '主角进入黑市，发现账册被拆散。',
    objective: '确认失踪者与账册的关系。',
    narrativePlan: { volumeGoal: '找到账册线索', climax: '黑市暴露主角身份' },
    chapterCount: 20,
    status: 'planned',
    updatedAt: new Date('2026-05-16T00:00:00.000Z'),
    project: project(),
    chapters: [
      { id: 'chapter-1', chapterNo: 1, title: '黑市入口', objective: '进入黑市', conflict: '守门人阻挠', outline: '进入黑市', status: 'planned' },
    ],
    ...overrides,
  };
}

function reportFor(targetType: 'project_outline' | 'volume_outline') {
  const weights = targetType === 'project_outline' ? projectWeights : volumeWeights;
  return {
    targetType,
    platformProfile: 'generic_longform',
    overallScore: 83,
    verdict: 'pass',
    summary: '规划资产结构可用。',
    extractedElements: { mainCharacters: ['主角'], coreEvents: ['追查账册'], keyScenes: ['黑市'] },
    dimensions: Object.entries(weights).map(([key, weight]) => ({
      key,
      label: key,
      score: 80,
      weight,
      weightedScore: Number(((80 * weight) / 100).toFixed(4)),
      confidence: 'medium',
      evidence: `${key} evidence`,
      reason: `${key} reason`,
      suggestion: `${key} suggestion`,
    })),
    blockingIssues: [],
    revisionPriorities: ['保留核心冲突'],
  };
}

function createProjectLoader(projectRecord = project()) {
  return new ScoringTargetLoaderService({
    project: { findUnique: async () => projectRecord },
    lorebookEntry: { findMany: async () => [{ id: 'lore-1', title: '黑市规则', entryType: 'world_rule', summary: '黑市只认令牌', content: '黑市只认令牌，交易留账。', priority: 80, tags: [] }] },
    volume: { findMany: async () => [volume()] },
  } as never);
}

function createVolumeLoader(volumeRecord = volume()) {
  return new ScoringTargetLoaderService({
    volume: {
      findFirst: async () => volumeRecord,
      findMany: async () => [],
    },
  } as never);
}

async function run() {
  {
    const loader = createProjectLoader();
    const loaded = await loader.loadTarget('project-1', { targetType: 'project_outline', targetId: 'project-1' });
    assert.equal(loaded.targetType, 'project_outline');
    assert.equal(loaded.targetSnapshot.assetSummary.title, '长夜账册');
  }

  {
    const loader = createProjectLoader();
    await assert.rejects(() => loader.loadTarget('project-1', { targetType: 'project_outline', targetId: 'project-2' }), BadRequestException);
  }

  {
    const loader = createProjectLoader(project({ outline: '' }));
    await assert.rejects(() => loader.loadTarget('project-1', { targetType: 'project_outline', targetId: 'project-1' }), BadRequestException);
  }

  {
    const loader = createVolumeLoader();
    const loaded = await loader.loadTarget('project-1', { targetType: 'volume_outline', targetRef: { volumeNo: 1 } });
    assert.equal(loaded.targetType, 'volume_outline');
    assert.equal(loaded.targetSnapshot.assetSummary.volumeNo, 1);
  }

  {
    const loader = new ScoringTargetLoaderService({
      volume: { findFirst: async () => null },
    } as never);
    await assert.rejects(() => loader.loadTarget('project-1', { targetType: 'volume_outline', targetId: 'missing-volume' }), NotFoundException);
  }

  {
    const loader = createVolumeLoader(volume({ chapterCount: null }));
    await assert.rejects(() => loader.loadTarget('project-1', { targetType: 'volume_outline', targetId: 'volume-1' }), BadRequestException);
  }

  {
    const created: unknown[] = [];
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        create: async (args: unknown) => {
          created.push(args);
          return { id: 'run-project', ...(args as { data: Record<string, unknown> }).data };
        },
      },
    };
    const targetLoader = { loadTarget: async () => createProjectLoader().loadTarget('project-1', { targetType: 'project_outline', targetId: 'project-1' }) };
    const llm = { chatJson: async () => ({ data: reportFor('project_outline'), result: { text: '{}', model: 'model', rawPayloadSummary: {} } }) };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    const result = await service.createRun('project-1', { targetType: 'project_outline', targetId: 'project-1', profileKey: 'generic_longform' });
    assert.equal(result.targetType, 'project_outline');
    assert.equal(created.length, 1);
  }

  {
    const created: unknown[] = [];
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        create: async (args: unknown) => {
          created.push(args);
          return { id: 'run-volume', ...(args as { data: Record<string, unknown> }).data };
        },
      },
    };
    const targetLoader = { loadTarget: async () => createVolumeLoader().loadTarget('project-1', { targetType: 'volume_outline', targetId: 'volume-1' }) };
    const llm = { chatJson: async () => ({ data: reportFor('volume_outline'), result: { text: '{}', model: 'model', rawPayloadSummary: {} } }) };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    const result = await service.createRun('project-1', { targetType: 'volume_outline', targetId: 'volume-1', profileKey: 'generic_longform' });
    assert.equal(result.targetType, 'volume_outline');
    assert.equal(result.targetId, 'volume-1');
  }

  {
    const incomplete = reportFor('volume_outline') as Record<string, unknown>;
    delete incomplete.dimensions;
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: { create: async () => ({}) },
    };
    const targetLoader = { loadTarget: async () => createVolumeLoader().loadTarget('project-1', { targetType: 'volume_outline', targetId: 'volume-1' }) };
    const llm = { chatJson: async () => ({ data: incomplete, result: { text: '{}', model: 'model', rawPayloadSummary: {} } }) };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    await assert.rejects(
      () => service.createRun('project-1', { targetType: 'volume_outline', targetId: 'volume-1', profileKey: 'generic_longform' }),
      BadRequestException,
    );
  }
}

run().then(() => {
  console.log('scoring project/volume outlines: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
