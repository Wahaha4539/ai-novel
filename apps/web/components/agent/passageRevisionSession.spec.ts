import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPassageRevisionContextPatch } from './passageRevisionSession';

test('buildPassageRevisionContextPatch keeps the selected passage and latest preview for replan', () => {
  const contextPatch = buildPassageRevisionContextPatch({
    taskType: 'chapter_passage_revision',
    input: {
      context: {
        currentProjectId: 'project-1',
        currentChapterId: 'chapter-1',
        currentDraftId: 'draft-3',
        currentDraftVersion: 7,
        selectedText: '她按住门框，没有立刻回答。',
        selectedRange: { start: 42, end: 55 },
        selectedParagraphRange: { start: 6, end: 6, count: 1 },
        sourcePage: 'editor_passage_agent',
        selectionIntent: 'chapter_passage_revision',
      },
    },
    artifacts: [
      {
        id: 'artifact-old',
        artifactType: 'chapter_passage_revision_preview',
        content: {
          previewId: 'preview-1',
          chapterId: 'chapter-1',
          draftId: 'draft-3',
          draftVersion: 7,
          selectedRange: { start: 42, end: 55 },
          originalText: '她按住门框，没有立刻回答。',
          replacementText: '她按住门框，沉默了一拍。',
          editSummary: '第一版。',
          preservedFacts: [],
          risks: ['旧风险'],
          validation: { valid: true, issues: [] },
        },
      },
      {
        id: 'artifact-new',
        artifactType: 'chapter_passage_revision_preview',
        content: {
          previewId: 'preview-2',
          chapterId: 'chapter-1',
          draftId: 'draft-3',
          draftVersion: 7,
          selectedRange: { start: 42, end: 55 },
          originalText: '她按住门框，没有立刻回答。',
          replacementText: '她按住门框，只沉默了一瞬。',
          editSummary: '第二版。',
          preservedFacts: ['仍站在门边'],
          risks: ['后句衔接需注意'],
          validation: { valid: true, issues: [] },
        },
      },
    ],
  } as never);

  assert.deepEqual(contextPatch, {
    currentProjectId: 'project-1',
    currentChapterId: 'chapter-1',
    currentDraftId: 'draft-3',
    currentDraftVersion: 7,
    selectedText: '她按住门框，没有立刻回答。',
    selectedRange: { start: 42, end: 55 },
    selectedParagraphRange: { start: 6, end: 6, count: 1 },
    selectionIntent: 'chapter_passage_revision',
    sourcePage: 'editor_passage_agent',
    passageRevision: {
      previewId: 'preview-2',
      previousReplacementText: '她按住门框，只沉默了一瞬。',
      previousEditSummary: '第二版。',
      previousRisks: ['后句衔接需注意'],
    },
  });
});

test('buildPassageRevisionContextPatch skips non-passage runs or incomplete selections', () => {
  assert.equal(buildPassageRevisionContextPatch({
    taskType: 'chapter_revision',
    input: { context: { selectedText: 'foo', selectedRange: { start: 0, end: 3 }, currentDraftId: 'draft-1', currentDraftVersion: 1 } },
    artifacts: [],
  } as never), undefined);

  assert.equal(buildPassageRevisionContextPatch({
    taskType: 'chapter_passage_revision',
    input: { context: { currentDraftId: 'draft-1', currentDraftVersion: 1 } },
    artifacts: [],
  } as never), undefined);
});
