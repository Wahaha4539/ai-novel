import { StructuredLogger } from '../../../common/logging/structured-logger';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import type { LlmGatewayService } from '../../llm/llm-gateway.service';
import type { ToolContext } from '../base-tool';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import type { ChapterOutlineBatchQualityReview, ChapterRange } from './chapter-outline-batch-contracts';
import { asRecord, asRecordArray, positiveInt, text } from './chapter-outline-batch-contracts';
import { buildToolStreamProgressHeartbeat, streamPhaseTimeoutMs } from './llm-streaming';

export const CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;

const qualityReviewLogger = new StructuredLogger('ChapterOutlineQualityReview');

export interface ChapterOutlineQualityReviewOptions {
  task: string;
  target: Record<string, unknown>;
  output: unknown;
  volumeSummary: unknown;
  storyUnitSlice: unknown;
  characterSourceWhitelist: unknown;
  chapterRange?: ChapterRange;
  progressMessage: string;
  progressCurrent: number;
  progressTotal: number;
  usageStep: string;
  schemaName?: string;
  schemaDescription?: string;
}

export async function reviewChapterOutlineQuality(
  llm: LlmGatewayService,
  context: ToolContext,
  options: ChapterOutlineQualityReviewOptions,
): Promise<ChapterOutlineBatchQualityReview> {
  await context.updateProgress?.({
    phase: 'calling_llm',
    phaseMessage: options.progressMessage,
    progressCurrent: options.progressCurrent,
    progressTotal: options.progressTotal,
    timeoutMs: streamPhaseTimeoutMs(CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS),
  });
  const response = await llm.chatJson<unknown>(
    buildChapterOutlineQualityReviewMessages(options),
    {
      appStep: 'planner',
      timeoutMs: CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS,
      stream: true,
      streamIdleTimeoutMs: CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS,
      onStreamProgress: buildToolStreamProgressHeartbeat({
        context,
        logger: qualityReviewLogger,
        loggerEvent: 'chapter_outline_quality_review.stream_heartbeat_failed',
        phaseMessage: options.progressMessage,
        idleTimeoutMs: CHAPTER_OUTLINE_QUALITY_REVIEW_TIMEOUT_MS,
        progressCurrent: options.progressCurrent,
        progressTotal: options.progressTotal,
        metadata: { usageStep: options.usageStep, target: options.target },
      }),
      retries: 0,
      jsonMode: true,
      jsonSchema: buildChapterOutlineQualityReviewJsonSchema(options.schemaName, options.schemaDescription),
      temperature: 0,
    },
  );
  recordToolLlmUsage(context, options.usageStep, response.result);
  return normalizeChapterOutlineQualityReview(response.data, options.chapterRange);
}

export function buildChapterOutlineQualityReviewMessages(options: ChapterOutlineQualityReviewOptions): Array<{ role: 'system' | 'user'; content: string }> {
  return [
    {
      role: 'system',
      content: [
        'You are an expert Chinese web-novel outline quality reviewer.',
        'Judge semantic usability for drafting prose. Do not use keyword matching or regex-like heuristics; read the whole field in context.',
        'Return strict JSON only. No Markdown, comments, or prose.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: safeJson({
        task: options.task,
        target: options.target,
        rubric: buildChapterOutlineQualityRubric(),
        decisionRules: [
          'Return valid=false if any chapter has an error-level issue.',
          'Return error only when the issue would make the chapter hard to draft into concrete prose without inventing major missing action, obstacle, result, or continuity.',
          'Return warning for polish, minor repetition, weak style, or fixable wording that does not block drafting.',
          'Do not reject solely because a sentence contains abstract words; reject only if the whole field lacks concrete actor/action/object/obstacle/result in context.',
          'Do not rewrite content. Report specific failed points with chapterNo, path, message, suggestion, and short evidence.',
        ],
        volumeSummary: options.volumeSummary,
        storyUnitSlice: options.storyUnitSlice,
        characterSourceWhitelist: options.characterSourceWhitelist,
        outlineOutput: options.output,
        outputContract: {
          valid: 'boolean',
          summary: 'short string',
          issues: [
            {
              severity: 'error|warning',
              chapterNo: 'number optional',
              path: 'field path such as chapters[1].craftBrief.actionBeats[2]',
              message: 'what failed',
              suggestion: 'how the next generation should fix it',
              evidence: 'short quote or paraphrase from the failed field',
            },
          ],
        },
      }, 70000),
    },
  ];
}

