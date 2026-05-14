import assert from 'node:assert/strict';
import type { ChapterDraft } from '../../types/dashboard';
import { buildDraftViewPair, isPolishedDraft, resolvePreferredDraftViewMode } from './draftVersionState';

type TestCase = { name: string; run: () => void };
const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

function createDraft(input: Partial<ChapterDraft> & Pick<ChapterDraft, 'id' | 'chapterId' | 'versionNo' | 'content' | 'source' | 'isCurrent' | 'createdAt'>): ChapterDraft {
  return {
    modelInfo: {},
    generationContext: {},
    ...input,
  };
}

test('isPolishedDraft only marks AI polish outputs as polished', () => {
  assert.equal(isPolishedDraft(createDraft({
    id: 'draft',
    chapterId: 'chapter-1',
    versionNo: 1,
    content: '原稿',
    source: 'agent_write',
    isCurrent: true,
    createdAt: '2026-05-15T00:00:00.000Z',
  })), false);

  assert.equal(isPolishedDraft(createDraft({
    id: 'polished',
    chapterId: 'chapter-1',
    versionNo: 2,
    content: '润色稿',
    source: 'agent_polish',
    isCurrent: true,
    createdAt: '2026-05-15T00:00:00.000Z',
  })), true);
});

test('resolvePreferredDraftViewMode stays on current manuscript when a stale polished branch exists', () => {
  const pair = buildDraftViewPair([
    createDraft({
      id: 'draft-current',
      chapterId: 'chapter-1',
      versionNo: 3,
      content: '局部修订后当前稿',
      source: 'agent_passage_revision',
      isCurrent: true,
      createdAt: '2026-05-15T00:00:00.000Z',
      generationContext: { type: 'passage_revision', originalDraftId: 'draft-polished' },
    }),
    createDraft({
      id: 'draft-polished',
      chapterId: 'chapter-1',
      versionNo: 2,
      content: '旧润色稿',
      source: 'agent_polish',
      isCurrent: false,
      createdAt: '2026-05-14T00:00:00.000Z',
      generationContext: { type: 'polish', originalDraftId: 'draft-raw' },
    }),
    createDraft({
      id: 'draft-raw',
      chapterId: 'chapter-1',
      versionNo: 1,
      content: '原始草稿',
      source: 'agent_write',
      isCurrent: false,
      createdAt: '2026-05-13T00:00:00.000Z',
    }),
  ]);

  assert.equal(pair.current?.id, 'draft-current');
  assert.equal(pair.draft?.id, 'draft-raw');
  assert.equal(pair.polished?.id, 'draft-polished');
  assert.equal(resolvePreferredDraftViewMode(pair), 'draft');
});

test('resolvePreferredDraftViewMode opens the polished tab only when the current row is itself polished', () => {
  const pair = buildDraftViewPair([
    createDraft({
      id: 'draft-polished-current',
      chapterId: 'chapter-1',
      versionNo: 2,
      content: '当前润色稿',
      source: 'agent_polish',
      isCurrent: true,
      createdAt: '2026-05-15T00:00:00.000Z',
      generationContext: { type: 'polish', originalDraftId: 'draft-raw' },
    }),
    createDraft({
      id: 'draft-raw',
      chapterId: 'chapter-1',
      versionNo: 1,
      content: '原始草稿',
      source: 'agent_write',
      isCurrent: false,
      createdAt: '2026-05-14T00:00:00.000Z',
    }),
  ]);

  assert.equal(pair.current?.id, 'draft-polished-current');
  assert.equal(resolvePreferredDraftViewMode(pair), 'polished');
});

for (const item of tests) {
  item.run();
  console.log(`ok - ${item.name}`);
}
