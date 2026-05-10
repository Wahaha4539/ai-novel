import assert from 'node:assert/strict';
import type { ToolContext, ToolProgressPatch } from '../agent-tools/base-tool';
import {
  assertChapterRangeCoverage,
  type ChapterOutlineBatchPlan,
} from '../agent-tools/tools/chapter-outline-batch-contracts';
import { GenerateChapterOutlineBatchPreviewTool, MergeChapterOutlineBatchPreviewsTool, SegmentChapterOutlineBatchesTool } from '../agent-tools/tools/chapter-outline-batch-tools.tool';

type TestCase = { name: string; run: () => void | Promise<void> };

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

function createBatchPlan(batches: ChapterOutlineBatchPlan['batches'], chapterCount = 8): ChapterOutlineBatchPlan {
  return { volumeNo: 1, chapterCount, batches, risks: [] };
}

function assertBatchPlanCoverage(plan: ChapterOutlineBatchPlan) {
  assertChapterRangeCoverage({
    chapterCount: plan.chapterCount,
    ranges: plan.batches.map((batch) => ({ chapterRange: batch.chapterRange, label: `batch ${batch.batchNo}` })),
    label: 'chapter outline batch plan',
  });
}

function createStoryUnitPlan(allocations: Array<{ unitId: string; start: number; end: number }>) {
  return {
    planningPrinciple: 'Split only from upstream story unit allocations.',
    purposeMix: { mainline_progress: '60%', mystery_clue: '20%', character_depth: '20%' },
    mainlineSegments: allocations.map((allocation, index) => ({
      segmentId: `seg_${index + 1}`,
      sequence: index + 1,
      title: `Segment ${index + 1}`,
      narrativeFunction: 'Move the volume mainline.',
      mainGoal: 'Reach the next verified story state.',
      mainConflict: 'A concrete opposition blocks the move.',
      turningPoint: 'The pressure changes direction.',
      stateChange: 'The cast exits with a changed tactical state.',
      requiredDeliveries: ['mainline delivery', 'continuity delivery'],
    })),
    units: allocations.map((allocation, index) => {
      const length = allocation.end - allocation.start + 1;
      return {
        unitId: allocation.unitId,
        title: `Unit ${index + 1}`,
        primaryPurpose: 'mainline_progress',
        secondaryPurposes: ['mystery_clue', 'character_depth'],
        relationToMainline: 'direct',
        mainlineSegmentIds: [`seg_${index + 1}`],
        serviceToMainline: 'Carries the upstream mainline segment without inventing new structure.',
        suggestedChapterMin: Math.min(3, length),
        suggestedChapterMax: length,
        narrativePurpose: 'A concrete unit purpose.',
        localGoal: 'Resolve the local objective.',
        localConflict: 'External pressure resists the objective.',
        requiredDeliveries: ['delivery one', 'delivery two'],
        characterFocus: ['Lin'],
        relationshipChanges: ['trust shifts'],
        worldbuildingReveals: [],
        clueProgression: ['clue advances'],
        emotionalEffect: ['pressure'],
        payoff: 'The unit pays off a local question.',
        stateChangeAfterUnit: 'The next unit receives a changed state.',
      };
    }),
    chapterAllocation: allocations.map((allocation) => ({
      unitId: allocation.unitId,
      chapterRange: { start: allocation.start, end: allocation.end },
      chapterRoles: Array.from({ length: allocation.end - allocation.start + 1 }, (_item, index) => `role ${index + 1}`),
    })),
  };
}

function createSegmentContext(storyUnitPlan: Record<string, unknown>, chapterCount = 8) {
  return {
    volumes: [{
      volumeNo: 1,
      title: 'Volume One',
      synopsis: 'Synopsis',
      objective: 'Objective',
      chapterCount,
      narrativePlan: { storyUnitPlan, characterPlan: createVolumeCharacterPlan(chapterCount) },
    }],
    characters: [{ name: 'Lin', aliases: ['L'] }],
    relationships: [],
    existingChapters: [],
  };
}

