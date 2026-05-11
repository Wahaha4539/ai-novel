import assert from 'node:assert/strict';
import type { ToolContext, ToolProgressPatch } from '../agent-tools/base-tool';
import {
  assertChapterRangeCoverage,
  buildChapterOutlineBatchesFromStoryUnitPlan,
  type ChapterOutlineBatchPlan,
} from '../agent-tools/tools/chapter-outline-batch-contracts';
import { GenerateChapterOutlineBatchPreviewTool, MergeChapterOutlineBatchPreviewsTool, SegmentChapterOutlineBatchesTool } from '../agent-tools/tools/chapter-outline-batch-tools.tool';
import { ValidateOutlineTool } from '../agent-tools/tools/validate-outline.tool';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { PlanValidatorService } from './planner-graph/plan-validator.service';
import type { AgentPlanSpec } from './agent-planner.service';

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

function createValidatedSegmentContext(storyUnitPlan: Record<string, unknown>, chapterCount = 60) {
  const context = createSegmentContext(storyUnitPlan, chapterCount);
  context.volumes[0].narrativePlan = createValidatedNarrativePlan(storyUnitPlan, chapterCount);
  return context;
}

function createValidatedNarrativePlan(storyUnitPlan: Record<string, unknown>, chapterCount: number) {
  return {
    globalMainlineStage: 'The volume turns the investigation from exile survival into public stakes.',
    volumeMainline: 'Lin exposes the bridge case while building enough local trust to survive the counterpressure.',
    dramaticQuestion: 'Can Lin turn scattered evidence into a public rescue before the institution buries the record?',
    startState: 'Lin enters the volume isolated, watched, and short on leverage.',
    endState: 'Lin exits with proof, allies, and a sharper enemy response.',
    endingHook: 'The rescued record points toward the next hidden sponsor.',
    handoffToNextVolume: 'The next volume inherits a public scandal and a private retaliation threat.',
    mainlineMilestones: ['Chapters 1-12 establish the case.', 'Chapters 13-36 reverse the pressure.', 'Chapters 37-60 force the public rescue.'],
    foreshadowPlan: [{
      name: 'salt hinge clue',
      appearRange: { start: 1, end: 4 },
      recoverRange: { start: Math.max(1, chapterCount - 3), end: chapterCount },
      recoveryMethod: 'The hinge residue proves which gate was opened during the rescue night.',
    }],
    subStoryLines: [
      {
        name: 'Lin trust arc',
        type: 'character',
        function: 'Turns isolation into earned local leadership.',
        startState: 'Lin distrusts every official channel.',
        progress: 'Each story unit forces a visible choice that costs Lin safety.',
        endState: 'Lin accepts public responsibility for the rescue.',
        relatedCharacters: ['Lin'],
        chapterNodes: [1, Math.ceil(chapterCount / 2), chapterCount],
      },
      {
        name: 'Lin and Shao pressure arc',
        type: 'relationship',
        function: 'Converts institutional pressure into uneasy cooperation.',
        startState: 'Lin and Shao block each other openly.',
        progress: 'Shao repeatedly preserves one clue while denying another.',
        endState: 'They cooperate under a threat neither can solve alone.',
        relatedCharacters: ['Lin', 'Shao'],
        chapterNodes: [4, Math.ceil(chapterCount / 2), chapterCount],
      },
    ],
    storyUnitPlan,
    characterPlan: createVolumeCharacterPlan(chapterCount),
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

function isQualityReviewCall(options?: Record<string, unknown>) {
  const schema = options?.jsonSchema as Record<string, unknown> | undefined;
  return schema?.name === 'chapter_outline_batch_quality_review';
}

function createPassingQualityReview(overrides: Record<string, unknown> = {}) {
  return { valid: true, summary: 'Batch is draftable.', issues: [], ...overrides };
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

function createValidatedBatchOutputForRange(start: number, end: number, unitId: string) {
  const output = createBatchOutputForRange(start, end, unitId);
  return {
    ...output,
    chapters: output.chapters.map((chapter) => ({
      ...chapter,
      outline: createConcreteOutline(chapter.chapterNo),
    })),
  };
}

function createConcreteOutline(chapterNo: number) {
  return [
    `Scene one: Lin enters Location ${chapterNo}-1 with the salt hinge clue, tests it against a visible scratch, and Shao blocks the doorway before Lin can leave.`,
    `Scene two: the cast trades the clue under official pressure, a witness changes their statement, and Lin discovers which record was moved.`,
    `Scene three: Lin chooses a costly public action, Shao preserves one private gap, and the next chapter inherits a sharper pursuit.`,
  ].join(' ');
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
    async heartbeat(patch?: ToolProgressPatch) { if (patch) progress.push(patch); },
  };
  return {
    progress,
    context,
  };
}

function createPlanValidatorPlan(steps: Array<{ tool: string; requiresApproval?: boolean; args?: Record<string, unknown> }>): AgentPlanSpec {
  return {
    taskType: 'outline_design',
    summary: 'batch validator test',
    assumptions: [],
    risks: [],
    requiredApprovals: [],
    steps: steps.map((step, index) => ({
      stepNo: index + 1,
      name: step.tool,
      tool: step.tool,
      mode: 'act' as const,
      requiresApproval: step.requiresApproval ?? false,
      args: step.args ?? {},
    })),
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

test('COB-OPT shared batch splitter matches segment tool story-unit-aware ranges', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 14 },
    { unitId: 'u3', start: 15, end: 18 },
  ]);
  const tool = new SegmentChapterOutlineBatchesTool();
  const { context } = createToolContext();

  const helperBatches = buildChapterOutlineBatchesFromStoryUnitPlan(storyUnitPlan, {
    preferredBatchSize: 4,
    maxBatchSize: 5,
    label: 'test splitter',
  });
  const toolPlan = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 18), volumeNo: 1, chapterCount: 18, preferredBatchSize: 4, maxBatchSize: 5 },
    context,
  );

  assert.deepEqual(helperBatches.map((batch) => batch.chapterRange), toolPlan.batches.map((batch) => batch.chapterRange));
  assert.deepEqual(helperBatches.map((batch) => batch.chapterRange), [
    { start: 1, end: 4 },
    { start: 5, end: 8 },
    { start: 9, end: 11 },
    { start: 12, end: 14 },
    { start: 15, end: 18 },
  ]);
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
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const onStreamProgress = options.onStreamProgress as ((progress: Record<string, unknown>) => void) | undefined;
      onStreamProgress?.({ event: 'headers', elapsedMs: 1, streamed: true, chunkCount: 0, eventCount: 0, contentChunkCount: 0, streamedContentChars: 0, doneReceived: false });
      onStreamProgress?.({ event: 'chunk', elapsedMs: 2, streamed: true, chunkCount: 1, eventCount: 1, contentChunkCount: 1, streamedContentChars: 42, doneReceived: false });
      return { data: createBatchOutput(), result: { model: 'mock-batch-preview' } };
    },
  } as never);
  const { context, progress } = createToolContext();

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
  assert.equal(calls.length, 2);
  assert.match(calls[0].messages[1].content, /characterExecution\.cast source whitelist/);
  assert.match(calls[0].messages[1].content, /existing/);
  assert.match(calls[0].messages[1].content, /volume_candidate/);
  assert.match(calls[0].messages[1].content, /minor_temporary/);
  assert.match(calls[0].messages[1].content, /Shao/);
  assert.match(calls[0].messages[0].content, /complete valid JSON object/);
  assert.match(calls[0].messages[1].content, /outline should summarize the chapter in a few draftable scene sentences/);
  assert.match(calls[0].messages[1].content, /sceneBeats array must contain at least 3 concrete scene segments/);
  assert.match(calls[0].messages[1].content, /"sceneBeats":\[\{"sceneArcId":"scene_1".*"sceneArcId":"scene_2".*"sceneArcId":"scene_3"/);
  assert.equal(calls[0].options.jsonMode, true);
  assert.equal(calls[0].options.stream, true);
  assert.equal(calls[0].options.streamIdleTimeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(calls[0].options.maxTokens, 24_500);
  assert.equal(typeof calls[0].options.onStreamProgress, 'function');
  assert.equal(progress.some((item) => item.phase === 'calling_llm' && item.timeoutMs === DEFAULT_LLM_TIMEOUT_MS + 30_000), true);
  assert.equal(progress.some((item) => /streaming 42 chars/.test(item.phaseMessage ?? '')), true);
  const schema = calls[0].options.jsonSchema as Record<string, unknown>;
  assert.equal(schema.name, 'chapter_outline_batch_preview');
  assert.equal(schema.strict, true);
  const schemaText = JSON.stringify(schema.schema);
  assert.match(schemaText, /"sensoryAnchor"/);
  assert.match(schemaText, /"enum":\["u1"\]/);
  assert.match(calls[1].messages[0].content, /Do not use keyword matching/);
  assert.match(calls[1].messages[1].content, /actor\/action\/object\/obstacle\/result|actor.*visible action.*object/s);
  assert.equal((calls[1].options.jsonSchema as Record<string, unknown>).name, 'chapter_outline_batch_quality_review');
  assert.equal(calls[1].options.stream, true);
  assert.equal(calls[1].options.streamIdleTimeoutMs, DEFAULT_LLM_TIMEOUT_MS);
  assert.equal(calls[1].options.maxTokens, undefined);
  assert.equal(typeof calls[1].options.onStreamProgress, 'function');
});

test('COB-OPT batch preview prompt uses persisted storyUnit slice when plan passes only batchPlan', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      return { data: createBatchOutput(), result: { model: 'mock-persisted-story-unit-slice' } };
    },
  } as never);
  const { context } = createToolContext();

  await tool.run(
    {
      context: createValidatedSegmentContext(storyUnitPlan, 4),
      batchPlan: createBatchPlan([{ batchNo: 1, chapterRange: { start: 1, end: 4 }, storyUnitIds: ['u1'], reason: 'unit u1' }], 4),
      volumeNo: 1,
      chapterCount: 4,
      chapterRange: { start: 1, end: 4 },
    },
    context,
  );

  const prompt = calls[0].messages[1].content;
  const sliceSection = prompt.split('Story unit slice for this batch:\n')[1]?.split('\n\nPrevious batch tail:')[0] ?? '';
  assert.notEqual(sliceSection, '{}');
  assert.match(sliceSection, /"unitId":"u1"/);
  assert.match(sliceSection, /"chapterRange":\{"start":1,"end":4\}/);
});

