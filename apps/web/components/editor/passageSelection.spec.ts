import assert from 'node:assert/strict';
import {
  buildPassageAgentContext,
  computeSelectedParagraphRange,
  getPassageAgentDisabledReason,
  normalizeTextSelection,
} from './passageSelection';

type TestCase = { name: string; run: () => void };
const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

test('normalizeTextSelection rejects empty or whitespace-only selections', () => {
  assert.equal(normalizeTextSelection(0, 0, '第一段'), null);
  assert.equal(normalizeTextSelection(1, 4, 'a   b'), null);
});

test('computeSelectedParagraphRange counts non-empty paragraphs across multi-paragraph selections', () => {
  const content = ['第一段文字', '', '第二段文字', '第三段文字'].join('\n');
  const start = content.indexOf('第二段');
  const end = content.indexOf('第三段') + '第三段文字'.length;

  assert.deepEqual(computeSelectedParagraphRange(content, { start, end }), { start: 2, end: 3, count: 2 });
});

test('normalizeTextSelection returns exact range text and paragraph metadata', () => {
  const content = '第一段文字\n\n第二段文字\n第三段文字';
  const start = content.indexOf('第二段');
  const end = content.indexOf('第三段') + '第三段文字'.length;
  const selection = normalizeTextSelection(start, end, content);

  assert.deepEqual(selection?.selectedRange, { start, end });
  assert.equal(selection?.selectedText, '第二段文字\n第三段文字');
  assert.deepEqual(selection?.selectedParagraphRange, { start: 2, end: 3, count: 2 });
});

test('buildPassageAgentContext includes project, volume, chapter, draft, range, and selected text', () => {
  const selection = normalizeTextSelection(2, 5, '前文选中文后文');
  assert.ok(selection);

  const context = buildPassageAgentContext({
    project: { id: 'project-1', title: '长夜', status: 'active' },
    volume: { id: 'volume-1', projectId: 'project-1', volumeNo: 2, title: '潮声', status: 'planned' },
    chapter: { id: 'chapter-1', volumeId: 'volume-1', chapterNo: 12, title: '回声' },
    draft: {
      id: 'draft-1',
      chapterId: 'chapter-1',
      versionNo: 4,
      content: '前文选中文后文',
      source: 'agent_write',
      isCurrent: true,
      createdAt: '2026-05-14T00:00:00.000Z',
    },
    draftViewMode: 'draft',
    selection,
  });

  assert.equal(context.sourcePage, 'editor_passage_agent');
  assert.equal(context.selectionIntent, 'chapter_passage_revision');
  assert.equal(context.currentProjectId, 'project-1');
  assert.equal(context.currentVolumeNo, 2);
  assert.equal(context.currentChapterNo, 12);
  assert.equal(context.currentDraftId, 'draft-1');
  assert.equal(context.currentDraftVersion, 4);
  assert.deepEqual(context.selectedRange, { start: 2, end: 5 });
  assert.equal(context.selectedText, '选中文');
});

test('getPassageAgentDisabledReason asks the user to save unsaved edits before sending selection context', () => {
  const reason = getPassageAgentDisabledReason({
    hasProject: true,
    hasChapter: true,
    hasDraft: true,
    hasSelection: true,
    hasUnsavedChanges: true,
    isGenerating: false,
    isAutoMaintaining: false,
    isSavingDraft: false,
    isMarkingComplete: false,
    hasSubmitHandler: true,
  });

  assert.match(reason, /保存/);
});

for (const item of tests) {
  item.run();
  console.log(`ok - ${item.name}`);
}