function createVolumeCharacterPlan(chapterCount = 8) {
  return {
    existingCharacterArcs: [{
      characterName: 'Lin',
      roleInVolume: 'protagonist',
      entryState: 'already investigating',
      volumeGoal: 'solve the bridge case',
      pressure: 'official pressure',
      keyChoices: ['protect evidence'],
      firstActiveChapter: 1,
      lastActiveChapter: chapterCount,
      endState: 'changed by the case',
    }],
    newCharacterCandidates: [{
      candidateId: 'cand_shao',
      name: 'Shao',
      roleType: 'supporting',
      scope: 'volume',
      narrativeFunction: 'adds institutional pressure',
      personalityCore: 'controlled and observant',
      motivation: 'protect a buried record',
      conflictWith: ['Lin'],
      relationshipAnchors: ['Lin'],
      firstAppearChapter: 1,
      expectedArc: 'from opponent to uneasy ally',
      approvalStatus: 'candidate',
    }],
    relationshipArcs: [{
      participants: ['Lin', 'Shao'],
      startState: 'mutual suspicion',
      turnChapterNos: [1],
      endState: 'uneasy cooperation',
    }],
    roleCoverage: {
      mainlineDrivers: ['Lin'],
      antagonistPressure: ['Shao'],
      emotionalCounterweights: ['Lin'],
      expositionCarriers: ['Shao'],
    },
  };
}

function createBatchCraftBrief(chapterNo: number, unitId = 'u1', overrides: Record<string, unknown> = {}) {
  const sceneBeats = [1, 2, 3].map((index) => ({
    sceneArcId: `scene_${chapterNo}_${index}`,
    scenePart: `${index}/3`,
    continuesFromChapterNo: null,
    continuesToChapterNo: null,
    location: `Location ${chapterNo}-${index}`,
    participants: ['Lin', 'Shao'],
    localGoal: 'secure concrete evidence',
    visibleAction: 'Lin tests the clue under pressure',
    obstacle: 'Shao blocks the route',
    turningPoint: 'the clue changes meaning',
    partResult: 'the batch pressure escalates',
    sensoryAnchor: 'wet iron smell',
  }));
  const craftBrief = {
    visibleGoal: `visible goal ${chapterNo}`,
    hiddenEmotion: `hidden emotion ${chapterNo}`,
    coreConflict: `core conflict ${chapterNo}`,
    mainlineTask: `mainline task ${chapterNo}`,
    subplotTasks: [`subplot ${chapterNo}`],
    storyUnit: {
      unitId,
      title: 'Unit 1',
      chapterRange: { start: 1, end: 4 },
      chapterRole: `role ${chapterNo}`,
      localGoal: 'local unit goal',
      localConflict: 'local unit conflict',
      serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
      mainlineContribution: 'advances the mainline with evidence',
      characterContribution: 'pressures Lin into a harder choice',
      relationshipContribution: 'moves Lin and Shao into sharper conflict',
      worldOrThemeContribution: 'shows the institution through procedure',
      unitPayoff: 'sets up the next handoff',
      stateChangeAfterUnit: 'the cast exits with more danger',
    },
    actionBeats: [`act ${chapterNo}-1`, `act ${chapterNo}-2`, `act ${chapterNo}-3`],
    sceneBeats,
    characterExecution: {
      povCharacter: 'Lin',
      cast: [
        {
          characterName: 'Lin',
          source: 'existing' as const,
          functionInChapter: 'drives the investigation',
          visibleGoal: 'confirm the clue',
          pressure: 'official surveillance',
          actionBeatRefs: [1, 2],
          sceneBeatRefs: sceneBeats.map((beat) => beat.sceneArcId),
          entryState: 'carrying prior pressure',
          exitState: 'leaves with a sharper threat',
        },
        {
          characterName: 'Shao',
          source: 'volume_candidate' as const,
          functionInChapter: 'applies institutional pressure',
          visibleGoal: 'control access to evidence',
          pressure: 'must hide a record',
          actionBeatRefs: [2, 3],
          sceneBeatRefs: sceneBeats.map((beat) => beat.sceneArcId),
          entryState: 'watching Lin',
          exitState: 'forced to reveal a limit',
        },
      ],
      relationshipBeats: [{
        participants: ['Lin', 'Shao'],
        publicStateBefore: 'mutual suspicion',
        trigger: 'Shao lets one clue remain visible',
        shift: 'Lin sees a possible ally',
        publicStateAfter: 'open conflict with a private gap',
      }],
      newMinorCharacters: [],
    },
    concreteClues: [{ name: `clue ${chapterNo}`, sensoryDetail: 'salt on the hinge', laterUse: 'used in the next turn' }],
    dialogueSubtext: `subtext ${chapterNo}`,
    characterShift: `shift ${chapterNo}`,
    irreversibleConsequence: `consequence ${chapterNo}`,
    progressTypes: ['info'],
    entryState: `entry ${chapterNo}`,
    exitState: `exit ${chapterNo}`,
    openLoops: [`open loop ${chapterNo}`],
    closedLoops: [`closed loop ${chapterNo}`],
    handoffToNextChapter: `handoff ${chapterNo}`,
    continuityState: {
      characterPositions: [`position ${chapterNo}`],
      activeThreats: [`threat ${chapterNo}`],
      ownedClues: [`clue ${chapterNo}`],
      relationshipChanges: [`relationship ${chapterNo}`],
      nextImmediatePressure: `next pressure ${chapterNo}`,
    },
    ...overrides,
  };
  return craftBrief;
}