test('COB-P2 batch preview uses LLM quality issues to regenerate one failed batch', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) {
        const qualityCallCount = calls.filter((call) => isQualityReviewCall(call.options)).length;
        return {
          data: qualityCallCount === 1
            ? {
                valid: false,
                summary: 'Chapter 2 action beat is not draftable.',
                issues: [{
                  severity: 'error',
                  chapterNo: 2,
                  path: 'chapters[1].craftBrief.actionBeats[0]',
                  message: 'Action beat lacks a visible actor action and result.',
                  suggestion: 'Regenerate chapter 2 with actor, visible action, object, obstacle, and result.',
                  evidence: '推进线索',
                }],
              }
            : createPassingQualityReview(),
          result: { model: `mock-quality-${qualityCallCount}` },
        };
      }
      return { data: createBatchOutput(), result: { model: 'mock-quality-regeneration' } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 4);
  assert.equal(result.qualityReview?.valid, true);
  assert.equal(result.risks.some((risk) => /quality review requested one regeneration/i.test(risk)), true);
  assert.equal(calls[0].options.maxTokens, 24_500);
  assert.equal(calls[2].options.maxTokens, 24_500);
  const qualityIssueSchema = (((calls[1].options.jsonSchema as { schema: Record<string, unknown> }).schema.properties as Record<string, { items: unknown }>).issues.items) as {
    required: string[];
    properties: Record<string, unknown>;
  };
  assert.deepEqual(qualityIssueSchema.required, ['severity', 'chapterNo', 'path', 'message', 'suggestion', 'evidence']);
  assert.deepEqual(qualityIssueSchema.properties.chapterNo, { type: ['integer', 'null'] });
  assert.match(calls[2].messages[1].content, /qualityIssuesToFix/);
  assert.match(calls[2].messages[1].content, /Action beat lacks a visible actor action and result/);
  assert.match(calls[2].messages[1].content, /rejectedOutput/);
});

