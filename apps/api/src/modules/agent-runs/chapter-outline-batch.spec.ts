import assert from 'node:assert/strict';
import {
  assertChapterRangeCoverage,
  type ChapterOutlineBatchPlan,
} from '../agent-tools/tools/chapter-outline-batch-contracts';

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