function createBatchChapter(chapterNo: number, overrides: Record<string, unknown> = {}) {
  return {
    chapterNo,
    volumeNo: 1,
    title: `Chapter ${chapterNo}`,
    objective: `Objective ${chapterNo}`,
    conflict: `Conflict ${chapterNo}`,
    hook: `Hook ${chapterNo}`,
    outline: `Scene outline ${chapterNo}`,
    expectedWordCount: 2600,
    craftBrief: createBatchCraftBrief(chapterNo),
    ...overrides,
  };
}

function createBatchOutput(chapterNos = [1, 2, 3, 4], overrides: Record<string, unknown> = {}) {
  return {
    batch: {
      volumeNo: 1,
      chapterRange: { start: chapterNos[0], end: chapterNos[chapterNos.length - 1] },
      storyUnitIds: ['u1'],
      continuityBridgeIn: 'enters from previous pressure',
      continuityBridgeOut: 'hands off to next batch',
    },
    chapters: chapterNos.map((chapterNo) => createBatchChapter(chapterNo)),
    risks: [],
    ...overrides,
  };
}

function createBatchOutputForRange(start: number, end: number, unitId: string) {
  const chapterRange = { start, end };
  return createBatchOutput(
    Array.from({ length: end - start + 1 }, (_item, index) => start + index),
    {
      batch: {
        volumeNo: 1,
        chapterRange,
        storyUnitIds: [unitId],
        continuityBridgeIn: `bridge in ${start}`,
        continuityBridgeOut: `bridge out ${end}`,
      },
      chapters: Array.from({ length: end - start + 1 }, (_item, index) => {
        const chapterNo = start + index;
        return createBatchChapter(chapterNo, {
          craftBrief: createBatchCraftBrief(chapterNo, unitId, {
            storyUnit: {
              unitId,
              title: `Unit ${unitId}`,
              chapterRange,
              chapterRole: `role ${chapterNo}`,
              localGoal: 'local unit goal',
              localConflict: 'local unit conflict',
              serviceFunctions: ['mainline', 'relationship_shift', 'foreshadow'],
              mainlineContribution: 'advances the mainline with evidence',
              characterContribution: 'pressures Lin into a harder choice',
              relationshipContribution: 'moves Lin and Shao into sharper conflict',
              worldOrThemeContribution: 'shows the institution through procedure',
              unitPayoff: 'sets up the next handoff',
              stateChangeAfterUnit: 'the cast exits with more danger',
            },
          }),
        });
      }),
    },
  );
}

function createToolContext() {
  const progress: ToolProgressPatch[] = [];
  const context: ToolContext = {
    agentRunId: 'run-cob',
    projectId: 'p1',
    mode: 'plan',
    approved: false,
    outputs: {},
    policy: {},
    async updateProgress(patch: ToolProgressPatch) { progress.push(patch); },
  };
  return {
    progress,
    context,
  };
}

test('COB-P0 range coverage helper accepts complete continuous ranges', () => {
  const plan = createBatchPlan([
    { batchNo: 1, chapterRange: { start: 1, end: 4 }, storyUnitIds: ['u1'], reason: 'unit u1' },
    { batchNo: 2, chapterRange: { start: 5, end: 8 }, storyUnitIds: ['u2'], reason: 'unit u2' },
  ]);

  assert.doesNotThrow(() => assertBatchPlanCoverage(plan));
});

test('COB-P0 range coverage helper rejects missing chapters', () => {
  const plan = createBatchPlan([
    { batchNo: 1, chapterRange: { start: 1, end: 3 }, storyUnitIds: ['u1'], reason: 'unit u1' },
    { batchNo: 2, chapterRange: { start: 5, end: 8 }, storyUnitIds: ['u2'], reason: 'unit u2' },
  ]);

  assert.throws(() => assertBatchPlanCoverage(plan), /expected chapter 4|missing chapters/);
});

test('COB-P0 range coverage helper rejects overlapping chapters', () => {
  assert.throws(
    () => assertChapterRangeCoverage({
      chapterCount: 8,
      ranges: [
        { chapterRange: { start: 1, end: 4 }, label: 'batch 1' },
        { chapterRange: { start: 4, end: 8 }, label: 'batch 2' },
      ],
      label: 'chapter outline batch plan',
    }),
    /expected chapter 5|overlaps/,
  );
});

