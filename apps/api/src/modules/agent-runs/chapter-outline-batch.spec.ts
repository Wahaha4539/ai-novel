import assert from 'node:assert/strict';
import type { ToolContext, ToolProgressPatch } from '../agent-tools/base-tool';
import {
  assertChapterRangeCoverage,
  type ChapterOutlineBatchPlan,
} from '../agent-tools/tools/chapter-outline-batch-contracts';
import { SegmentChapterOutlineBatchesTool } from '../agent-tools/tools/chapter-outline-batch-tools.tool';

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
      narrativePlan: { storyUnitPlan },
    }],
  };
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