export function buildChapterOutlineQualityRubric(): string[] {
  return [
    'Chapter outline: must contain a scene chain with who acts, where, visible action, resistance, turn/result, and chapter-end handoff. It may be concise, but cannot be only an intention or theme.',
    'Action beats: each beat should be executable as a drafting instruction. It needs a concrete actor plus visible action and object/target; at least one beat must show resistance and at least one must show resulting state change.',
    'Scene beats: each scene must be draftable without inventing its location, participants, visible action, obstacle, turning point, result, or sensory anchor.',
    'Conflict/obstacle: must identify who or what blocks the action and how the pressure appears on page.',
    'Continuity: entryState, exitState, handoffToNextChapter, openLoops, closedLoops, and continuityState must let adjacent chapters connect without guessing.',
    'Character execution: cast functions, actionBeatRefs, sceneBeatRefs, entryState, and exitState must match the chapter action. Temporary characters must remain one-off unless explicitly marked needs_approval upstream.',
    'Reject as error only for semantic gaps that would force the next writer/LLM to invent major missing plot action or continuity. Use warnings for weaker but still draftable writing.',
  ];
}

export function buildChapterOutlineQualityReviewJsonSchema(name = 'chapter_outline_quality_review', description = 'LLM semantic quality review for generated chapter outlines.'): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
  return {
    name,
    description,
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['valid', 'summary', 'issues'],
      properties: {
        valid: { type: 'boolean' },
        summary: { type: 'string' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'chapterNo', 'path', 'message', 'suggestion', 'evidence'],
            properties: {
              severity: { type: 'string', enum: ['warning', 'error'] },
              chapterNo: { type: ['integer', 'null'] },
              path: { type: ['string', 'null'] },
              message: { type: 'string' },
              suggestion: { type: ['string', 'null'] },
              evidence: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  };
}

export function normalizeChapterOutlineQualityReview(value: unknown, chapterRange?: ChapterRange): ChapterOutlineBatchQualityReview {
  const record = asRecord(value);
  if (typeof record.valid !== 'boolean') throw new Error('chapter outline quality review missing boolean valid.');
  if (typeof record.summary !== 'string' || !record.summary.trim()) throw new Error('chapter outline quality review missing summary.');
  if (!Array.isArray(record.issues)) throw new Error('chapter outline quality review missing issues array.');
  const issues = asRecordArray(record.issues).map((issue) => {
    const severity = issue.severity === 'error' ? 'error' as const : issue.severity === 'warning' ? 'warning' as const : undefined;
    if (!severity) throw new Error('chapter outline quality review issue.severity must be warning or error.');
    const chapterNo = positiveInt(issue.chapterNo);
    const message = text(issue.message);
    if (!message) throw new Error('chapter outline quality review issue.message is required.');
    return {
      severity,
      ...(chapterNo && (!chapterRange || (chapterNo >= chapterRange.start && chapterNo <= chapterRange.end)) ? { chapterNo } : {}),
      ...(text(issue.path) ? { path: text(issue.path) } : {}),
      message,
      ...(text(issue.suggestion) ? { suggestion: text(issue.suggestion) } : {}),
      ...(text(issue.evidence) ? { evidence: text(issue.evidence) } : {}),
    };
  });
  return {
    valid: record.valid && !issues.some((issue) => issue.severity === 'error'),
    summary: text(record.summary),
    issues,
  };
}

export function formatChapterOutlineQualityIssues(review: ChapterOutlineBatchQualityReview): string {
  return review.issues
    .filter((issue) => issue.severity === 'error')
    .map((issue) => `chapter ${issue.chapterNo ?? '?'}${issue.path ? ` ${issue.path}` : ''}: ${issue.message}`)
    .join('; ') || review.summary || 'unknown quality issue';
}

function safeJson(value: unknown, maxChars: number): string {
  const json = JSON.stringify(value);
  if (json.length <= maxChars) return json;
  return `${json.slice(0, maxChars)}...<truncated>`;
}