test('COB-OPT batch preview prompt shape uses the active batch range', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }, { unitId: 'u2', start: 5, end: 8 }]);
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      return { data: createBatchOutputForRange(5, 8, 'u2'), result: { model: 'mock-active-batch-shape' } };
    },
  } as never);
  const { context } = createToolContext();

  await tool.run(
    {
      context: createValidatedSegmentContext(storyUnitPlan, 8),
      batchPlan: createBatchPlan([
        { batchNo: 1, chapterRange: { start: 1, end: 4 }, storyUnitIds: ['u1'], reason: 'unit u1' },
        { batchNo: 2, chapterRange: { start: 5, end: 8 }, storyUnitIds: ['u2'], reason: 'unit u2' },
      ], 8),
      volumeNo: 1,
      chapterCount: 8,
      chapterRange: { start: 5, end: 8 },
    },
    context,
  );

  const prompt = calls[0].messages[1].content;
  const shapeSection = prompt.split('Required JSON shape:\n')[1] ?? '';
  assert.match(prompt, /Target batch chapterRange: 5-8/);
  assert.match(shapeSection, /"chapterRange":\{"start":5,"end":8\}/);
  assert.match(shapeSection, /"storyUnitIds":\["u2"\]/);
  assert.match(shapeSection, /"chapterNo":5/);
  assert.doesNotMatch(shapeSection, /"chapterRange":\{"start":1,"end":4\}/);
  assert.doesNotMatch(shapeSection, /"storyUnitIds":\["u1"\]/);
  assert.doesNotMatch(shapeSection, /"chapterNo":1/);
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

test('COB-P2 batch preview accepts one-off minor wording that negates long-term role', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const craftBrief = createBatchCraftBrief(1);
  const characterExecution = craftBrief.characterExecution as Record<string, any>;
  const sceneBeatRefs = craftBrief.sceneBeats.map((beat) => beat.sceneArcId);
  characterExecution.cast = [
    ...characterExecution.cast,
    {
      characterName: '遗属代表',
      source: 'minor_temporary',
      functionInChapter: '提出一次现场质问，制造公开承诺压力',
      visibleGoal: '要求主角给出本章现场答复',
      pressure: '亲属伤亡刚发生，围观者要求立刻处理',
      actionBeatRefs: [1],
      sceneBeatRefs,
      entryState: '随人群进入现场',
      exitState: '得到公开答复后离开本章冲突中心',
    },
  ];
  characterExecution.newMinorCharacters = [{
    nameOrLabel: '遗属代表',
    narrativeFunction: '代表遗属在本章提出一次质问',
    interactionScope: '仅限本章冲突现场的遗属声音，不承担长期独立角色功能。',
    firstAndOnlyUse: true,
    approvalPolicy: 'preview_only',
  }];
  let calls = 0;
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(_messages: unknown, options?: Record<string, unknown>) {
      calls += 1;
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      return {
        data: createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] }),
        result: { model: 'mock-negated-temporary-role' },
      };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls, 2);
  assert.equal(result.chapters[0].craftBrief?.characterExecution?.newMinorCharacters?.[0]?.nameOrLabel, '遗属代表');
});

