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

console.log('agentBatchPlanView tests passed');
