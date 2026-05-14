import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';

const PASSAGE_REVISION_APP_STEP = 'revise_chapter_passage_preview';
const PASSAGE_REVISION_REVIEW_APP_STEP = 'revise_chapter_passage_quality_review';

interface TextRange {
  start: number;
  end: number;
}

interface SelectedParagraphRange {
  start: number;
  end: number;
  count?: number;
}

interface ReviseChapterPassagePreviewInput {
  chapterId?: string;
  draftId: string;
  draftVersion: number;
  selectedRange: TextRange;
  selectedParagraphRange?: SelectedParagraphRange;
  originalText: string;
  instruction: string;
  context?: {
    beforeText?: string;
    afterText?: string;
    chapterOutline?: string;
    craftBrief?: unknown;
    volumeSummary?: string;
    characterHints?: unknown[];
  };
}

interface PassageRevisionLlmOutput {
  replacementText: string;
  editSummary: string;
  preservedFacts: string[];
  risks: string[];
}

interface PassageRevisionQualityIssue {
  severity: 'error' | 'warning';
  message: string;
}

interface PassageRevisionQualityReview {
  valid: boolean;
  issues: PassageRevisionQualityIssue[];
  checks: {
    followsInstruction: boolean;
    preservesRequiredFacts: boolean;
    keepsCharacterVoice: boolean;
    fitsLocalContext: boolean;
    replacementIsConcrete: boolean;
    noUnexpectedPlotRewrite: boolean;
  };
}

interface ChapterPassageRevisionPreview {
  previewId: string;
  chapterId: string;
  draftId: string;
  draftVersion: number;
  selectedRange: TextRange;
  selectedParagraphRange?: SelectedParagraphRange;
  originalText: string;
  replacementText: string;
  editSummary: string;
  preservedFacts: string[];
  risks: string[];
  validation: {
    valid: boolean;
    issues: string[];
  };
}

interface ApplyChapterPassageRevisionInput {
  preview?: {
    previewId?: string;
    chapterId: string;
    draftId: string;
    draftVersion: number;
    selectedRange: TextRange;
    selectedParagraphRange?: SelectedParagraphRange;
    originalText: string;
    replacementText: string;
    editSummary: string;
    preservedFacts?: string[];
    risks?: string[];
    validation?: {
      valid: boolean;
      issues: string[];
    };
  };
}

interface ChapterPassageRevisionApplyResult {
  draftId: string;
  chapterId: string;
  versionNo: number;
  actualWordCount: number;
  selectedRange: TextRange;
  selectedParagraphRange?: SelectedParagraphRange;
  sourceDraftId: string;
  sourceDraftVersion: number;
  previewId?: string;
}

type LoadedDraft = {
  id: string;
  chapterId: string;
  versionNo: number;
  content: string;
  createdBy: string | null;
  chapter: {
    id: string;
    projectId: string;
    volumeId: string | null;
    chapterNo: number;
    title: string | null;
    objective: string | null;
    conflict: string | null;
    outline: string | null;
    craftBrief: Prisma.JsonValue;
    volume: {
      id: string;
      volumeNo: number;
      title: string | null;
      synopsis: string | null;
      objective: string | null;
      narrativePlan: Prisma.JsonValue;
    } | null;
  };
};