test('COB-P2 batch preview rejects LLM-flagged temporary character without repair', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const craftBrief = createBatchCraftBrief(1);
  const characterExecution = craftBrief.characterExecution as Record<string, any>;
  characterExecution.newMinorCharacters = [{
    nameOrLabel: '遗属代表',
    narrativeFunction: 'LLM 判定该角色可能需要进入上游角色计划',
    interactionScope: '需要审批后才能作为章节角色执行输入',
    firstAndOnlyUse: true,
    approvalPolicy: 'needs_approval',
  }];
  let calls = 0;
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson() {
      calls += 1;
      return {
        data: createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] }),
        result: { model: 'mock-important-temporary-role' },
      };
    },
  } as never);
  const { context } = createToolContext();

  await assert.rejects(
    () => tool.run({ context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } }, context),
    /approvalPolicy 声明为 needs_approval/,
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
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1), createBatchChapter(2, { craftBrief: badCraftBrief }), createBatchChapter(3), createBatchChapter(4)] });
      const generationCallCount = calls.filter((call) => !isQualityReviewCall(call.options)).length;
      return { data: generationCallCount === 1 ? bad : createBatchOutput(), result: { model: `mock-repair-${generationCallCount}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 3);
  assert.match(calls[1].messages[1].content, /characterShift/);
  assert.match(calls[1].messages[0].content, /compact strict JSON/);
  assert.match(calls[1].messages[1].content, /craftBrief\.actionBeats and craftBrief\.sceneBeats each need at least 3/);
  assert.equal((calls[1].options.jsonSchema as Record<string, unknown>).name, 'chapter_outline_batch_preview');
  assert.ok(calls[1].messages[1].content.length < 50000, 'repair payload should stay compact for local structural repair');
  assert.equal(result.chapters[1].craftBrief?.characterShift, 'shift 2');
});

test('COB-OPT batch preview repair prompt names complete relationshipBeats fields', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const badCraftBrief = createBatchCraftBrief(1);
  const characterExecution = badCraftBrief.characterExecution as Record<string, any>;
  characterExecution.relationshipBeats = characterExecution.relationshipBeats.map((beat: Record<string, unknown>) => {
    const incomplete = { ...beat };
    delete incomplete.publicStateBefore;
    return incomplete;
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief: badCraftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] });
      const generationCallCount = calls.filter((call) => !isQualityReviewCall(call.options)).length;
      return { data: generationCallCount === 1 ? bad : createBatchOutput(), result: { model: `mock-relationship-repair-${generationCallCount}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 3);
  assert.match(calls[0].messages[1].content, /relationshipBeats.*publicStateBefore.*trigger.*shift.*publicStateAfter/s);
  assert.match(calls[1].messages[0].content, /relationshipBeats.*publicStateBefore.*trigger.*shift.*publicStateAfter/s);
  assert.match(calls[1].messages[1].content, /Do not leave partial relationship beat objects/);
  assert.equal(result.chapters[0].craftBrief?.characterExecution?.relationshipBeats?.[0]?.publicStateBefore, 'mutual suspicion');
});

test('COB-OPT batch preview repair prompt names required sceneBeat fields', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const badCraftBrief = createBatchCraftBrief(1);
  (badCraftBrief as Record<string, any>).sceneBeats = badCraftBrief.sceneBeats.map((beat: Record<string, unknown>, index: number) => {
    if (index !== 0) return beat;
    const incomplete = { ...beat };
    delete incomplete.scenePart;
    return incomplete;
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief: badCraftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] });
      const generationCallCount = calls.filter((call) => !isQualityReviewCall(call.options)).length;
      return { data: generationCallCount === 1 ? bad : createBatchOutput(), result: { model: `mock-scene-repair-${generationCallCount}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 3);
  assert.match(calls[1].messages[0].content, /sceneArcId.*scenePart.*location.*participants.*localGoal.*visibleAction.*obstacle.*turningPoint.*partResult.*sensoryAnchor/s);
  assert.match(calls[1].messages[1].content, /Each sceneBeats object must include sceneArcId, scenePart, location, participants, localGoal, visibleAction, obstacle, turningPoint, partResult, and sensoryAnchor/);
  assert.equal(result.chapters[0].craftBrief?.sceneBeats?.[0]?.scenePart, '1/3');
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
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const bad = createBatchOutput([1, 2, 3, 4], { chapters: [createBatchChapter(1, { craftBrief: badCraftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)] });
      const generationCallCount = calls.filter((call) => !isQualityReviewCall(call.options)).length;
      return { data: generationCallCount === 1 ? bad : createBatchOutput(), result: { model: `mock-source-repair-${generationCallCount}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 3);
  assert.match(calls[1].messages[1].content, /volume_candidate/);
  assert.equal(result.chapters[0].craftBrief?.characterExecution?.cast?.some((member) => member.characterName === 'Shao' && member.source === 'volume_candidate'), true);
});

