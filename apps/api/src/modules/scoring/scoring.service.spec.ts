import assert from 'node:assert/strict';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LlmTimeoutError } from '../llm/llm-gateway.service';
import { assertPlatformProfileCoversTarget } from './platform-scoring-profiles';
import { ScoringController } from './scoring.controller';
import { ScoringService } from './scoring.service';
import { ScoringTargetLoaderService } from './scoring-target-loader.service';
import { ScoreChapterCraftBriefTool } from '../agent-tools/tools/score-chapter-craft-brief.tool';

const targetType = 'chapter_craft_brief' as const;
const profileKey = 'generic_longform' as const;
const weights = assertPlatformProfileCoversTarget(targetType, profileKey);

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
      characterContribution: '主角变得更谨慎',
      relationshipContribution: '同伴信任出现裂缝',
      worldOrThemeContribution: '展示黑市规则',
      unitPayoff: '账册线索浮出',
      stateChangeAfterUnit: '主角被迫深入黑市',
    },
    actionBeats: ['抵达黑市入口', '与守门人交锋', '用旧令牌换取线索'],
    sceneBeats: [
      {
        sceneArcId: 's1',
        scenePart: 'entry',
        location: '雨巷入口',
        participants: ['主角', '守门人'],
        localGoal: '进入黑市',
        visibleAction: '递出旧令牌',
        obstacle: '守门人索要暗号',
        turningPoint: '同伴说出半句暗号',
        partResult: '守门人放行但记下脸',
        sensoryAnchor: '雨水拍在铁门上',
      },
      {
        sceneArcId: 's2',
        scenePart: 'pressure',
        location: '药摊',
        participants: ['主角', '药摊老板'],
        localGoal: '找账册线索',
        visibleAction: '翻检药包',
        obstacle: '老板拒绝承认交易',
        turningPoint: '药包夹层露出账册页角',
        partResult: '主角发现账册被拆散',
        sensoryAnchor: '苦药味压住血腥味',
      },
      {
        sceneArcId: 's3',
        scenePart: 'handoff',
        location: '后巷',
        participants: ['主角', '同伴'],
        localGoal: '脱身',
        visibleAction: '带着页角撤离',
        obstacle: '守门人派人跟踪',
        turningPoint: '同伴故意留下假方向',
        partResult: '主角得到下一章追踪目标',
        sensoryAnchor: '湿墙上留下朱砂手印',
      },
    ],
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

function validReport() {
  return {
    targetType,
    platformProfile: profileKey,
    overallScore: 82,
    verdict: 'pass',
    summary: '执行卡具备可写场景链。',
    extractedElements: { mainCharacters: ['主角'], coreEvents: ['追查账册'], keyScenes: ['黑市'] },
    dimensions: Object.entries(weights).map(([key, weight]) => ({
      key,
      label: key,
      score: 80,
      weight,
      weightedScore: Number(((80 * weight) / 100).toFixed(4)),
      confidence: 'high',
      evidence: `${key} evidence`,
      reason: `${key} reason`,
      suggestion: `${key} suggestion`,
    })),
    blockingIssues: [],
    revisionPriorities: ['保持场景链清晰'],
  };
}

function loadedTarget() {
  return {
    targetType,
    targetId: 'chapter-1',
    chapterId: 'chapter-1',
    targetRef: null,
    targetSnapshot: {
      targetType,
      targetId: 'chapter-1',
      targetRef: null,
      assetSummary: {
        targetType,
        title: '黑市追线',
        chapterNo: 1,
        source: 'Chapter.craftBrief',
        updatedAt: '2026-05-16T00:00:00.000Z',
      },
      content: { craftBrief: completeCraftBrief() },
      sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1' },
    },
    sourceTrace: { projectId: 'project-1', chapterId: 'chapter-1' },
  };
}

