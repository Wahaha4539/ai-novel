import assert from 'node:assert/strict';
import { ChaptersService } from './chapters.service';

type TestCase = { name: string; run: () => void | Promise<void> };

const tests: TestCase[] = [];

function test(name: string, run: TestCase['run']) {
  tests.push({ name, run });
}

function makeCache() {
  const deletedChapterContexts: Array<{ projectId: string; chapterId: string }> = [];
  const deletedRecallProjects: string[] = [];
  const updatedChapterContexts: Array<{ projectId: string; chapterId: string; context: unknown }> = [];

  return {
    deletedChapterContexts,
    deletedRecallProjects,
    updatedChapterContexts,
    async setChapterContext(projectId: string, chapterId: string, context: unknown) {
      updatedChapterContexts.push({ projectId, chapterId, context });
    },
    async deleteChapterContext(projectId: string, chapterId: string) {
      deletedChapterContexts.push({ projectId, chapterId });
    },
    async deleteProjectRecallResults(projectId: string) {
      deletedRecallProjects.push(projectId);
    },
  };
}

test('ChaptersService.removeMany rejects empty chapter id lists', async () => {
  const service = new ChaptersService({} as any, makeCache() as any);

  await assert.rejects(
    () => service.removeMany('project-1', []),
    /请选择要删除的章节/,
  );
});

test('ChaptersService.updateDraftContent rejects blank manual content', async () => {
  const service = new ChaptersService({} as any, makeCache() as any);

  await assert.rejects(
    () => service.updateDraftContent('chapter-1', 'draft-1', '   \n\t'),
    /正文内容不能为空/,
  );
});

test('ChaptersService.updateDraftContent saves directly into the selected draft and marks it current', async () => {
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const existingDraft = {
    id: 'draft-polished',
    chapterId: 'chapter-1',
    versionNo: 2,
    content: '旧润色正文',
    source: 'agent_polish',
    modelInfo: {},
    generationContext: { type: 'polish', originalDraftId: 'draft-raw' },
    isCurrent: false,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    chapter: { id: 'chapter-1', projectId: 'project-1' },
  };
  const tx = {
    chapterDraft: {
      async updateMany(args: any) {
        calls.push({ model: 'chapterDraft', method: 'updateMany', args });
        return { count: 1 };
      },
      async update(args: any) {
        calls.push({ model: 'chapterDraft', method: 'update', args });
        return {
          ...existingDraft,
          content: args.data.content,
          generationContext: args.data.generationContext,
          isCurrent: args.data.isCurrent,
        };
      },
    },
    chapter: {
      async update(args: any) {
        calls.push({ model: 'chapter', method: 'update', args });
        return { id: 'chapter-1' };
      },
    },
  };
  const prisma = {
    chapterDraft: {
      async findFirst(args: any) {
        calls.push({ model: 'chapterDraft', method: 'findFirst', args });
        return existingDraft;
      },
    },
    chapter: {
      async findUnique() {
        return {
          id: 'chapter-1',
          projectId: 'project-1',
          chapterNo: 1,
          title: '第一章',
          objective: null,
          conflict: null,
          outline: null,
          expectedWordCount: null,
          status: 'drafted',
          actualWordCount: 6,
        };
      },
    },
    character: {
      async findMany() {
        return [];
      },
    },
    async $transaction(callback: (transaction: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  };
  const cache = makeCache();
  const service = new ChaptersService(prisma as any, cache as any);

  const result = await service.updateDraftContent('chapter-1', 'draft-polished', '外部润色正文');

  assert.equal(result.content, '外部润色正文');
  assert.equal(result.isCurrent, true);
  assert.deepEqual(
    calls.find((item) => item.model === 'chapterDraft' && item.method === 'updateMany')?.args,
    { where: { chapterId: 'chapter-1', isCurrent: true, id: { not: 'draft-polished' } }, data: { isCurrent: false } },
  );
  assert.equal(
    calls.find((item) => item.model === 'chapter' && item.method === 'update')?.args.data.actualWordCount,
    '外部润色正文'.replace(/\s/g, '').length,
  );
  assert.equal(
    calls.find((item) => item.model === 'chapterDraft' && item.method === 'update')?.args.data.generationContext.type,
    'polish',
  );
  assert.equal(
    calls.find((item) => item.model === 'chapterDraft' && item.method === 'update')?.args.data.generationContext.manualEdited,
    true,
  );
  assert.equal(cache.updatedChapterContexts.length, 1);
  assert.deepEqual(cache.deletedRecallProjects, ['project-1']);
});

test('ChaptersService.removeMany rejects missing chapters instead of silently ignoring them', async () => {
  const prisma = {
    chapter: {
      async findMany() {
        return [{ id: 'chapter-1', chapterNo: 1, title: '第一章' }];
      },
    },
  };
  const service = new ChaptersService(prisma as any, makeCache() as any);

  await assert.rejects(
    () => service.removeMany('project-1', ['chapter-1', 'chapter-missing']),
    /章节不存在或不属于当前项目：chapter-missing/,
  );
});

test('ChaptersService.removeMany deletes selected chapters and clears chapter-scoped data', async () => {
  const deletes: Array<{ model: string; args: unknown }> = [];
  const ids = ['chapter-1', 'chapter-2'];
  const makeModel = (model: string, count: number) => ({
    async deleteMany(args: unknown) {
      deletes.push({ model, args });
      return { count };
    },
  });
  const tx = {
    qualityReport: makeModel('qualityReport', 1),
    validationIssue: makeModel('validationIssue', 2),
    memoryChunk: makeModel('memoryChunk', 3),
    timelineEvent: makeModel('timelineEvent', 4),
    sceneCard: makeModel('sceneCard', 5),
    pacingBeat: makeModel('pacingBeat', 6),
    generationJob: makeModel('generationJob', 7),
    chapter: makeModel('chapter', 2),
  };
  const prisma = {
    chapter: {
      async findMany() {
        return [
          { id: 'chapter-1', chapterNo: 1, title: '第一章' },
          { id: 'chapter-2', chapterNo: 2, title: '第二章' },
        ];
      },
    },
    async $transaction(callback: (transaction: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  };
  const cache = makeCache();
  const service = new ChaptersService(prisma as any, cache as any);

  const result = await service.removeMany('project-1', ids);

  assert.equal(result.deleted, true);
  assert.equal(result.deletedCount, 2);
  assert.deepEqual(result.chapterIds, ids);
  assert.deepEqual(
    deletes.find((item) => item.model === 'memoryChunk')?.args,
    { where: { projectId: 'project-1', sourceType: 'chapter', sourceId: { in: ids } } },
  );
  assert.deepEqual(
    deletes.find((item) => item.model === 'chapter')?.args,
    { where: { projectId: 'project-1', id: { in: ids } } },
  );
  assert.deepEqual(cache.deletedChapterContexts, [
    { projectId: 'project-1', chapterId: 'chapter-1' },
    { projectId: 'project-1', chapterId: 'chapter-2' },
  ]);
  assert.deepEqual(cache.deletedRecallProjects, ['project-1']);
});

void (async () => {
  for (const item of tests) {
    await item.run();
    console.log(`✓ ${item.name}`);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