test('COB-OPT batch preview retries cascading local characterExecution repair errors', async () => {
  const storyUnitPlan = createStoryUnitPlan([{ unitId: 'u1', start: 1, end: 4 }]);
  const firstBadCraftBrief = createBatchCraftBrief(1);
  firstBadCraftBrief.sceneBeats[0].participants = [...firstBadCraftBrief.sceneBeats[0].participants, 'Trial Crew'];

  function craftBriefWithTemporaryCrew(declareMinor: boolean) {
    const craftBrief = createBatchCraftBrief(2);
    const characterExecution = craftBrief.characterExecution as Record<string, any>;
    const sceneBeatRefs = craftBrief.sceneBeats.map((beat) => beat.sceneArcId);
    characterExecution.cast = [
      ...characterExecution.cast,
      {
        characterName: 'Trial Crew',
        source: 'minor_temporary',
        functionInChapter: 'carries one local bridge stress test',
        visibleGoal: 'finish the dangerous bridge check',
        pressure: 'the test can collapse if the clue is wrong',
        actionBeatRefs: [1],
        sceneBeatRefs,
        entryState: 'assembled for the test',
        exitState: 'dismissed after the local test',
      },
    ];
    if (declareMinor) {
      characterExecution.newMinorCharacters = [{
        nameOrLabel: 'Trial Crew',
        narrativeFunction: 'one-off pressure group for the bridge stress test',
        interactionScope: 'chapter 2 bridge test only',
        firstAndOnlyUse: true,
        approvalPolicy: 'preview_only',
      }];
    }
    return craftBrief;
  }

  const firstBad = createBatchOutput([1, 2, 3, 4], {
    chapters: [createBatchChapter(1, { craftBrief: firstBadCraftBrief }), createBatchChapter(2), createBatchChapter(3), createBatchChapter(4)],
  });
  const secondBad = createBatchOutput([1, 2, 3, 4], {
    chapters: [createBatchChapter(1), createBatchChapter(2, { craftBrief: craftBriefWithTemporaryCrew(false) }), createBatchChapter(3), createBatchChapter(4)],
  });
  const fixed = createBatchOutput([1, 2, 3, 4], {
    chapters: [createBatchChapter(1), createBatchChapter(2, { craftBrief: craftBriefWithTemporaryCrew(true) }), createBatchChapter(3), createBatchChapter(4)],
  });
  const calls: Array<{ messages: Array<{ role: string; content: string }>; options: Record<string, unknown> }> = [];
  const tool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) {
      calls.push({ messages, options });
      if (isQualityReviewCall(options)) return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      const generationCallCount = calls.filter((call) => !isQualityReviewCall(call.options)).length;
      const data = generationCallCount === 1 ? firstBad : generationCallCount === 2 ? secondBad : fixed;
      return { data, result: { model: `mock-cascading-repair-${generationCallCount}` } };
    },
  } as never);
  const { context } = createToolContext();

  const result = await tool.run(
    { context: createSegmentContext(storyUnitPlan, 4), storyUnitPlan, volumeNo: 1, chapterCount: 4, chapterRange: { start: 1, end: 4 } },
    context,
  );

  assert.equal(calls.length, 4);
  assert.equal(calls.filter((call) => !isQualityReviewCall(call.options)).every((call) => call.options.maxTokens === 24_500), true);
  assert.match(calls[1].messages[0].content, /scan every chapter in the batch/);
  assert.match(calls[1].messages[1].content, /Every cast member with source minor_temporary/);
  assert.match(calls[2].messages[1].content, /Trial Crew/);
  assert.equal(result.chapters[1].craftBrief?.characterExecution?.newMinorCharacters?.[0]?.nameOrLabel, 'Trial Crew');
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