@Injectable()
export class ReviseChapterPassagePreviewTool implements BaseTool<ReviseChapterPassagePreviewInput, ChapterPassageRevisionPreview> {
  name = 'revise_chapter_passage_preview';
  description = 'Generate an approval-gated preview for replacing only the selected passage of a chapter draft. It never writes drafts.';
  inputSchema = {
    type: 'object' as const,
    required: ['chapterId', 'draftId', 'draftVersion', 'selectedRange', 'originalText', 'instruction'],
    additionalProperties: false,
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      draftId: { type: 'string' as const, minLength: 1 },
      draftVersion: { type: 'number' as const, minimum: 1, integer: true },
      selectedRange: {
        type: 'object' as const,
        required: ['start', 'end'],
        additionalProperties: false,
        properties: {
          start: { type: 'number' as const, minimum: 0, integer: true },
          end: { type: 'number' as const, minimum: 1, integer: true },
        },
      },
      selectedParagraphRange: {
        type: 'object' as const,
        required: ['start', 'end'],
        additionalProperties: false,
        properties: {
          start: { type: 'number' as const, minimum: 1, integer: true },
          end: { type: 'number' as const, minimum: 1, integer: true },
          count: { type: 'number' as const, minimum: 1, integer: true },
        },
      },
      originalText: { type: 'string' as const, minLength: 1 },
      instruction: { type: 'string' as const, minLength: 1 },
      context: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['previewId', 'chapterId', 'draftId', 'draftVersion', 'selectedRange', 'originalText', 'replacementText', 'editSummary', 'preservedFacts', 'risks', 'validation'],
    additionalProperties: false,
    properties: {
      previewId: { type: 'string' as const, minLength: 1 },
      chapterId: { type: 'string' as const, minLength: 1 },
      draftId: { type: 'string' as const, minLength: 1 },
      draftVersion: { type: 'number' as const, minimum: 1, integer: true },
      selectedRange: {
        type: 'object' as const,
        required: ['start', 'end'],
        additionalProperties: false,
        properties: {
          start: { type: 'number' as const, minimum: 0, integer: true },
          end: { type: 'number' as const, minimum: 1, integer: true },
        },
      },
      selectedParagraphRange: { type: 'object' as const },
      originalText: { type: 'string' as const, minLength: 1 },
      replacementText: { type: 'string' as const, minLength: 1 },
      editSummary: { type: 'string' as const, minLength: 1 },
      preservedFacts: { type: 'array' as const, items: { type: 'string' as const } },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
      validation: {
        type: 'object' as const,
        required: ['valid', 'issues'],
        additionalProperties: false,
        properties: {
          valid: { type: 'boolean' as const },
          issues: { type: 'array' as const, items: { type: 'string' as const } },
        },
      },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Selected passage revision preview',
    description: 'Creates a preview that replaces only the selected chapter draft range after deterministic draft/version/range checks and an LLM quality review.',
    whenToUse: [
      'The request comes from editor_passage_agent with selectionIntent=chapter_passage_revision, selectedText, selectedRange, currentDraftId, and currentDraftVersion.',
      'The user asks to polish, compress, change voice, reduce explanation, or otherwise revise only the selected passage.',
      'The user continues a passage-level revision conversation and the current selection context is still present.',
    ],
    whenNotToUse: [
      'Do not use for whole-chapter rewriting or whole-chapter polishing.',
      'Do not use if selectedRange, originalText, draftId, draftVersion, or chapterId is missing.',
      'Do not guess a replacement range when the draft text changed; let the tool fail and ask the user to reselect.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterId: { source: 'context', description: 'Use context.session.currentChapterId from editor passage selection.' },
      draftId: { source: 'context', description: 'Use context.session.currentDraftId from editor passage selection.' },
      draftVersion: { source: 'context', description: 'Use context.session.currentDraftVersion from editor passage selection.' },
      selectedRange: { source: 'context', description: 'Use context.session.selectedRange exactly; do not infer from text.' },
      originalText: { source: 'context', description: 'Use context.session.selectedText exactly.' },
      instruction: { source: 'user_message', description: 'The user requested passage-level change.' },
    },
    examples: [
      {
        user: '把选中的这一段压紧一点，但别改事实。',
        context: { sourcePage: 'editor_passage_agent', selectionIntent: 'chapter_passage_revision' },
        plan: [
          {
            tool: 'revise_chapter_passage_preview',
            args: {
              chapterId: '{{context.session.currentChapterId}}',
              draftId: '{{context.session.currentDraftId}}',
              draftVersion: '{{context.session.currentDraftVersion}}',
              selectedRange: '{{context.session.selectedRange}}',
              originalText: '{{context.session.selectedText}}',
              instruction: '{{context.userMessage}}',
            },
          },
        ],
      },
    ],
    failureHints: [
      { code: 'RANGE_CONFLICT', meaning: 'The current draft text no longer matches originalText at selectedRange.', suggestedRepair: 'Ask the user to save/reselect the passage and plan again.' },
      { code: 'QUALITY_REVIEW_FAILED', meaning: 'The LLM revision failed the semantic quality rubric after one retry.', suggestedRepair: 'Ask the user to narrow the range or clarify the passage-level instruction.' },
    ],
    artifactMapping: [{ outputPath: '$', artifactType: 'chapter_passage_revision_preview', title: '章节选区局部修订预览' }],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['chapterId', 'draftId'],
      allowedSources: ['context.session.currentChapterId', 'context.session.currentDraftId', 'runtime.currentChapterId', 'runtime.currentDraftId', 'resolve_chapter.output.chapterId', 'steps.resolve_chapter.output.chapterId'],
    },
  };

  constructor(private readonly prisma: PrismaService, private readonly llm: LlmGatewayService) {}

  async run(args: ReviseChapterPassagePreviewInput, context: ToolContext): Promise<ChapterPassageRevisionPreview> {
    const chapterId = args.chapterId ?? context.chapterId;
    if (!chapterId) throw new BadRequestException('revise_chapter_passage_preview requires chapterId.');
    this.assertNonEmptyString(args.draftId, 'draftId');
    this.assertPositiveInteger(args.draftVersion, 'draftVersion');
    this.assertNonEmptyString(args.instruction, 'instruction');
    this.assertNonEmptyString(args.originalText, 'originalText');

    const draft = await this.loadDraft(args.draftId);
    this.assertDraftMatchesRequest(draft, { ...args, chapterId }, context.projectId);
    this.assertRangeMatchesOriginalText(draft.content, args.selectedRange, args.originalText);

    const passageContext = await this.buildPassageContext(draft, args, context.projectId);
    let candidate = await this.generateRevision(args, draft, passageContext, context);
    let review = await this.reviewRevision(args, draft, passageContext, candidate, context);

    if (!review.valid) {
      candidate = await this.generateRevision(args, draft, passageContext, context, review);
      review = await this.reviewRevision(args, draft, passageContext, candidate, context);
      if (!review.valid) {
        throw new BadRequestException(`Passage revision quality review failed: ${this.formatReviewIssues(review)}`);
      }
    }

    return {
      previewId: randomUUID(),
      chapterId,
      draftId: draft.id,
      draftVersion: draft.versionNo,
      selectedRange: { start: args.selectedRange.start, end: args.selectedRange.end },
      ...(args.selectedParagraphRange ? { selectedParagraphRange: this.normalizeSelectedParagraphRange(args.selectedParagraphRange) } : {}),
      originalText: args.originalText,
      replacementText: candidate.replacementText,
      editSummary: candidate.editSummary,
      preservedFacts: candidate.preservedFacts,
      risks: candidate.risks,
      validation: {
        valid: review.valid,
        issues: review.issues.map((issue) => `[${issue.severity}] ${issue.message}`),
      },
    };
  }

