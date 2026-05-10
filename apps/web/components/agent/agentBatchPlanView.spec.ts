const assert = require('node:assert/strict');
const {
  chapterNosFromPlanStep,
  formatChapterProgress,
  outlineChapterCoverage,
  outlineChapterProgress,
} = require('./agentBatchPlanView');

const steps = [
  { stepNo: 1, tool: 'inspect_project_context', args: {} },
  { stepNo: 2, tool: 'segment_chapter_outline_batches', args: { volumeNo: 1, chapterCount: 8 } },
  { stepNo: 3, tool: 'generate_chapter_outline_batch_preview', args: { volumeNo: 1, chapterCount: 8, chapterRange: { start: 1, end: 4 } } },
  { stepNo: 4, tool: 'generate_chapter_outline_batch_preview', args: { volumeNo: 1, chapterCount: 8, chapterRange: { start: 5, end: 8 } } },
  { stepNo: 5, tool: 'merge_chapter_outline_batch_previews', args: { volumeNo: 1, chapterCount: 8 } },
];

assert.deepEqual(chapterNosFromPlanStep(steps[2]), [1, 2, 3, 4]);

const coverage = outlineChapterCoverage(steps);
assert.deepEqual(coverage?.visibleChapters, [1, 2, 3, 4, 5, 6, 7, 8]);
assert.equal(coverage?.totalChapters, 8);
assert.equal(coverage?.batchCount, 2);

const runSteps = [
  { id: 's3', stepNo: 3, planVersion: 1, mode: 'act', status: 'succeeded' },
  { id: 's4', stepNo: 4, planVersion: 1, mode: 'act', status: 'running' },
];
const progress = outlineChapterProgress(steps, runSteps, 1);
assert.deepEqual(progress?.generatedChapters, [1, 2, 3, 4]);
assert.equal(progress?.generatedCount, 4);
assert.equal(progress ? formatChapterProgress(progress) : '', '4/8');

const sixtyChapterSteps = [
  { stepNo: 1, tool: 'inspect_project_context', args: {} },
  { stepNo: 2, tool: 'segment_chapter_outline_batches', args: { volumeNo: 1, chapterCount: 60 } },
  ...Array.from({ length: 15 }, (_item, index) => {
    const start = index * 4 + 1;
    return {
      stepNo: index + 3,
      tool: 'generate_chapter_outline_batch_preview',
      args: { volumeNo: 1, chapterCount: 60, chapterRange: { start, end: start + 3 } },
    };
  }),
  { stepNo: 18, tool: 'merge_chapter_outline_batch_previews', args: { volumeNo: 1, chapterCount: 60 } },
];
const sixtyCoverage = outlineChapterCoverage(sixtyChapterSteps);
assert.equal(sixtyCoverage?.visibleChapters.length, 60);
assert.equal(sixtyCoverage?.visibleChapters[0], 1);
assert.equal(sixtyCoverage?.visibleChapters[59], 60);
assert.equal(sixtyCoverage?.batchCount, 15);

const sixtyProgress = outlineChapterProgress(
  sixtyChapterSteps,
  [
    { id: 'b1', stepNo: 3, planVersion: 1, mode: 'act', status: 'succeeded' },
    { id: 'b2', stepNo: 4, planVersion: 1, mode: 'act', status: 'succeeded' },
    { id: 'b3', stepNo: 5, planVersion: 1, mode: 'act', status: 'succeeded' },
  ],
  1,
);
assert.equal(sixtyProgress ? formatChapterProgress(sixtyProgress) : '', '12/60');

const storyUnitAwareRanges = [
  [1, 4],
  [5, 8],
  [9, 12],
  [13, 16],
  [17, 21],
  [22, 24],
  [25, 27],
  [28, 30],
  [31, 33],
  [34, 38],
  [39, 41],
  [42, 44],
  [45, 47],
  [48, 50],
  [51, 55],
  [56, 60],
];
const hintedSixtyChapterSteps = [
  { stepNo: 1, tool: 'inspect_project_context', args: {} },
  { stepNo: 2, tool: 'segment_chapter_outline_batches', args: { volumeNo: 1, chapterCount: 60 } },
  ...storyUnitAwareRanges.map(([start, end], index) => ({
    stepNo: index + 3,
    tool: 'generate_chapter_outline_batch_preview',
    args: { volumeNo: 1, chapterCount: 60, chapterRange: { start, end } },
  })),
  { stepNo: 19, tool: 'merge_chapter_outline_batch_previews', args: { volumeNo: 1, chapterCount: 60 } },
];
const hintedCoverage = outlineChapterCoverage(hintedSixtyChapterSteps);
assert.equal(hintedCoverage?.visibleChapters.length, 60);
assert.equal(hintedCoverage?.visibleChapters[0], 1);
assert.equal(hintedCoverage?.visibleChapters[59], 60);
assert.equal(hintedCoverage?.batchCount, 16);

const hintedProgress = outlineChapterProgress(
  hintedSixtyChapterSteps,
  [
    { id: 'hb1', stepNo: 3, planVersion: 1, mode: 'act', status: 'succeeded' },
    { id: 'hb2', stepNo: 4, planVersion: 1, mode: 'act', status: 'succeeded' },
    { id: 'hb3', stepNo: 5, planVersion: 1, mode: 'act', status: 'succeeded' },
  ],
  1,
);
assert.deepEqual(hintedProgress?.generatedChapters, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
assert.equal(hintedProgress ? formatChapterProgress(hintedProgress) : '', '12/60');

console.log('agentBatchPlanView tests passed');