test('COCF-P0 merge batch previews carries regenerated storyUnitPlan into merged volume', async () => {
  const storyUnitPlan = createStoryUnitPlan([
    { unitId: 'u1', start: 1, end: 4 },
    { unitId: 'u2', start: 5, end: 8 },
  ]);
  const tool = new MergeChapterOutlineBatchPreviewsTool();

  const result = await tool.run(
    {
      context: {
        ...createSegmentContext(storyUnitPlan, 8),
        volumes: [{
          volumeNo: 1,
          title: 'Volume One',
          synopsis: 'Synopsis',
          objective: 'Objective',
          chapterCount: 8,
          narrativePlan: { characterPlan: createVolumeCharacterPlan(8) },
        }],
      },
      volumeOutline: {
        volumeNo: 1,
        title: 'Volume One',
        synopsis: 'Synopsis',
        objective: 'Objective',
        chapterCount: 8,
        narrativePlan: { characterPlan: createVolumeCharacterPlan(8) },
      },
      storyUnitPlan,
      volumeNo: 1,
      chapterCount: 8,
      batchPreviews: [
        createBatchOutputForRange(1, 4, 'u1'),
        createBatchOutputForRange(5, 8, 'u2'),
      ],
    },
    createToolContext().context,
  );

  assert.deepEqual((result.volume.narrativePlan as Record<string, unknown>).storyUnitPlan, storyUnitPlan);
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

test('COB-P4 PlanValidator accepts segmented batch outline plans covering 1..60', () => {
  const validator = new PlanValidatorService();
  const batchSteps = Array.from({ length: 15 }, (_item, index) => {
    const start = index * 4 + 1;
    const end = start + 3;
    return {
      tool: 'generate_chapter_outline_batch_preview',
      args: {
        context: '{{steps.1.output}}',
        batchPlan: '{{steps.2.output}}',
        volumeNo: 1,
        chapterCount: 60,
        chapterRange: { start, end },
        instruction: '{{context.userMessage}}',
      },
    };
  });

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
      ...batchSteps,
      {
        tool: 'merge_chapter_outline_batch_previews',
        args: {
          batchPreviews: batchSteps.map((_step, index) => `{{steps.${index + 3}.output}}`),
          volumeNo: 1,
          chapterCount: 60,
        },
      },
      { tool: 'persist_outline', requiresApproval: true, args: { preview: '{{steps.18.output}}' } },
    ]),
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 60 },
  }));
});

test('COB-P4 PlanValidator rejects target chapterCount mismatch without rebuilt volume outline', () => {
  const validator = new PlanValidatorService();
  const context = {
    volumes: [{ id: 'v1', volumeNo: 1, chapterCount: 40, hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }],
  };
  const batchSteps = Array.from({ length: 15 }, (_item, index) => {
    const start = index * 4 + 1;
    return {
      tool: 'generate_chapter_outline_batch_preview',
      args: {
        context: '{{steps.1.output}}',
        batchPlan: '{{steps.2.output}}',
        volumeNo: 1,
        chapterCount: 60,
        chapterRange: { start, end: start + 3 },
      },
    };
  });

  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
        ...batchSteps,
        { tool: 'merge_chapter_outline_batch_previews', args: { batchPreviews: batchSteps.map((_step, index) => `{{steps.${index + 3}.output}}`), volumeNo: 1, chapterCount: 60 } },
      ]),
      context: context as never,
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 60 },
    }),
    /target chapterCount 60.*context volume 1 chapterCount 40.*generate_volume_outline_preview/,
  );
});

test('COB-P4 PlanValidator accepts target chapterCount changes when rebuilt volume and story units feed batches', () => {
  const validator = new PlanValidatorService();
  const context = {
    volumes: [{ id: 'v1', volumeNo: 1, chapterCount: 40, hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }],
  };
  const batchSteps = Array.from({ length: 15 }, (_item, index) => {
    const start = index * 4 + 1;
    return {
      tool: 'generate_chapter_outline_batch_preview',
      args: {
        context: '{{steps.1.output}}',
        volumeOutline: '{{steps.2.output.volume}}',
        storyUnitPlan: '{{steps.3.output.storyUnitPlan}}',
        batchPlan: '{{steps.4.output}}',
        volumeNo: 1,
        chapterCount: 60,
        chapterRange: { start, end: start + 3 },
      },
    };
  });

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'generate_volume_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 60 } },
      { tool: 'generate_story_units_preview', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', volumeNo: 1, chapterCount: 60 } },
      { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeOutline: '{{steps.2.output.volume}}', storyUnitPlan: '{{steps.3.output.storyUnitPlan}}', volumeNo: 1, chapterCount: 60 } },
      ...batchSteps,
      {
        tool: 'merge_chapter_outline_batch_previews',
        args: {
          batchPreviews: batchSteps.map((_step, index) => `{{steps.${index + 5}.output}}`),
          volumeOutline: '{{steps.2.output.volume}}',
          storyUnitPlan: '{{steps.3.output.storyUnitPlan}}',
          volumeNo: 1,
          chapterCount: 60,
        },
      },
      { tool: 'persist_outline', requiresApproval: true, args: { preview: '{{steps.20.output}}' } },
    ]),
    context: context as never,
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 60 },
  }));
});

test('COCF-P0 PlanValidator uses context Volume.chapterCount when plan omits an explicit count', () => {
  const validator = new PlanValidatorService();
  const context = {
    volumes: [{ id: 'v1', volumeNo: 1, chapterCount: 8, hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }],
  };
  const batchSteps = [
    { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 8, chapterRange: { start: 1, end: 4 } } },
    { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 8, chapterRange: { start: 5, end: 8 } } },
  ];

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 8 } },
      ...batchSteps,
      { tool: 'merge_chapter_outline_batch_previews', args: { batchPreviews: ['{{steps.3.output}}', '{{steps.4.output}}'], volumeNo: 1, chapterCount: 8 } },
    ]),
    context: context as never,
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1 },
  }));
});

