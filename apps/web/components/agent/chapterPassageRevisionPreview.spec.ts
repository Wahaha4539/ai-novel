import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPassageDiffSegments,
  parseChapterPassageRevisionPreview,
} from './chapterPassageRevisionPreview';

test('parseChapterPassageRevisionPreview keeps passage fields needed by the artifact panel', () => {
  const preview = parseChapterPassageRevisionPreview({
    previewId: 'preview-1',
    chapterId: 'chapter-7',
    draftId: 'draft-9',
    draftVersion: 4,
    selectedRange: { start: 12, end: 24 },
    selectedParagraphRange: { start: 3, end: 4 },
    originalText: '原句保持节奏。',
    replacementText: '新的表达更紧一些。',
    editSummary: '压缩解释，保留事实。',
    preservedFacts: ['人物仍在雨夜对峙'],
    risks: ['后一句承接仍需人工确认'],
    validation: { valid: true, issues: ['语气更冷硬'] },
  });

  assert.ok(preview);
  assert.equal(preview?.previewId, 'preview-1');
  assert.equal(preview?.draftVersion, 4);
  assert.deepEqual(preview?.selectedRange, { start: 12, end: 24 });
  assert.deepEqual(preview?.selectedParagraphRange, { start: 3, end: 4, count: 2 });
  assert.equal(preview?.editSummary, '压缩解释，保留事实。');
  assert.deepEqual(preview?.preservedFacts, ['人物仍在雨夜对峙']);
  assert.deepEqual(preview?.validation, { valid: true, issues: ['语气更冷硬'] });
});

test('parseChapterPassageRevisionPreview rejects incomplete preview payloads', () => {
  assert.equal(parseChapterPassageRevisionPreview({
    chapterId: 'chapter-7',
    draftId: 'draft-9',
    draftVersion: 4,
    selectedRange: { start: 12, end: 24 },
    originalText: '原句保持节奏。',
    replacementText: '',
    editSummary: '压缩解释，保留事实。',
    validation: { valid: true, issues: [] },
  }), null);
});

test('buildPassageDiffSegments highlights removals, additions, and preserved text', () => {
  const segments = buildPassageDiffSegments('她握紧门把，停了一秒，才开口。', '她握紧门把，只停了一瞬，才开口。');

  assert.ok(segments.some((segment) => segment.type === 'remove'));
  assert.ok(segments.some((segment) => segment.type === 'add'));
  assert.equal(
    segments.filter((segment) => segment.type !== 'add').map((segment) => segment.text).join(''),
    '她握紧门把，停了一秒，才开口。',
  );
  assert.equal(
    segments.filter((segment) => segment.type !== 'remove').map((segment) => segment.text).join(''),
    '她握紧门把，只停了一瞬，才开口。',
  );
});
