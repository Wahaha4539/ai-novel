import assert from 'node:assert/strict';
import { ReviseChapterPassagePreviewTool } from './chapter-passage-revision.tool';
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