function createService(report: unknown = validReport()) {
  const calls = { created: [] as unknown[] };
  const prisma = {
    project: { findUnique: async () => ({ id: 'project-1' }) },
    scoringRun: {
      create: async (args: unknown) => {
        calls.created.push(args);
        return { id: 'scoring-run-1', ...(args as { data: Record<string, unknown> }).data };
      },
      findMany: async () => [],
      findFirst: async () => null,
    },
  };
  const targetLoader = {
    loadTarget: async () => loadedTarget(),
  };
  const llm = {
    chatJson: async () => ({
      data: report,
      result: { text: '{}', model: 'scoring-model', usage: { total_tokens: 100 }, elapsedMs: 10, rawPayloadSummary: {} },
    }),
  };
  return {
    service: new ScoringService(prisma as never, targetLoader as never, llm as never),
    prisma,
    targetLoader,
    llm,
    calls,
  };
}

async function run() {
  {
    const { service, calls } = createService();
    const result = await service.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey });
    assert.equal(result.id, 'scoring-run-1');
    assert.equal(calls.created.length, 1);
    const data = (calls.created[0] as { data: Record<string, unknown> }).data;
    assert.equal(data.targetType, targetType);
    assert.equal(data.verdict, 'pass');
    assert.equal(data.platformProfile, profileKey);
  }

  {
    const { service, calls, llm } = createService();
    llm.chatJson = async () => {
      throw new LlmTimeoutError('timeout', 'scoring', 1000);
    };
    await assert.rejects(() => service.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey }), LlmTimeoutError);
    assert.equal(calls.created.length, 0);
  }

  {
    const incomplete = validReport() as Record<string, unknown>;
    delete incomplete.dimensions;
    const { service, calls } = createService(incomplete);
    await assert.rejects(() => service.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey }), BadRequestException);
    assert.equal(calls.created.length, 0);
  }

  {
    const missingDimension = validReport();
    missingDimension.dimensions = missingDimension.dimensions.slice(1);
    const { service, calls } = createService(missingDimension);
    await assert.rejects(() => service.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey }), BadRequestException);
    assert.equal(calls.created.length, 0);
  }

  {
    const missingEvidence = validReport();
    missingEvidence.dimensions[0].evidence = '';
    const { service, calls } = createService(missingEvidence);
    await assert.rejects(() => service.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey }), BadRequestException);
    assert.equal(calls.created.length, 0);
  }

  {
    const prisma = {
      chapter: {
        findFirst: async () => ({
          id: 'chapter-1',
          projectId: 'project-1',
          volumeId: null,
          chapterNo: 1,
          title: 'Empty',
          objective: null,
          conflict: null,
          revealPoints: null,
          foreshadowPlan: null,
          outline: null,
          craftBrief: {},
          status: 'planned',
          updatedAt: new Date('2026-05-16T00:00:00.000Z'),
          volume: null,
          project: { id: 'project-1', title: 'Project' },
        }),
        findMany: async () => [],
      },
    };
    const loader = new ScoringTargetLoaderService(prisma as never);
    await assert.rejects(() => loader.loadTarget('project-1', { targetType, targetId: 'chapter-1' }), BadRequestException);
  }

  {
    const prisma = {
      chapter: {
        findFirst: async () => null,
      },
    };
    const loader = new ScoringTargetLoaderService(prisma as never);
    await assert.rejects(() => loader.loadTarget('project-1', { targetType, targetId: 'foreign-chapter' }), NotFoundException);
  }

  {
    const scoringService = {
      createRun: async (projectId: string, input: Record<string, unknown>, runtime: Record<string, unknown>) => ({ projectId, input, runtime }),
    };
    const tool = new ScoreChapterCraftBriefTool(scoringService as never);
    const result = await tool.run(
      { chapterId: 'chapter-1', profileKey },
      { projectId: 'project-1', agentRunId: 'agent-1', mode: 'act', approved: false, outputs: {}, policy: {} },
    ) as unknown as { projectId: string; input: Record<string, unknown>; runtime: Record<string, unknown> };
    assert.equal(result.projectId, 'project-1');
    assert.equal(result.input.targetType, targetType);
    assert.equal(result.runtime.agentRunId, 'agent-1');
  }

  {
    const { service } = createService();
    const controller = new ScoringController(service, {} as never);
    const result = await controller.createRun('project-1', { targetType, targetId: 'chapter-1', profileKey });
    assert.equal(result.id, 'scoring-run-1');
  }
}

run().then(() => {
  console.log('scoring service craftBrief: ok');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
