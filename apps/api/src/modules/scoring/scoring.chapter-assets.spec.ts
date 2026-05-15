import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { ScoringService } from './scoring.service';
import { ScoringTargetLoaderService } from './scoring-target-loader.service';

const outlineWeights = assertPlatformProfileCoversTarget('chapter_outline', 'generic_longform');
const draftWeights = assertPlatformProfileCoversTarget('chapter_draft', 'generic_longform');

function completeCraftBrief() {
  return {
    visibleGoal: '找到黑市账册',
    hiddenEmotion: '担心同伴背叛',
    coreConflict: '守门人阻止主角进入黑市',
    mainlineTask: '确认失踪线索',
    subplotTasks: ['测试同伴立场'],
    storyUnit: {
      unitId: 'v1_unit_01',
      title: '黑市追线',
      chapterRange: { start: 1, end: 3 },
      chapterRole: '开局追索',
      localGoal: '拿到账册线索',
      localConflict: '黑市守门人设局',
      serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
      mainlineContribution: '确认账册存在',
      characterContribution: '主角更谨慎',
      relationshipContribution: '同伴信任出现裂缝',
      worldOrThemeContribution: '展示黑市规则',
      unitPayoff: '账册线索浮出',
      stateChangeAfterUnit: '主角被迫深入黑市',
    },
    actionBeats: ['抵达黑市入口', '与守门人交锋', '用旧令牌换取线索'],
    sceneBeats: [1, 2, 3].map((index) => ({
      sceneArcId: `s${index}`,
      scenePart: `part${index}`,
      location: `location${index}`,
      participants: ['主角'],
      localGoal: '推进调查',
      visibleAction: '追查线索',
      obstacle: '黑市阻挠',
      turningPoint: '发现账册页角',
      partResult: '获得下一步方向',
      sensoryAnchor: '雨水和药味',
    })),
    characterExecution: {
      povCharacter: '主角',
      cast: [{ characterName: '主角', source: 'existing', functionInChapter: '追查', visibleGoal: '找账册', pressure: '被跟踪', actionBeatRefs: [1], sceneBeatRefs: ['s1'], entryState: '焦虑', exitState: '警惕' }],
      relationshipBeats: [],
      newMinorCharacters: [],
    },
    concreteClues: [{ name: '账册页角', sensoryDetail: '潮湿发硬', laterUse: '指向账房' }],
    dialogueSubtext: '同伴隐瞒自己认识暗号',
    characterShift: '主角开始怀疑同伴',
    irreversibleConsequence: '黑市势力认出主角',
    progressTypes: ['info', 'relationship'],
    entryState: '主角缺少线索',
    exitState: '主角拿到页角但暴露行踪',
    openLoops: ['账册主体在哪里'],
    closedLoops: ['失踪者进入过黑市'],
    handoffToNextChapter: '跟踪朱砂手印找到帐房',
    continuityState: {
      nextImmediatePressure: '黑市打手追踪主角',
      characterPositions: ['主角在后巷'],
      activeThreats: ['守门人已记住主角'],
      ownedClues: ['账册页角'],
      relationshipChanges: ['主角怀疑同伴'],
    },
  };
}

function chapter(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chapter-1',
    projectId: 'project-1',
    volumeId: 'volume-1',
    chapterNo: 1,
    title: '黑市追线',
    objective: '找到失踪者线索',
    conflict: '黑市守门人阻挠',
    revealPoints: '账册被拆散',
    foreshadowPlan: '朱砂手印',
    outline: '主角进入黑市，发现账册页角，并被守门人盯上。',
    craftBrief: completeCraftBrief(),
    status: 'planned',
    updatedAt: new Date('2026-05-16T00:00:00.000Z'),
    volume: { id: 'volume-1', volumeNo: 1, title: '第一卷', synopsis: '卷简介', objective: '卷目标', narrativePlan: {}, chapterCount: 20 },
    project: { id: 'project-1', title: '项目', genre: '玄幻', theme: null, tone: null, logline: 'logline', synopsis: 'synopsis', outline: 'outline', creativeProfile: null },
    ...overrides,
  };
}

function reportFor(targetType: 'chapter_outline' | 'chapter_draft') {
  const weights = targetType === 'chapter_outline' ? outlineWeights : draftWeights;
  return {
    targetType,
    platformProfile: 'generic_longform',
    overallScore: 81,
    verdict: 'pass',
    summary: '结构可用。',
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
    revisionPriorities: ['保留明确目标'],
  };
}