  private async loadDraft(draftId: string): Promise<LoadedDraft> {
    const draft = await this.prisma.chapterDraft.findUnique({
      where: { id: draftId },
      include: {
        chapter: {
          include: {
            volume: true,
          },
        },
      },
    });
    if (!draft) throw new NotFoundException(`Chapter draft not found: ${draftId}`);
    return draft as LoadedDraft;
  }

  private assertDraftMatchesRequest(draft: LoadedDraft, args: ReviseChapterPassagePreviewInput & { chapterId: string }, projectId: string): void {
    if (draft.chapter.projectId !== projectId) {
      throw new BadRequestException('Draft does not belong to the current project.');
    }
    if (draft.chapterId !== args.chapterId) {
      throw new BadRequestException('Draft does not belong to the requested chapter.');
    }
    if (draft.versionNo !== args.draftVersion) {
      throw new BadRequestException(`Draft version conflict: current v${draft.versionNo}, requested v${args.draftVersion}.`);
    }
  }

  private assertRangeMatchesOriginalText(content: string, range: TextRange, originalText: string): void {
    this.assertValidRange(content, range);
    if (content.slice(range.start, range.end) !== originalText) {
      throw new BadRequestException('Selected range no longer matches the current draft. Please reselect the passage.');
    }
  }

  private assertValidRange(content: string, range: TextRange): void {
    this.assertPositiveInteger(range.end, 'selectedRange.end');
    if (!Number.isInteger(range.start) || range.start < 0) throw new BadRequestException('selectedRange.start must be a non-negative integer.');
    if (range.end <= range.start) throw new BadRequestException('selectedRange.end must be greater than selectedRange.start.');
    if (range.end > content.length) throw new BadRequestException('selectedRange is outside the current draft content.');
  }