test('COB-P0 range coverage helper rejects out-of-range chapters', () => {
  const plan = createBatchPlan([
    { batchNo: 1, chapterRange: { start: 1, end: 4 }, storyUnitIds: ['u1'], reason: 'unit u1' },
    { batchNo: 2, chapterRange: { start: 5, end: 9 }, storyUnitIds: ['u2'], reason: 'unit u2' },
  ]);

  assert.throws(() => assertBatchPlanCoverage(plan), /out of range/);
});

test('COB-P1 segment tool follows storyUnitPlan chapterAllocation coverage', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context, progress } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan), volumeNo: 1, chapterCount: 8 },
    context,
  );

  assert.deepEqual(result.batches.map((batch) => batch.chapterRange), [{ start: 1, end: 4 }, { start: 5, end: 8 }]);
  assert.deepEqual(result.batches.map((batch) => batch.storyUnitIds), [['u1'], ['u2']]);
  assertBatchPlanCoverage(result);
  assert.equal(progress[progress.length - 1]?.progressCurrent, 8);
});

test('COB-P1 segment tool splits overlong story units inside unit boundaries', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 10 }]);
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 10), volumeNo: 1, chapterCount: 10, preferredBatchSize: 4, maxBatchSize: 5 },
    context,
  );

  assert.deepEqual(result.batches.map((batch) => batch.chapterRange), [
    { start: 1, end: 4 },
    { start: 5, end: 7 },
    { start: 8, end: 10 },
  ]);
  assert.equal(result.batches.every((batch) => batch.storyUnitIds[0] === 'u1'), true);
  assert.equal(result.batches.every((batch) => batch.chapterRange.end - batch.chapterRange.start + 1 <= 5), true);
  assertBatchPlanCoverage(result);
});

test('COB-P1 segment tool rejects missing chapter allocation coverage', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 6, end: 8 },
  ]);
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext(storyUnitPlan), volumeNo: 1, chapterCount: 8 }, context),
    /chapterAllocation|continuous|coverage|segment_chapter_outline_batches/,
  );
});

test('COB-P1 segment tool rejects out-of-range chapter allocation', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 9 },
  ]);
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext(storyUnitPlan), volumeNo: 1, chapterCount: 8 }, context),
    /chapterAllocation|chapterCount|out of range|segment_chapter_outline_batches/,
  );
});

test('COB-P1 segment tool refuses blind batches without storyUnitPlan', async () => {
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext({}, 8), volumeNo: 1, chapterCount: 8 }, context),
    /no storyUnitPlan\.chapterAllocation|storyUnitPlan/,
  );
});

test('COB-P2 batch preview generates continuous chapters with source whitelist in prompt', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      return { data: createBatchOutput(), result: { model: 'mock-batch-preview' } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    {
      context: createSegmentContext(storyUnitPlan, 4),
      storyUnitPlan,
      volumeNo: 1,
      chapterCount: 4,
      chapterRange: { start: 1, end: 4 },
      instruction: 'generate volume one chapter outlines',
    },
    context,
  );

  assert.equal(result.chapters.length, 4);
  assert.deepEqual(result.chapters.map((chapter) => chapter.chapterNo), [1, 2, 3, 4]);
  assert.equal(result.chapters.every((chapter) => chapter.craftBrief?.characterExecution?.cast?.length === 2), true);
  assert.match(calls[0].messages[1].content, /characterExecution\.cast source whitelist/);
  assert.match(calls[0].messages[1].content, /existing/);
  assert.match(calls[0].messages[1].content, /volume_candidate/);
  assert.match(calls[0].messages[1].content, /minor_temporary/);
  assert.match(calls[0].messages[1].content, /Shao/);
});

test('COB-P2 batch preview rejects missing whole chapter without repair', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  let calls = 0;
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson() {
      calls += 1;
      return { data: createBatchOutput([1, 2, 3]), result: { model: 'mock-missing-chapter' } };
    },
  } as never);
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } }, context),
    /returned 3\/4 chapters/,
  );
  assert.equal(calls, 1);
});

test('COB-P2 batch preview rejects missing whole craftBrief without repair', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  let calls = 0;
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson() {
      calls += 1;
      return {
        data: createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1), createBatchChapter(2, { craftBrief: undefined }), createBatchChapter(3), createBatchChapter(4)] }),
        result: { model: 'mock-missing-craft-brief' },
      };
    },
  } as never);
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } }, context),
    /missing craftBrief/,
  );
  assert.equal(calls, 1);
});