function createPrismaForLoader(chapterRecord = chapter()) {
  return {
    chapter: {
      findFirst: async () => chapterRecord,
      findMany: async () => [],
    },
    chapterDraft: {
      findFirst: async () => ({
        id: 'draft-1',
        chapterId: 'chapter-1',
        versionNo: 3,
        content: '主角穿过雨巷，黑市铁门后传来药味。',
        source: 'generation',
        modelInfo: {},
        generationContext: {},
        isCurrent: true,
        createdAt: new Date('2026-05-16T00:00:00.000Z'),
        chapter: chapterRecord,
      }),
    },
  };
}

async function run() {
  {
    const loader = new ScoringTargetLoaderService(createPrismaForLoader() as never);
    const loaded = await loader.loadTarget('project-1', { targetType: 'chapter_outline', targetId: 'chapter-1' });
    assert.equal(loaded.targetType, 'chapter_outline');
    assert.equal(loaded.targetSnapshot.assetSummary.chapterNo, 1);
  }

  {
    const loader = new ScoringTargetLoaderService(createPrismaForLoader(chapter({ objective: '' })) as never);
    await assert.rejects(() => loader.loadTarget('project-1', { targetType: 'chapter_outline', targetId: 'chapter-1' }), BadRequestException);
  }

  {
    const loader = new ScoringTargetLoaderService({
      chapterDraft: { findFirst: async () => null },
    } as never);
    await assert.rejects(
      () => loader.loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'missing', draftVersion: 1 }),
      NotFoundException,
    );
  }

  {
    const loader = new ScoringTargetLoaderService({
      chapter: { findMany: async () => [] },
      chapterDraft: {
        findFirst: async () => ({
          id: 'draft-1',
          chapterId: 'chapter-1',
          versionNo: 2,
          content: '正文',
          source: 'generation',
          modelInfo: {},
          generationContext: {},
          isCurrent: true,
          createdAt: new Date('2026-05-16T00:00:00.000Z'),
          chapter: chapter(),
        }),
      },
    } as never);
    await assert.rejects(
      () => loader.loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3 }),
      BadRequestException,
    );
  }

  {
    const loader = new ScoringTargetLoaderService(createPrismaForLoader(chapter({ outline: '' })) as never);
    await assert.rejects(
      () => loader.loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3 }),
      BadRequestException,
    );
  }

  {
    const loader = new ScoringTargetLoaderService(createPrismaForLoader(chapter({ craftBrief: {} })) as never);
    await assert.rejects(
      () => loader.loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3 }),
      BadRequestException,
    );
  }

  {
    const created: unknown[] = [];
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        create: async (args: unknown) => {
          created.push(args);
          return { id: 'run-outline', ...(args as { data: Record<string, unknown> }).data };
        },
      },
    };
    const targetLoader = { loadTarget: async () => new ScoringTargetLoaderService(createPrismaForLoader() as never).loadTarget('project-1', { targetType: 'chapter_outline', targetId: 'chapter-1' }) };
    const llm = {
      chatJson: async () => ({ data: reportFor('chapter_outline'), result: { text: '{}', model: 'model', rawPayloadSummary: {} } }),
    };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    const result = await service.createRun('project-1', { targetType: 'chapter_outline', targetId: 'chapter-1', profileKey: 'generic_longform' });
    assert.equal(result.targetType, 'chapter_outline');
    assert.equal(created.length, 1);
  }

  {
    const created: unknown[] = [];
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: {
        create: async (args: unknown) => {
          created.push(args);
          return { id: 'run-draft', ...(args as { data: Record<string, unknown> }).data };
        },
      },
    };
    const targetLoader = { loadTarget: async () => new ScoringTargetLoaderService(createPrismaForLoader() as never).loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3 }) };
    const llm = {
      chatJson: async () => ({ data: reportFor('chapter_draft'), result: { text: '{}', model: 'model', rawPayloadSummary: {} } }),
    };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    const result = await service.createRun('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3, profileKey: 'generic_longform' });
    assert.equal(result.targetType, 'chapter_draft');
    assert.equal(result.draftId, 'draft-1');
  }

  {
    const incomplete = reportFor('chapter_draft') as Record<string, unknown>;
    delete incomplete.extractedElements;
    const prisma = {
      project: { findUnique: async () => ({ id: 'project-1' }) },
      scoringRun: { create: async () => ({}) },
    };
    const targetLoader = { loadTarget: async () => new ScoringTargetLoaderService(createPrismaForLoader() as never).loadTarget('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3 }) };
    const llm = {
      chatJson: async () => ({ data: incomplete, result: { text: '{}', model: 'model', rawPayloadSummary: {} } }),
    };
    const service = new ScoringService(prisma as never, targetLoader as never, llm as never);
    await assert.rejects(
      () => service.createRun('project-1', { targetType: 'chapter_draft', targetId: 'chapter-1', draftId: 'draft-1', draftVersion: 3, profileKey: 'generic_longform' }),
      BadRequestException,
    );
  }
}

run().then(() => {
  console.log('scoring chapter outline/draft: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