  private async buildPassageContext(draft: LoadedDraft, args: ReviseChapterPassagePreviewInput, projectId: string) {
    const selectedRange = args.selectedRange;
    const computedParagraphRange = args.selectedParagraphRange ?? this.computeParagraphRange(draft.content, selectedRange);
    const nearbyParagraphs = this.nearbyParagraphs(draft.content, selectedRange, computedParagraphRange);
    const characters = await this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
      take: 20,
      select: { name: true, roleType: true, personalityCore: true, motivation: true, speechStyle: true },
    });
    return {
      beforeText: args.context?.beforeText ?? nearbyParagraphs.beforeText,
      afterText: args.context?.afterText ?? nearbyParagraphs.afterText,
      selectedParagraphRange: computedParagraphRange,
      chapter: {
        chapterNo: draft.chapter.chapterNo,
        title: draft.chapter.title,
        objective: draft.chapter.objective,
        conflict: draft.chapter.conflict,
        outline: args.context?.chapterOutline ?? draft.chapter.outline,
        craftBrief: args.context?.craftBrief ?? draft.chapter.craftBrief,
      },
      volume: {
        volumeNo: draft.chapter.volume?.volumeNo,
        title: draft.chapter.volume?.title,
        summary: args.context?.volumeSummary ?? draft.chapter.volume?.synopsis ?? draft.chapter.volume?.objective ?? null,
        narrativePlan: draft.chapter.volume?.narrativePlan ?? {},
      },
      characterHints: args.context?.characterHints ?? characters,
    };
  }

  private async generateRevision(
    args: ReviseChapterPassagePreviewInput,
    draft: LoadedDraft,
    passageContext: unknown,
    context: ToolContext,
    retryReview?: PassageRevisionQualityReview,
  ): Promise<PassageRevisionLlmOutput> {
    await context.updateProgress?.({
      phase: retryReview ? 'regenerating_passage_revision' : 'generating_passage_revision',
      phaseMessage: retryReview ? 'Regenerating selected passage revision after quality review feedback.' : 'Generating selected passage revision preview.',
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });
    const response = await this.llm.chatJson<unknown>(
      this.buildRevisionMessages(args, draft, passageContext, retryReview),
      {
        appStep: PASSAGE_REVISION_APP_STEP,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        retries: 0,
        jsonMode: true,
        jsonSchema: this.revisionJsonSchema(),
        temperature: retryReview ? 0.25 : 0.35,
        maxTokens: Math.min(6000, Math.max(1200, args.originalText.length * 3 + 1200)),
      },
    );
    recordToolLlmUsage(context, PASSAGE_REVISION_APP_STEP, response.result);
    return this.normalizeRevisionOutput(response.data);
  }

  private async reviewRevision(
    args: ReviseChapterPassagePreviewInput,
    draft: LoadedDraft,
    passageContext: unknown,
    candidate: PassageRevisionLlmOutput,
    context: ToolContext,
  ): Promise<PassageRevisionQualityReview> {
    await context.updateProgress?.({
      phase: 'reviewing_passage_revision',
      phaseMessage: 'Reviewing selected passage revision quality.',
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    });
    const response = await this.llm.chatJson<unknown>(
      this.buildQualityReviewMessages(args, draft, passageContext, candidate),
      {
        appStep: PASSAGE_REVISION_REVIEW_APP_STEP,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
        retries: 0,
        jsonMode: true,
        jsonSchema: this.qualityReviewJsonSchema(),
        temperature: 0,
        maxTokens: 2200,
      },
    );
    recordToolLlmUsage(context, PASSAGE_REVISION_REVIEW_APP_STEP, response.result);
    return this.normalizeQualityReview(response.data);
  }

  private buildRevisionMessages(
    args: ReviseChapterPassagePreviewInput,
    draft: LoadedDraft,
    passageContext: unknown,
    retryReview?: PassageRevisionQualityReview,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          'You are a Chinese web-novel passage revision agent.',
          'Return strict JSON only. No Markdown.',
          'Revise only the selected passage. Do not rewrite the whole chapter.',
          'Do not output placeholders, deterministic templates, or skeletal filler.',
          'If the instruction cannot be satisfied with the available local context, return a direct risk in risks but still provide a concrete replacement only when it is genuinely usable.',
          'The replacementText must be the exact text that can replace originalText at selectedRange.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          instruction: args.instruction,
          target: {
            chapterId: draft.chapterId,
            draftId: draft.id,
            draftVersion: draft.versionNo,
            selectedRange: args.selectedRange,
            selectedParagraphRange: args.selectedParagraphRange,
          },
          originalText: args.originalText,
          localContext: passageContext,
          retryFeedback: retryReview
            ? {
                summary: 'Previous passage revision failed quality review. Regenerate a fresh replacementText.',
                issues: retryReview.issues,
                checks: retryReview.checks,
              }
            : undefined,
          outputContract: {
            replacementText: 'non-empty string, replacing only originalText',
            editSummary: 'short human-readable summary of the local change',
            preservedFacts: ['facts or constraints intentionally preserved'],
            risks: ['risks, uncertainty, or empty array'],
          },
        }),
      },
    ];
  }

  private buildQualityReviewMessages(
    args: ReviseChapterPassagePreviewInput,
    draft: LoadedDraft,
    passageContext: unknown,
    candidate: PassageRevisionLlmOutput,
  ): Array<{ role: 'system' | 'user'; content: string }> {
    return [
      {
        role: 'system',
        content: [
          'You are an expert Chinese web-novel passage revision quality reviewer.',
          'Judge semantic usability by reading the passage and local context. Do not use keyword matching or regex-like heuristics.',
          'Return strict JSON only. No Markdown.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Review whether replacementText can safely enter approval as a local selected-passage revision preview.',
          instruction: args.instruction,
          target: {
            chapterId: draft.chapterId,
            draftId: draft.id,
            draftVersion: draft.versionNo,
            selectedRange: args.selectedRange,
          },
          originalText: args.originalText,
          replacement: candidate,
          localContext: passageContext,
          rubric: [
            'The replacement must follow the user instruction for the selected passage.',
            'The replacement must preserve required facts and local continuity unless the user explicitly asked to change them.',
            'The replacement must fit nearby before/after text.',
            'The replacement must stay local and avoid unexpected plot or whole-chapter rewrites.',
            'The replacement must be concrete prose, not a note, analysis, placeholder, or template.',
          ],
          decisionRules: [
            'Return valid=false if any error-level issue would make the preview unsafe for approval.',
            'Use warnings for minor style concerns that do not block approval.',
            'Do not rewrite the passage in this review. Only report validity, issues, and checks.',
          ],
        }),
      },
    ];
  }

  private normalizeRevisionOutput(value: unknown): PassageRevisionLlmOutput {
    const record = this.asRecord(value);
    if (typeof record.replacementText !== 'string') throw new BadRequestException('replacementText is required.');
    const replacementText = record.replacementText;
    if (!replacementText.trim()) throw new BadRequestException('replacementText must not be empty.');
    return {
      replacementText,
      editSummary: this.requiredString(record.editSummary, 'editSummary'),
      preservedFacts: this.requiredStringArray(record.preservedFacts, 'preservedFacts'),
      risks: this.requiredStringArray(record.risks, 'risks'),
    };
  }

  private normalizeQualityReview(value: unknown): PassageRevisionQualityReview {
    const record = this.asRecord(value);
    if (typeof record.valid !== 'boolean') throw new BadRequestException('Quality review missing boolean valid.');
    const issuesValue = record.issues;
    if (!Array.isArray(issuesValue)) throw new BadRequestException('Quality review missing issues array.');
    const issues = issuesValue.map((item, index) => {
      const issue = this.asRecord(item);
      if (issue.severity !== 'error' && issue.severity !== 'warning') {
        throw new BadRequestException(`Quality review issues[${index}].severity must be error or warning.`);
      }
      const severity = issue.severity === 'error' ? 'error' as const : 'warning' as const;
      return {
        severity,
        message: this.requiredString(issue.message, `issues[${index}].message`),
      };
    });
    const checksRecord = this.asRecord(record.checks);
    const checks = {
      followsInstruction: this.requiredBoolean(checksRecord.followsInstruction, 'checks.followsInstruction'),
      preservesRequiredFacts: this.requiredBoolean(checksRecord.preservesRequiredFacts, 'checks.preservesRequiredFacts'),
      keepsCharacterVoice: this.requiredBoolean(checksRecord.keepsCharacterVoice, 'checks.keepsCharacterVoice'),
      fitsLocalContext: this.requiredBoolean(checksRecord.fitsLocalContext, 'checks.fitsLocalContext'),
      replacementIsConcrete: this.requiredBoolean(checksRecord.replacementIsConcrete, 'checks.replacementIsConcrete'),
      noUnexpectedPlotRewrite: this.requiredBoolean(checksRecord.noUnexpectedPlotRewrite, 'checks.noUnexpectedPlotRewrite'),
    };
    return {
      valid: record.valid && !issues.some((issue) => issue.severity === 'error'),
      issues,
      checks,
    };
  }

  private revisionJsonSchema(): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
    return {
      name: 'chapter_passage_revision_preview',
      description: 'Replacement text preview for a selected chapter draft passage.',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['replacementText', 'editSummary', 'preservedFacts', 'risks'],
        properties: {
          replacementText: { type: 'string' },
          editSummary: { type: 'string' },
          preservedFacts: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } },
        },
      },
    };
  }

  private qualityReviewJsonSchema(): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
    return {
      name: 'chapter_passage_revision_quality_review',
      description: 'LLM quality review for selected passage revision previews.',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['valid', 'issues', 'checks'],
        properties: {
          valid: { type: 'boolean' },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['severity', 'message'],
              properties: {
                severity: { type: 'string', enum: ['error', 'warning'] },
                message: { type: 'string' },
              },
            },
          },
          checks: {
            type: 'object',
            additionalProperties: false,
            required: ['followsInstruction', 'preservesRequiredFacts', 'keepsCharacterVoice', 'fitsLocalContext', 'replacementIsConcrete', 'noUnexpectedPlotRewrite'],
            properties: {
              followsInstruction: { type: 'boolean' },
              preservesRequiredFacts: { type: 'boolean' },
              keepsCharacterVoice: { type: 'boolean' },
              fitsLocalContext: { type: 'boolean' },
              replacementIsConcrete: { type: 'boolean' },
              noUnexpectedPlotRewrite: { type: 'boolean' },
            },
          },
        },
      },
    };
  }

  private computeParagraphRange(content: string, range: TextRange): SelectedParagraphRange {
    const paragraphs = this.paragraphSlices(content);
    const selected = paragraphs.filter((paragraph) => paragraph.end > range.start && paragraph.start < range.end);
    if (!selected.length) return { start: 1, end: 1, count: 1 };
    const start = paragraphs.indexOf(selected[0]) + 1;
    const end = paragraphs.indexOf(selected[selected.length - 1]) + 1;
    return { start, end, count: end - start + 1 };
  }

  private nearbyParagraphs(content: string, range: TextRange, paragraphRange: SelectedParagraphRange) {
    const paragraphs = this.paragraphSlices(content);
    const startIndex = Math.max(0, paragraphRange.start - 1);
    const endIndex = Math.max(startIndex, paragraphRange.end - 1);
    const beforeText = paragraphs
      .slice(Math.max(0, startIndex - 3), startIndex)
      .map((paragraph) => content.slice(paragraph.start, paragraph.end).trim())
      .filter(Boolean)
      .join('\n\n') || content.slice(Math.max(0, range.start - 1200), range.start);
    const afterText = paragraphs
      .slice(endIndex + 1, endIndex + 4)
      .map((paragraph) => content.slice(paragraph.start, paragraph.end).trim())
      .filter(Boolean)
      .join('\n\n') || content.slice(range.end, Math.min(content.length, range.end + 1200));
    return { beforeText, afterText };
  }

  private paragraphSlices(content: string): TextRange[] {
    const slices: TextRange[] = [];
    let paragraphStart: number | undefined;
    for (let index = 0; index <= content.length; index += 1) {
      const char = content[index];
      const isBoundary = index === content.length || char === '\n';
      if (paragraphStart === undefined && !isBoundary && !/\s/.test(char)) paragraphStart = index;
      if (!isBoundary) continue;
      if (paragraphStart !== undefined) {
        const rawEnd = index;
        const text = content.slice(paragraphStart, rawEnd);
        const trailingWhitespace = text.match(/\s*$/)?.[0].length ?? 0;
        slices.push({ start: paragraphStart, end: rawEnd - trailingWhitespace });
        paragraphStart = undefined;
      }
    }
    return slices;
  }

  private normalizeSelectedParagraphRange(value: SelectedParagraphRange): SelectedParagraphRange {
    this.assertPositiveInteger(value.start, 'selectedParagraphRange.start');
    this.assertPositiveInteger(value.end, 'selectedParagraphRange.end');
    if (value.end < value.start) throw new BadRequestException('selectedParagraphRange.end must be greater than or equal to start.');
    if (value.count !== undefined) this.assertPositiveInteger(value.count, 'selectedParagraphRange.count');
    return { start: value.start, end: value.end, ...(value.count !== undefined ? { count: value.count } : {}) };
  }

  private assertPositiveInteger(value: unknown, field: string): asserts value is number {
    if (!Number.isInteger(value) || Number(value) <= 0) throw new BadRequestException(`${field} must be a positive integer.`);
  }

  private assertNonEmptyString(value: unknown, field: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
  }

  private requiredString(value: unknown, field: string, options: { preserveWhitespace?: boolean } = {}): string {
    if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(`${field} is required.`);
    return options.preserveWhitespace ? value : value.trim();
  }

  private requiredStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new BadRequestException(`${field} must be an array.`);
    return value.map((item, index) => this.requiredString(item, `${field}[${index}]`));
  }

  private requiredBoolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be boolean.`);
    return value;
  }

  private formatReviewIssues(review: PassageRevisionQualityReview): string {
    return review.issues.map((issue) => `[${issue.severity}] ${issue.message}`).join('; ') || 'invalid quality review';
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}

@Injectable()
export class ApplyChapterPassageRevisionTool implements BaseTool<ApplyChapterPassageRevisionInput, ChapterPassageRevisionApplyResult> {
  name = 'apply_chapter_passage_revision';
  description = 'After explicit approval, replace only the selected range in the current chapter draft and persist it as a new draft version.';
  inputSchema = {
    type: 'object' as const,
    required: ['preview'],
    additionalProperties: false,
    properties: {
      preview: {
        type: 'object' as const,
        required: ['chapterId', 'draftId', 'draftVersion', 'selectedRange', 'originalText', 'replacementText', 'editSummary'],
        additionalProperties: false,
        properties: {
          previewId: { type: 'string' as const, minLength: 1 },
          chapterId: { type: 'string' as const, minLength: 1 },
          draftId: { type: 'string' as const, minLength: 1 },
          draftVersion: { type: 'number' as const, minimum: 1, integer: true },
          selectedRange: {
            type: 'object' as const,
            required: ['start', 'end'],
            additionalProperties: false,
            properties: {
              start: { type: 'number' as const, minimum: 0, integer: true },
              end: { type: 'number' as const, minimum: 1, integer: true },
            },
          },
          selectedParagraphRange: {
            type: 'object' as const,
            required: ['start', 'end'],
            additionalProperties: false,
            properties: {
              start: { type: 'number' as const, minimum: 1, integer: true },
              end: { type: 'number' as const, minimum: 1, integer: true },
              count: { type: 'number' as const, minimum: 1, integer: true },
            },
          },
          originalText: { type: 'string' as const, minLength: 1 },
          replacementText: { type: 'string' as const, minLength: 1 },
          editSummary: { type: 'string' as const, minLength: 1 },
          preservedFacts: { type: 'array' as const, items: { type: 'string' as const } },
          risks: { type: 'array' as const, items: { type: 'string' as const } },
          validation: {
            type: 'object' as const,
            required: ['valid', 'issues'],
            additionalProperties: false,
            properties: {
              valid: { type: 'boolean' as const },
              issues: { type: 'array' as const, items: { type: 'string' as const } },
            },
          },
        },
      },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['draftId', 'chapterId', 'versionNo', 'actualWordCount', 'selectedRange', 'sourceDraftId', 'sourceDraftVersion'],
    additionalProperties: false,
    properties: {
      draftId: { type: 'string' as const, minLength: 1 },
      chapterId: { type: 'string' as const, minLength: 1 },
      versionNo: { type: 'number' as const, minimum: 1, integer: true },
      actualWordCount: { type: 'number' as const, minimum: 0, integer: true },
      selectedRange: {
        type: 'object' as const,
        required: ['start', 'end'],
        additionalProperties: false,
        properties: {
          start: { type: 'number' as const, minimum: 0, integer: true },
          end: { type: 'number' as const, minimum: 1, integer: true },
        },
      },
      selectedParagraphRange: { type: 'object' as const },
      sourceDraftId: { type: 'string' as const, minLength: 1 },
      sourceDraftVersion: { type: 'number' as const, minimum: 1, integer: true },
      previewId: { type: 'string' as const, minLength: 1 },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_chapter_draft', 'update_chapter_status'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '应用章节选区局部修订',
    description: 'After explicit approval, deterministically applies a previously reviewed passage revision preview by creating a new current draft version.',
    whenToUse: [
      'The user explicitly approves a revise_chapter_passage_preview result and wants it written into the chapter draft.',
      'A passage-level revision preview already exists and only the selected range should be replaced.',
    ],
    whenNotToUse: [
      'Do not use without an approved passage preview.',
      'Do not use in plan mode.',
      'Do not use for whole-chapter rewrites or whole-chapter polishing.',
      'Do not guess a new range when the current draft or selected text drifted; fail and ask the user to reselect.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Use the full output of revise_chapter_passage_preview.' },
    },
    examples: [
      {
        user: '这版可以，应用到正文。',
        context: { sourcePage: 'editor_passage_agent', selectionIntent: 'chapter_passage_revision' },
        plan: [
          {
            tool: 'apply_chapter_passage_revision',
            args: {
              preview: '{{steps.1.output}}',
            },
          },
        ],
      },
    ],
    failureHints: [
      { code: 'APPROVAL_REQUIRED', meaning: 'The write step requires explicit approval and act mode.', suggestedRepair: 'Ask the user to approve the passage revision before applying it.' },
      { code: 'DRAFT_VERSION_CONFLICT', meaning: 'The current chapter draft changed after the preview was generated.', suggestedRepair: 'Ask the user to save or reselect the passage and generate a fresh preview.' },
      { code: 'RANGE_CONFLICT', meaning: 'The current draft text no longer matches originalText at selectedRange.', suggestedRepair: 'Ask the user to reselect the passage instead of guessing a replacement location.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async run(args: ApplyChapterPassageRevisionInput, context: ToolContext): Promise<ChapterPassageRevisionApplyResult> {
    if (context.mode !== 'act') {
      throw new BadRequestException('apply_chapter_passage_revision must run in act mode.');
    }
    if (!context.approved) {
      throw new BadRequestException('apply_chapter_passage_revision requires explicit user approval.');
    }

    const preview = this.normalizePreview(args.preview);
    const draft = await this.loadDraft(preview.draftId);
    this.assertDraftMatchesPreview(draft, preview, context.projectId);

    const currentDraft = await this.loadCurrentDraft(preview.chapterId);
    this.assertCurrentDraftMatchesPreview(currentDraft, preview);
    this.assertRangeMatchesOriginalText(currentDraft.content, preview.selectedRange, preview.originalText);

    const persisted = await this.prisma.$transaction(async (tx) => {
      const currentInTransaction = await tx.chapterDraft.findFirst({
        where: { chapterId: preview.chapterId, isCurrent: true },
        orderBy: { versionNo: 'desc' },
      });
      if (!currentInTransaction) {
        throw new NotFoundException(`Current chapter draft not found for chapter: ${preview.chapterId}`);
      }
      this.assertCurrentDraftMatchesPreview(currentInTransaction, preview);
      this.assertRangeMatchesOriginalText(currentInTransaction.content, preview.selectedRange, preview.originalText);

      const latestInTransaction = await tx.chapterDraft.findFirst({
        where: { chapterId: preview.chapterId },
        orderBy: { versionNo: 'desc' },
      });
      const nextContent = this.applyReplacement(currentInTransaction.content, preview.selectedRange, preview.replacementText);
      const actualWordCount = this.countChineseLikeWords(nextContent);

      await tx.chapterDraft.updateMany({
        where: { chapterId: preview.chapterId, isCurrent: true },
        data: { isCurrent: false },
      });

      const created = await tx.chapterDraft.create({
        data: {
          chapterId: preview.chapterId,
          versionNo: (latestInTransaction?.versionNo ?? 0) + 1,
          content: nextContent,
          source: 'agent_passage_revision',
          modelInfo: {} as Prisma.InputJsonValue,
          generationContext: {
            type: 'passage_revision',
            agentRunId: context.agentRunId,
            previewId: preview.previewId,
            originalDraftId: currentInTransaction.id,
            originalDraftVersion: currentInTransaction.versionNo,
            selectedRange: preview.selectedRange,
            selectedParagraphRange: preview.selectedParagraphRange,
            originalText: preview.originalText,
            replacementText: preview.replacementText,
            editSummary: preview.editSummary,
            preservedFacts: preview.preservedFacts,
            risks: preview.risks,
          } as unknown as Prisma.InputJsonValue,
          isCurrent: true,
          createdBy: currentInTransaction.createdBy ?? context.userId,
        },
      });

      await tx.chapter.update({
        where: { id: preview.chapterId },
        data: {
          status: 'drafted',
          actualWordCount,
        },
      });

      return {
        draftId: created.id,
        chapterId: created.chapterId,
        versionNo: created.versionNo,
        actualWordCount,
      };
    }, { timeout: 30_000, maxWait: 10_000 });

    await this.cacheService.deleteProjectRecallResults(context.projectId);

    return {
      ...persisted,
      selectedRange: { start: preview.selectedRange.start, end: preview.selectedRange.end },
      ...(preview.selectedParagraphRange ? { selectedParagraphRange: preview.selectedParagraphRange } : {}),
      sourceDraftId: preview.draftId,
      sourceDraftVersion: preview.draftVersion,
      ...(preview.previewId ? { previewId: preview.previewId } : {}),
    };
  }

  private async loadDraft(draftId: string): Promise<LoadedDraft> {
    const draft = await this.prisma.chapterDraft.findUnique({
      where: { id: draftId },
      include: {
        chapter: {
          include: {
            volume: true,
          },
        },
      },
    });
    if (!draft) throw new NotFoundException(`Chapter draft not found: ${draftId}`);
    return draft as LoadedDraft;
  }

  private async loadCurrentDraft(chapterId: string): Promise<{ id: string; chapterId: string; versionNo: number; content: string; createdBy: string | null }> {
    const draft = await this.prisma.chapterDraft.findFirst({
      where: { chapterId, isCurrent: true },
      orderBy: { versionNo: 'desc' },
    });
    if (!draft) throw new NotFoundException(`Current chapter draft not found for chapter: ${chapterId}`);
    return draft;
  }

  private normalizePreview(value: ApplyChapterPassageRevisionInput['preview']) {
    const preview = this.asRecord(value);
    const selectedRange = this.normalizeRange(preview.selectedRange);
    const selectedParagraphRange = preview.selectedParagraphRange === undefined
      ? undefined
      : this.normalizeSelectedParagraphRange(preview.selectedParagraphRange);
    const preservedFacts = preview.preservedFacts === undefined
      ? undefined
      : this.requiredStringArray(preview.preservedFacts, 'preview.preservedFacts');
    const risks = preview.risks === undefined
      ? undefined
      : this.requiredStringArray(preview.risks, 'preview.risks');

    return {
      previewId: preview.previewId === undefined ? undefined : this.requiredString(preview.previewId, 'preview.previewId'),
      chapterId: this.requiredString(preview.chapterId, 'preview.chapterId'),
      draftId: this.requiredString(preview.draftId, 'preview.draftId'),
      draftVersion: this.requiredPositiveInteger(preview.draftVersion, 'preview.draftVersion'),
      selectedRange,
      ...(selectedParagraphRange ? { selectedParagraphRange } : {}),
      originalText: this.requiredString(preview.originalText, 'preview.originalText', { preserveWhitespace: true }),
      replacementText: this.requiredString(preview.replacementText, 'preview.replacementText', { preserveWhitespace: true }),
      editSummary: this.requiredString(preview.editSummary, 'preview.editSummary'),
      ...(preservedFacts ? { preservedFacts } : {}),
      ...(risks ? { risks } : {}),
    };
  }

  private assertDraftMatchesPreview(
    draft: LoadedDraft,
    preview: {
      chapterId: string;
      draftId: string;
      draftVersion: number;
      selectedRange: TextRange;
      originalText: string;
    },
    projectId: string,
  ): void {
    if (draft.chapter.projectId !== projectId) {
      throw new BadRequestException('Draft does not belong to the current project.');
    }
    if (draft.chapterId !== preview.chapterId) {
      throw new BadRequestException('Draft does not belong to the requested chapter.');
    }
    if (draft.id !== preview.draftId) {
      throw new BadRequestException('Preview draft id does not match the stored draft.');
    }
    if (draft.versionNo !== preview.draftVersion) {
      throw new BadRequestException(`Draft version conflict: current v${draft.versionNo}, requested v${preview.draftVersion}.`);
    }
  }

  private assertCurrentDraftMatchesPreview(
    currentDraft: { id: string; chapterId: string; versionNo: number },
    preview: { chapterId: string; draftId: string; draftVersion: number },
  ): void {
    if (currentDraft.chapterId !== preview.chapterId) {
      throw new BadRequestException('Current draft does not belong to the requested chapter.');
    }
    if (currentDraft.id !== preview.draftId || currentDraft.versionNo !== preview.draftVersion) {
      throw new BadRequestException(`Draft version conflict: current draft is v${currentDraft.versionNo}. Please reselect the passage.`);
    }
  }

  private applyReplacement(content: string, range: TextRange, replacementText: string): string {
    return `${content.slice(0, range.start)}${replacementText}${content.slice(range.end)}`;
  }

  private assertRangeMatchesOriginalText(content: string, range: TextRange, originalText: string): void {
    this.assertValidRange(content, range);
    if (content.slice(range.start, range.end) !== originalText) {
      throw new BadRequestException('Selected range no longer matches the current draft. Please reselect the passage.');
    }
  }

  private normalizeRange(value: unknown): TextRange {
    const record = this.asRecord(value);
    const start = record.start;
    const end = record.end;
    if (!Number.isInteger(start) || Number(start) < 0) {
      throw new BadRequestException('preview.selectedRange.start must be a non-negative integer.');
    }
    if (!Number.isInteger(end) || Number(end) <= 0) {
      throw new BadRequestException('preview.selectedRange.end must be a positive integer.');
    }
    if (Number(end) <= Number(start)) {
      throw new BadRequestException('preview.selectedRange.end must be greater than start.');
    }
    return { start: Number(start), end: Number(end) };
  }

  private assertValidRange(content: string, range: TextRange): void {
    if (!Number.isInteger(range.start) || range.start < 0) {
      throw new BadRequestException('selectedRange.start must be a non-negative integer.');
    }
    if (!Number.isInteger(range.end) || range.end <= 0) {
      throw new BadRequestException('selectedRange.end must be a positive integer.');
    }
    if (range.end <= range.start) {
      throw new BadRequestException('selectedRange.end must be greater than selectedRange.start.');
    }
    if (range.end > content.length) {
      throw new BadRequestException('selectedRange is outside the current draft content.');
    }
  }

  private normalizeSelectedParagraphRange(value: unknown): SelectedParagraphRange {
    const record = this.asRecord(value);
    const start = this.requiredPositiveInteger(record.start, 'preview.selectedParagraphRange.start');
    const end = this.requiredPositiveInteger(record.end, 'preview.selectedParagraphRange.end');
    if (end < start) {
      throw new BadRequestException('preview.selectedParagraphRange.end must be greater than or equal to start.');
    }
    const count = record.count === undefined
      ? undefined
      : this.requiredPositiveInteger(record.count, 'preview.selectedParagraphRange.count');
    return { start, end, ...(count !== undefined ? { count } : {}) };
  }

  private requiredPositiveInteger(value: unknown, field: string): number {
    if (!Number.isInteger(value) || Number(value) <= 0) {
      throw new BadRequestException(`${field} must be a positive integer.`);
    }
    return Number(value);
  }

  private requiredString(value: unknown, field: string, options: { preserveWhitespace?: boolean } = {}): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException(`${field} is required.`);
    }
    return options.preserveWhitespace ? value : value.trim();
  }

  private requiredStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array.`);
    }
    return value.map((item, index) => this.requiredString(item, `${field}[${index}]`));
  }

  private countChineseLikeWords(content: string): number {
    const cjk = content.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
    const words = content.match(/[A-Za-z0-9]+/g)?.length ?? 0;
    return cjk + words;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }
}
