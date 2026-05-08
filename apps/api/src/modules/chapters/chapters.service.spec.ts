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

  return {
    deletedChapterContexts,
    deletedRecallProjects,
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