test('COB-P2 batch preview repairs local craftBrief field omissions', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const badCraftBrief = createBatchCraftBrief(2);
  delete (badCraftBrief as Record<string, unknown>).characterShift;
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1), createBatchChapter(2, { craftBrief: badCraftBrief }), createBatchChapter(3), createBatchChapter(4)] });
      return { data: calls.length === 1 ? bad : createBatchOutput(), result: { model: `mock-repair-${calls.length}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /characterShift/);
  assert.equal(result.chapters[1].craftBrief?.characterShift, 'shift 2');
});

test('COB-P2 batch preview repairs character source mistakes through LLM only', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const badCraftBrief = createBatchCraftBrief(1);
  const characterExecution = badCraftBrief.characterExecution as Record<string, any>;
  characterExecution.cast = characterExecution.cast.map((member: Record<string, unknown>) => (
    member.characterName === 'Shao' ? { ...member, source: 'existing' } : member
  ));
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief: badCraftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] });
      return { data: calls.length === 1 ? bad : createBatchOutput(), result: { model: `mock-source-repair-${calls.length}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 2);
  assert.match(calls[1].messages[1].content, /volume_candidate/);
  assert.equal(result.chapters[0].craftBrief?.characterExecution?.cast?.some((member) => member.characterName === 'Shao' && member.source === 'volume_candidate'), true);
});

test('COB-P3 merge batch previews returns standard outline preview', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const tool = new MergeChapterOutlineBatchPreviewsTool();

  const result = await tool.run(
    {
      context: createSegmentContext(storyUnitPlan, 8),
      volumeNo: 1,
      chapterCount: 8,
      batchPreviews: [
        createBatchOutputForRange(1, 4, 'u1'),
        createBatchOutputForRange(5, 8, 'u2'),
      ],
    },
    createToolContext().context,
  );

  assert.equal(result.volume.volumeNo, 1);
  assert.equal(result.volume.chapterCount, 8);
  assert.equal(result.chapters.length, 8);
  assert.deepEqual(result.chapters.map((chapter) => chapter.chapterNo), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.chapters.every((chapter) => chapter.craftBrief?.characterExecution?.cast?.length === 2), true);
});

test('COB-P3 merge batch previews rejects missing batch coverage', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const tool = new MergeChapterOutlineBatchPreviewsTool();

  await assert.rejects(
    () => tool.run(
      {
        context: createSegmentContext(storyUnitPlan, 8),
        volumeNo: 1,
        chapterCount: 8,
        batchPreviews: [createBatchOutputForRange(1, 4, 'u1')],
      },
      createToolContext().context,
    ),
    /missing chapters|not continuous|coverage/,
  );
});

test('COB-P3 merge batch previews rejects overlapping batches', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const tool = new MergeChapterOutlineBatchPreviewsTool();

  await assert.rejects(
    () => tool.run(
      {
        context: createSegmentContext(storyUnitPlan, 8),
        volumeNo: 1,
        chapterCount: 8,
        batchPreviews: [
          createBatchOutputForRange(1, 4, 'u1'),
          createBatchOutputForRange(4, 8, 'u2'),
        ],
      },
      createToolContext().context,
    ),
    /expected chapter 5|overlaps|not continuous/,
  );
});

test('COB-P3 merge batch previews rejects invalid characterExecution sources', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const badFirstBatch = createBatchOutputForRange(1, 4, 'u1');
  const firstChapter = (badFirstBatch.chapters as Array<Record<string, any>>)[0];
  firstChapter.craftBrief.characterExecution.cast[1].source = 'existing';
  const tool = new MergeChapterOutlineBatchPreviewsTool();

  await assert.rejects(
    () => tool.run(
      {
        context: createSegmentContext(storyUnitPlan, 8),
        volumeNo: 1,
        chapterCount: 8,
        batchPreviews: [badFirstBatch, createBatchOutputForRange(5, 8, 'u2')],
      },
      createToolContext().context,
    ),
    /unknown|未知|existing|Shao|characterExecution/,
  );
});

async function main() {
  const filter = process.argv.slice(2).join(' ').trim();
  const selectedTests = filter ? tests.filter((item) => item.name.includes(filter)) : tests;
  if (filter && !selectedTests.length) throw new Error(`No chapter outline batch tests matched: ${filter}`);
  for (const item of selectedTests) {
    await item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`Chapter outline batch tests passed: ${selectedTests.length}/${tests.length}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
