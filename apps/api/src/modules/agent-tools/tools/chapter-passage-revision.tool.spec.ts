import assert from 'node:assert/strict';
import { ApplyChapterPassageRevisionTool, ReviseChapterPassagePreviewTool } from './chapter-passage-revision.tool';
import type { ToolContext } from '../base-tool';

type TestCase = { name: string; run: () => void | Promise<void> };

const tests: TestCase[] = [];

function test(name: string, run: () => void | Promise<void>) {
  tests.push({ name, run });
}

const originalText = '他停在门前，握紧钥匙。';
const draftContent = `前一段把夜色压低。\n\n${originalText}\n\n后一段传来脚步声。`;
const selectedRange = {
  start: draftContent.indexOf(originalText),
  end: draftContent.indexOf(originalText) + originalText.length,
};

const validChecks = {
  followsInstruction: true,
  preservesRequiredFacts: true,
  keepsCharacterVoice: true,
  fitsLocalContext: true,
  replacementIsConcrete: true,
  noUnexpectedPlotRewrite: true,
};

const baseInput = {
  chapterId: 'chapter-1',
  draftId: 'draft-1',
  draftVersion: 3,
  selectedRange,
  selectedParagraphRange: { start: 2, end: 2, count: 1 },
  originalText,
  instruction: '压缩节奏，保留事实',
};

const toolContext: ToolContext = {
  agentRunId: 'run-1',
  projectId: 'project-1',
  chapterId: 'chapter-1',
  mode: 'plan',
  approved: false,
  outputs: {},
  policy: {},
};

const applyContext: ToolContext = {
  ...toolContext,
  mode: 'act',
  approved: true,
  userId: 'user-1',
};

function createPrisma(content = draftContent, versionNo = 3) {
  return {
    chapterDraft: {
      async findUnique(args: unknown) {
        assert.deepEqual(args, {
          where: { id: 'draft-1' },
          include: { chapter: { include: { volume: true } } },
        });
        return {
          id: 'draft-1',
          chapterId: 'chapter-1',
          versionNo,
          content,
          chapter: {
            id: 'chapter-1',
            projectId: 'project-1',
            volumeId: 'volume-1',
            chapterNo: 7,
            title: '雨夜',
            objective: '逼近真相',
            conflict: '门内有人隐瞒',
            outline: '角色在门前犹豫后进入。',
            craftBrief: { actionBeats: ['停在门前', '听见脚步'] },
            volume: {
              id: 'volume-1',
              volumeNo: 1,
              title: '第一卷',
              synopsis: '城中迷案。',
              objective: '揭开旧案。',
              narrativePlan: {},
            },
          },
        };
      },
    },
    character: {
      async findMany() {
        return [{ name: '林岫', roleType: 'lead', personalityCore: '克制', motivation: '查明真相', speechStyle: '短句' }];
      },
    },
  };
}

function createCache() {
  const deletedRecallProjects: string[] = [];
  return {
    deletedRecallProjects,
    async deleteProjectRecallResults(projectId: string) {
      deletedRecallProjects.push(projectId);
    },
  };
}

function successRevision(text = '他在门前停住，钥匙硌进掌心。') {
  return {
    replacementText: text,
    editSummary: '压缩动作并保留门前犹豫。',
    preservedFacts: ['角色停在门前', '钥匙仍在手中'],
    risks: [],
  };
}

function validReview() {
  return { valid: true, issues: [], checks: validChecks };
}

function invalidReview(message = 'The replacement drifts away from the selected passage.') {
  return { valid: false, issues: [{ severity: 'error', message }], checks: { ...validChecks, fitsLocalContext: false } };
}

function createLlm(responses: Array<unknown | Error>) {
  const calls: Array<{ messages: unknown; options: Record<string, unknown> }> = [];
  return {
    calls,
    async chatJson(messages: unknown, options: Record<string, unknown>) {
      calls.push({ messages, options });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error('Unexpected LLM call');
      return {
        data: response,
        result: { text: JSON.stringify(response), model: 'mock-model', usage: { total_tokens: 10 }, elapsedMs: 1 },
      };
    },
  };
}

function createTool(prisma = createPrisma(), llm = createLlm([successRevision(), validReview()])) {
  return { tool: new ReviseChapterPassagePreviewTool(prisma as never, llm as never), llm };
}