test('COCF-P0 PlanValidator rejects chapter outline plans with no structured or context chapterCount', () => {
  const validator = new PlanValidatorService();

  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 1 } },
      ]),
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterNo: 1 },
    }),
    /without a structured chapterCount or target Volume\.chapterCount/,
  );
});

test('COCF-P0 PlanValidator accepts single chapter target from structured plan args', () => {
  const validator = new PlanValidatorService();
  const context = {
    volumes: [{ id: 'v1', volumeNo: 1, chapterCount: 60, hasNarrativePlan: true, hasStoryUnitPlan: true, hasLegacyStoryUnits: false }],
  };

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 3, chapterCount: 60 } },
    ]),
    context: context as never,
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1 },
  }));
});

test('COB-OPT PlanValidator enforces story-unit-aware batch hints when available', () => {
  const validator = new PlanValidatorService();
  const hintedRanges = [
    { start: 1, end: 4 },
    { start: 5, end: 8 },
    { start: 9, end: 11 },
    { start: 12, end: 14 },
    { start: 15, end: 18 },
  ];
  const batchSteps = hintedRanges.map((chapterRange) => ({
    tool: 'generate_chapter_outline_batch_preview',
    args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 18, chapterRange },
  }));
  const context = {
    volumes: [{
      id: 'v1',
      volumeNo: 1,
      chapterCount: 18,
      hasNarrativePlan: true,
      hasStoryUnitPlan: true,
      hasLegacyStoryUnits: false,
      chapterOutlineBatchHints: hintedRanges.map((chapterRange, index) => ({
        batchNo: index + 1,
        chapterRange,
        storyUnitIds: [`u${index + 1}`],
        reason: 'test hint',
      })),
    }],
  };

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 18 } },
      ...batchSteps,
      { tool: 'merge_chapter_outline_batch_previews', args: { batchPreviews: batchSteps.map((_step, index) => `{{steps.${index + 3}.output}}`), volumeNo: 1, chapterCount: 18 } },
    ]),
    context: context as never,
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 18 },
  }));

  const uniformRanges = [
    { start: 1, end: 4 },
    { start: 5, end: 8 },
    { start: 9, end: 12 },
    { start: 13, end: 16 },
    { start: 17, end: 18 },
  ];
  const uniformBatchSteps = uniformRanges.map((chapterRange) => ({
    tool: 'generate_chapter_outline_batch_preview',
    args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 18, chapterRange },
  }));

  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 18 } },
        ...uniformBatchSteps,
        { tool: 'merge_chapter_outline_batch_previews', args: { batchPreviews: uniformBatchSteps.map((_step, index) => `{{steps.${index + 3}.output}}`), volumeNo: 1, chapterCount: 18 } },
      ]),
      context: context as never,
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 18 },
    }),
    /chapterOutlineBatchHints/,
  );
});

test('COB-P4 PlanValidator rejects batch outline plans with missing chapter coverage', () => {
  const validator = new PlanValidatorService();

  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'inspect_project_context' },
        { tool: 'segment_chapter_outline_batches', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterCount: 8 } },
        { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 8, chapterRange: { start: 1, end: 4 } } },
        { tool: 'generate_chapter_outline_batch_preview', args: { context: '{{steps.1.output}}', batchPlan: '{{steps.2.output}}', volumeNo: 1, chapterCount: 8, chapterRange: { start: 6, end: 8 } } },
        { tool: 'merge_chapter_outline_batch_previews', args: { batchPreviews: ['{{steps.3.output}}', '{{steps.4.output}}'], volumeNo: 1, chapterCount: 8 } },
      ]),
      route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 8 },
    }),
    /invalid chapter coverage|missing \[5-5\]/,
  );
});

test('COB-P4 PlanValidator still accepts legacy explicit single-chapter outline plans', () => {
  const validator = new PlanValidatorService();

  assert.doesNotThrow(() => validator.validate({
    plan: createPlanValidatorPlan([
      { tool: 'inspect_project_context' },
      { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 1, chapterCount: 3 } },
      { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 2, chapterCount: 3, previousChapter: '{{steps.2.output.chapter}}' } },
      { tool: 'generate_chapter_outline_preview', args: { context: '{{steps.1.output}}', volumeNo: 1, chapterNo: 3, chapterCount: 3, previousChapter: '{{steps.3.output.chapter}}' } },
      { tool: 'merge_chapter_outline_previews', args: { previews: ['{{steps.2.output}}', '{{steps.3.output}}', '{{steps.4.output}}'], volumeNo: 1, chapterCount: 3 } },
    ]),
    route: { domain: 'outline', intent: 'split_volume_to_chapters', confidence: 0.9, reasons: ['test'], volumeNo: 1, chapterCount: 3 },
  }));
});

