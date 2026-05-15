import assert from 'node:assert/strict';
import { buildInlinePassageRevisionContextPatch, extractLatestPassageRevisionPreview } from './inlinePassageRevisionSession';

type TestCase = { name: string; run: () => void };
const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

test('extractLatestPassageRevisionPreview returns the latest passage preview artifact', () => {
  const preview = extractLatestPassageRevisionPreview({
    taskType: 'chapter_passage_revision',
    input: {},
    artifacts: [
      {
        id: 'artifact-1',
        artifactType: 'chapter_passage_revision_preview',
        content: {
          previewId: 'preview-1',
          chapterId: 'chapter-1',
          draftId: 'draft-1',
          draftVersion: 2,
          selectedRange: { start: 10, end: 20 },
          originalText: '旧文本',
          replacementText: '第一版预览',
          editSummary: 'first',
          preservedFacts: [],
          risks: [],
          validation: { valid: true, issues: [] },
        },
      },
      {
        id: 'artifact-2',
        artifactType: 'chapter_passage_revision_preview',
        content: {
          previewId: 'preview-2',
          chapterId: 'chapter-1',
          draftId: 'draft-1',
          draftVersion: 2,
          selectedRange: { start: 10, end: 20 },
          originalText: '旧文本',
          replacementText: '第二版预览',
          editSummary: 'second',
          preservedFacts: ['保留事实'],
          risks: [],
          validation: { valid: true, issues: [] },
        },
      },
    ],
  });

  assert.equal(preview?.previewId, 'preview-2');
  assert.equal(preview?.replacementText, '第二版预览');
});

test('buildInlinePassageRevisionContextPatch preserves passage preview context for follow-up feedback', () => {
  const patch = buildInlinePassageRevisionContextPatch({
    taskType: 'chapter_passage_revision',
    input: {
      context: {
        currentProjectId: 'project-1',
        currentChapterId: 'chapter-1',
        currentDraftId: 'draft-1',
        currentDraftVersion: 2,
        selectedText: '原选中文本',
        selectedRange: { start: 10, end: 20 },
        selectedParagraphRange: { start: 2, end: 2, count: 1 },
      },
    },
    artifacts: [
      {
        id: 'artifact-1',
        artifactType: 'chapter_passage_revision_preview',
        content: {
          previewId: 'preview-9',
          chapterId: 'chapter-1',
          draftId: 'draft-1',
          draftVersion: 2,
          selectedRange: { start: 10, end: 20 },
          originalText: '旧文本',
          replacementText: '新的局部修订',
          editSummary: 'summary',
          preservedFacts: [],
          risks: ['风险提示'],
          validation: { valid: true, issues: [] },
        },
      },
    ],
  });

  assert.deepEqual(patch?.selectedRange, { start: 10, end: 20 });
  assert.equal(patch?.passageRevision?.previewId, 'preview-9');
  assert.equal(patch?.passageRevision?.previousReplacementText, '新的局部修订');
  assert.deepEqual(patch?.passageRevision?.previousRisks, ['风险提示']);
});

for (const item of tests) {
  item.run();
  console.log(`ok - ${item.name}`);
}