function createApplyPreview(overrides: Partial<{
  previewId: string;
  chapterId: string;
  draftId: string;
  draftVersion: number;
  selectedRange: typeof selectedRange;
  selectedParagraphRange: { start: number; end: number; count: number };
  originalText: string;
  replacementText: string;
  editSummary: string;
  preservedFacts: string[];
  risks: string[];
}> = {}) {
  return {
    previewId: 'preview-1',
    chapterId: 'chapter-1',
    draftId: 'draft-1',
    draftVersion: 3,
    selectedRange,
    selectedParagraphRange: { start: 2, end: 2, count: 1 },
    originalText,
    replacementText: '他在门前停住，钥匙冷得扎手。',
    editSummary: '压紧动作并保留门前犹豫。',
    preservedFacts: ['角色仍停在门前'],
    risks: [],
    ...overrides,
  };
}

function countChineseLikeWords(content: string) {
  const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return cjk + words;
}

function createApplyPrisma(options: {
  previewDraftContent?: string;
  previewDraftVersion?: number;
  previewDraftId?: string;
  currentDraftContent?: string;
  currentDraftVersion?: number;
  currentDraftId?: string;
} = {}) {
  const calls: Array<{ model: string; method: string; args: any }> = [];
  const previewDraft = {
    id: options.previewDraftId ?? 'draft-1',
    chapterId: 'chapter-1',
    versionNo: options.previewDraftVersion ?? 3,
    content: options.previewDraftContent ?? draftContent,
    createdBy: 'user-preview',
    chapter: {
      id: 'chapter-1',
      projectId: 'project-1',
      volumeId: 'volume-1',
      chapterNo: 7,
      title: '雨夜',
      objective: '逼近真相',
      conflict: '门内有人隐瞒',
      outline: '角色在门前犹豫后进入。',
      craftBrief: { actionBeats: ['停在门前', '听见脚步'] },
      volume: {
        id: 'volume-1',
        volumeNo: 1,
        title: '第一卷',
        synopsis: '城中迷案。',
        objective: '揭开旧案。',
        narrativePlan: {},
      },
    },
  };
  const currentDraft = {
    id: options.currentDraftId ?? previewDraft.id,
    chapterId: 'chapter-1',
    versionNo: options.currentDraftVersion ?? previewDraft.versionNo,
    content: options.currentDraftContent ?? previewDraft.content,
    createdBy: 'user-current',
  };
  const latestDraft = {
    id: currentDraft.id,
    chapterId: 'chapter-1',
    versionNo: currentDraft.versionNo,
    content: currentDraft.content,
    createdBy: currentDraft.createdBy,
  };

  const tx = {
    chapterDraft: {
      async findFirst(args: any) {
        calls.push({ model: 'chapterDraft', method: 'tx.findFirst', args });
        if (args.where?.chapterId === 'chapter-1' && args.where?.isCurrent) {
          return { ...currentDraft };
        }
        if (args.where?.chapterId === 'chapter-1') {
          return { ...latestDraft };
        }
        return null;
      },
      async updateMany(args: any) {
        calls.push({ model: 'chapterDraft', method: 'updateMany', args });
        return { count: 1 };
      },
      async create(args: any) {
        calls.push({ model: 'chapterDraft', method: 'create', args });
        return {
          id: 'draft-4',
          chapterId: args.data.chapterId,
          versionNo: args.data.versionNo,
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
      async findUnique(args: any) {
        calls.push({ model: 'chapterDraft', method: 'findUnique', args });
        return { ...previewDraft };
      },
      async findFirst(args: any) {
        calls.push({ model: 'chapterDraft', method: 'findFirst', args });
        if (args.where?.chapterId === 'chapter-1' && args.where?.isCurrent) {
          return { ...currentDraft };
        }
        return null;
      },
    },
    chapter: {
      async update(args: any) {
        calls.push({ model: 'chapter', method: 'root.update', args });
        return { id: 'chapter-1' };
      },
    },
    async $transaction(callback: (transaction: typeof tx) => Promise<unknown>) {
      return callback(tx);
    },
  };

  return { prisma, calls };
}

function createApplyTool(
  prismaSetup = createApplyPrisma(),
  cache = createCache(),
) {
  return {
    tool: new ApplyChapterPassageRevisionTool(prismaSetup.prisma as never, cache as never),
    cache,
    calls: prismaSetup.calls,
  };
}

test('revise_chapter_passage_preview returns a strict local preview', async () => {
  const { tool, llm } = createTool();
  const output = await tool.run(baseInput, toolContext);

  assert.equal(output.chapterId, 'chapter-1');
  assert.equal(output.draftId, 'draft-1');
  assert.equal(output.draftVersion, 3);
  assert.deepEqual(output.selectedRange, selectedRange);
  assert.equal(output.originalText, originalText);
  assert.equal(output.replacementText, '他在门前停住，钥匙硌进掌心。');
  assert.equal(output.validation.valid, true);
  assert.equal(llm.calls.length, 2);
  assert.equal(llm.calls[0].options.appStep, 'revise_chapter_passage_preview');
  assert.equal(llm.calls[1].options.appStep, 'revise_chapter_passage_quality_review');
});

test('revise_chapter_passage_preview forwards previous preview context for follow-up feedback', async () => {
  const { tool, llm } = createTool();
  await tool.run({
    ...baseInput,
    instruction: '保留第二句，其他重写。',
    context: {
      previousPreview: {
        previewId: 'preview-2',
        replacementText: '他停在门前，钥匙冷得扎手。第二句保留。',
        editSummary: '上一版更冷硬。',
        risks: ['第二句和后文衔接偏硬'],
      },
    },
  }, toolContext);

  const payload = JSON.parse((llm.calls[0].messages as Array<{ role: string; content: string }>)[1].content) as Record<string, any>;
  assert.deepEqual(payload.localContext.previousPreview, {
    previewId: 'preview-2',
    replacementText: '他停在门前，钥匙冷得扎手。第二句保留。',
    editSummary: '上一版更冷硬。',
    risks: ['第二句和后文衔接偏硬'],
  });
});

test('revise_chapter_passage_preview accepts legacy previous preview aliases during follow-up feedback', async () => {
  const { tool, llm } = createTool();
  await tool.run({
    ...baseInput,
    context: {
      previousPreview: {
        previewId: 'preview-legacy',
        previousReplacementText: '他没有立刻开门，钥匙在掌心里冰得生疑。',
        previousEditSummary: '旧版预览。',
        previousRisks: ['衔接偏冷'],
      },
    },
  }, toolContext);

  const payload = JSON.parse((llm.calls[0].messages as Array<{ role: string; content: string }>)[1].content) as Record<string, any>;
  assert.deepEqual(payload.localContext.previousPreview, {
    previewId: 'preview-legacy',
    replacementText: '他没有立刻开门，钥匙在掌心里冰得生疑。',
    editSummary: '旧版预览。',
    risks: ['衔接偏冷'],
  });
});

test('revise_chapter_passage_preview throws when LLM generation fails', async () => {
  const llm = createLlm([new Error('LLM timeout')]);
  const { tool } = createTool(createPrisma(), llm);

  await assert.rejects(() => tool.run(baseInput, toolContext), /LLM timeout/);
  assert.equal(llm.calls.length, 1);
});

test('revise_chapter_passage_preview throws when LLM output misses required fields', async () => {
  const llm = createLlm([{ editSummary: 'missing replacement', preservedFacts: [], risks: [] }]);
  const { tool } = createTool(createPrisma(), llm);

  await assert.rejects(() => tool.run(baseInput, toolContext), /replacementText/);
  assert.equal(llm.calls.length, 1);
});

test('revise_chapter_passage_preview throws on selected range conflict before LLM calls', async () => {
  const llm = createLlm([successRevision(), validReview()]);
  const { tool } = createTool(createPrisma(draftContent.replace(originalText, '他已经推门进去。')), llm);

  await assert.rejects(() => tool.run(baseInput, toolContext), /reselect the passage|range/i);
  assert.equal(llm.calls.length, 0);
});

test('revise_chapter_passage_preview throws when replacementText is empty', async () => {
  const llm = createLlm([{ ...successRevision('   '), replacementText: '   ' }]);
  const { tool } = createTool(createPrisma(), llm);

  await assert.rejects(() => tool.run(baseInput, toolContext), /replacementText must not be empty/);
  assert.equal(llm.calls.length, 1);
});

test('revise_chapter_passage_preview retries once after quality failure and can recover', async () => {
  const llm = createLlm([
    successRevision('他忽然踹开门，冲进雨里。'),
    invalidReview('Unexpected plot rewrite.'),
    successRevision('他在门前停住，钥匙冷得扎手。'),
    validReview(),
  ]);
  const { tool } = createTool(createPrisma(), llm);

  const output = await tool.run(baseInput, toolContext);

  assert.equal(output.replacementText, '他在门前停住，钥匙冷得扎手。');
  assert.equal(output.validation.valid, true);
  assert.equal(llm.calls.length, 4);
});

test('revise_chapter_passage_preview throws after quality retry still fails', async () => {
  const llm = createLlm([
    successRevision('他忽然踹开门，冲进雨里。'),
    invalidReview('Unexpected plot rewrite.'),
    successRevision('他把整章所有线索都解释清楚。'),
    invalidReview('Still rewrites too much plot.'),
  ]);
  const { tool } = createTool(createPrisma(), llm);

  await assert.rejects(() => tool.run(baseInput, toolContext), /quality review failed/i);
  assert.equal(llm.calls.length, 4);
});

test('apply_chapter_passage_revision rejects plan mode', async () => {
  const { tool } = createApplyTool();

  await assert.rejects(
    () => tool.run({ preview: createApplyPreview() }, toolContext),
    /must run in act mode/i,
  );
});

test('apply_chapter_passage_revision rejects missing approval', async () => {
  const { tool } = createApplyTool();

  await assert.rejects(
    () => tool.run({ preview: createApplyPreview() }, { ...applyContext, approved: false }),
    /requires explicit user approval/i,
  );
});

test('apply_chapter_passage_revision rejects empty replacement text', async () => {
  const { tool } = createApplyTool();

  await assert.rejects(
    () => tool.run({ preview: createApplyPreview({ replacementText: '   ' }) }, applyContext),
    /replacementText/i,
  );
});

test('apply_chapter_passage_revision rejects when a newer current draft exists', async () => {
  const { tool } = createApplyTool(createApplyPrisma({
    currentDraftId: 'draft-2',
    currentDraftVersion: 4,
  }));

  await assert.rejects(
    () => tool.run({ preview: createApplyPreview() }, applyContext),
    /Draft version conflict/i,
  );
});

test('apply_chapter_passage_revision rejects when the selected range no longer matches the draft content', async () => {
  const changedContent = draftContent.replace(originalText, '他已经推门进去。');
  const { tool } = createApplyTool(createApplyPrisma({
    previewDraftContent: changedContent,
    currentDraftContent: changedContent,
  }));

  await assert.rejects(
    () => tool.run({ preview: createApplyPreview() }, applyContext),
    /reselect the passage|range/i,
  );
});

test('apply_chapter_passage_revision creates a new chapter draft version and marks the old one non-current', async () => {
  const cache = createCache();
  const prismaSetup = createApplyPrisma();
  const { tool, calls } = createApplyTool(prismaSetup, cache);

  const result = await tool.run({ preview: createApplyPreview() }, applyContext);

  const expectedContent = draftContent.replace(originalText, '他在门前停住，钥匙冷得扎手。');
  assert.equal(result.draftId, 'draft-4');
  assert.equal(result.chapterId, 'chapter-1');
  assert.equal(result.versionNo, 4);
  assert.equal(result.actualWordCount, countChineseLikeWords(expectedContent));
  assert.deepEqual(result.selectedRange, selectedRange);
  assert.equal(result.sourceDraftId, 'draft-1');
  assert.equal(result.sourceDraftVersion, 3);
  assert.equal(result.previewId, 'preview-1');
  assert.deepEqual(cache.deletedRecallProjects, ['project-1']);
  assert.deepEqual(
    calls.find((item) => item.model === 'chapterDraft' && item.method === 'updateMany')?.args,
    { where: { chapterId: 'chapter-1', isCurrent: true }, data: { isCurrent: false } },
  );
  const createCall = calls.find((item) => item.model === 'chapterDraft' && item.method === 'create');
  assert.equal(createCall?.args.data.versionNo, 4);
  assert.equal(createCall?.args.data.source, 'agent_passage_revision');
  assert.equal(createCall?.args.data.generationContext.type, 'passage_revision');
  assert.equal(createCall?.args.data.generationContext.originalDraftId, 'draft-1');
  assert.equal(createCall?.args.data.generationContext.originalDraftVersion, 3);
  assert.deepEqual(createCall?.args.data.generationContext.selectedRange, selectedRange);
  assert.equal(createCall?.args.data.generationContext.originalText, originalText);
  assert.equal(createCall?.args.data.generationContext.replacementText, '他在门前停住，钥匙冷得扎手。');
  assert.equal(createCall?.args.data.generationContext.editSummary, '压紧动作并保留门前犹豫。');
  assert.equal(
    calls.find((item) => item.model === 'chapter' && item.method === 'update')?.args.data.actualWordCount,
    countChineseLikeWords(expectedContent),
  );
});

async function main() {
  for (const item of tests) {
    await item.run();
    console.log(`ok ${item.name}`);
  }
  console.log(`chapter passage revision tool tests passed: ${tests.length}/${tests.length}`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