test('COB-P4 PlanValidator requires persist_outline approval', () => {
  const validator = new PlanValidatorService();

  assert.throws(
    () => validator.validate({
      plan: createPlanValidatorPlan([
        { tool: 'persist_outline', requiresApproval: false, args: { preview: '{{steps.1.output}}' } },
      ]),
    }),
    /write tools without approval: persist_outline/,
  );
});

test('COB-P6 end-to-end batch outline pipeline covers 1..60 and validates standard output', async () => {
  const allocations = Array.from({ length: 15 }, (_item, index) => ({
    unitId: `u${index + 1}`,
    start: index * 4 + 1,
    end: index * 4 + 4,
  }));
  const storyUnitPlan = createStoryUnitPlan(allocations);
  const context = createValidatedSegmentContext(storyUnitPlan, 60);
  const toolContext = createToolContext().context;
  const segmentTool = new SegmentChapterOutlineBatchesTool();

  const batchPlan = await segmentTool.run(
    { context, volumeNo: 1, chapterCount: 60, preferredBatchSize: 4, maxBatchSize: 5 },
    toolContext,
  );

  assert.equal(batchPlan.batches.length, 15);
  assert.deepEqual(batchPlan.batches[0].chapterRange, { start: 1, end: 4 });
  assert.deepEqual(batchPlan.batches[14].chapterRange, { start: 57, end: 60 });
  assertBatchPlanCoverage(batchPlan);

  const calls: Array<{ start: number; end: number; prompt: string }> = [];
  const previewTool = new GenerateChapterOutlineBatchPreviewTool({
    async chatJson(messages: Array<{ role: string; content: string }>, options?: Record<string, unknown>) {
      if (isQualityReviewCall(options)) {
        return { data: createPassingQualityReview(), result: { model: 'mock-quality-review' } };
      }
      const prompt = messages[1]?.content ?? '';
      const match = prompt.match(/Target batch chapterRange: (\d+)-(\d+)/);
      assert.ok(match, 'batch preview prompt should expose the concrete chapter range');
      const start = Number(match[1]);
      const end = Number(match[2]);
      const allocation = allocations.find((item) => item.start <= start && end <= item.end);
      assert.ok(allocation, `range ${start}-${end} should map to a story unit allocation`);
      calls.push({ start, end, prompt });
      return {
        data: createValidatedBatchOutputForRange(start, end, allocation.unitId),
        result: { model: 'mock-batch-e2e' },
      };
    },
  } as never);

  const previews = [];
  for (const batch of batchPlan.batches) {
    const previous = previews.at(-1)?.chapters.at(-1);
    const previousBatchTail = previous
      ? {
          chapterNo: previous.chapterNo,
          title: previous.title,
          hook: previous.hook,
          craftBrief: previous.craftBrief
            ? {
                exitState: previous.craftBrief.exitState,
                handoffToNextChapter: previous.craftBrief.handoffToNextChapter,
                openLoops: previous.craftBrief.openLoops,
                continuityState: previous.craftBrief.continuityState as Record<string, unknown> | undefined,
              }
            : undefined,
        }
      : undefined;
    const preview = await previewTool.run(
      {
        context,
        storyUnitPlan,
        batchPlan,
        volumeNo: 1,
        chapterCount: 60,
        chapterRange: batch.chapterRange,
        instruction: '帮我生成第一卷的章节细纲',
        ...(previousBatchTail ? { previousBatchTail } : {}),
      },
      toolContext,
    );
    previews.push(preview);
  }

  assert.equal(calls.length, 15);
  assert.equal(calls.every((call) => call.end - call.start + 1 <= 5), true);
  assert.equal(calls.every((call) => /existing/.test(call.prompt) && /volume_candidate/.test(call.prompt) && /minor_temporary/.test(call.prompt)), true);

  const merged = await new MergeChapterOutlineBatchPreviewsTool().run(
    { context, volumeNo: 1, chapterCount: 60, batchPreviews: previews },
    toolContext,
  );

  assert.equal(merged.volume.volumeNo, 1);
  assert.equal(merged.volume.chapterCount, 60);
  assert.deepEqual(merged.chapters.map((chapter) => chapter.chapterNo), Array.from({ length: 60 }, (_item, index) => index + 1));
  assert.equal(merged.chapters.every((chapter) => chapter.craftBrief?.characterExecution?.cast?.length === 2), true);

  const validation = await new ValidateOutlineTool({
    character: { async findMany() { return [{ name: 'Lin', alias: ['L'] }]; } },
    volume: { async findUnique() { return null; } },
    chapter: { async findMany() { return []; } },
  } as never).run({ preview: merged }, toolContext);

  assert.equal(validation.valid, true, JSON.stringify(validation.issues));
  assert.equal(validation.stats.chapterCount, 60);
  assert.equal(validation.stats.craftBriefCount, 60);
  assert.equal(validation.stats.chapterCharacterExecutionCount, 60);
  assert.equal(validation.writePreview?.summary.createCount, 60);
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
