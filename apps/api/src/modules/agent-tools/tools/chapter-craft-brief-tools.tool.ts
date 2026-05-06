import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';

interface GenerateChapterCraftBriefPreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeId?: string;
  chapterId?: string;
  chapterNo?: number;
  chapterNos?: number[];
  onlyMissing?: boolean;
  includeDrafted?: boolean;
  limit?: number;
}

export interface ChapterCraftBrief {
  visibleGoal: string;
  hiddenEmotion: string;
  coreConflict: string;
  mainlineTask: string;
  subplotTasks: string[];
  actionBeats: string[];
  concreteClues: Array<{
    name: string;
    sensoryDetail?: string;
    laterUse?: string;
  }>;
  dialogueSubtext: string;
  characterShift: string;
  irreversibleConsequence: string;
  progressTypes: string[];
}

export interface ChapterCraftBriefSourceTrace {
  sourceKind: 'chapter_craft_brief';
  originTool: 'generate_chapter_craft_brief_preview';
  agentRunId: string;
  candidateIndex: number;
  instruction: string;
  chapterNo: number;
  contextSources: Array<{ sourceType: string; sourceId?: string; title?: string }>;
}

export interface ChapterCraftBriefCandidate {
  candidateId: string;
  chapterId: string;
  chapterNo: number;
  title: string;
  status: string;
  hasExistingCraftBrief: boolean;
  proposedFields: {
    objective?: string;
    conflict?: string;
    outline?: string;
    craftBrief: ChapterCraftBrief;
  };
  risks: string[];
  sourceTrace: ChapterCraftBriefSourceTrace;
}

export interface GenerateChapterCraftBriefPreviewOutput {
  candidates: ChapterCraftBriefCandidate[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    target: 'Chapter.craftBrief';
    requiresValidation: true;
    requiresApprovalBeforePersist: true;
  };
}

interface ValidateChapterCraftBriefInput {
  preview?: GenerateChapterCraftBriefPreviewOutput;
  taskContext?: Record<string, unknown>;
}

export interface ValidateChapterCraftBriefOutput {
  valid: boolean;
  accepted: Array<{
    candidateId: string;
    chapterId: string;
    chapterNo: number;
    title: string;
    status: string;
    action: 'update' | 'skip_by_default';
    sourceTrace: ChapterCraftBriefSourceTrace;
  }>;
  rejected: Array<{
    candidateId: string;
    chapterNo?: number;
    title: string;
    reasons: string[];
  }>;
  warnings: string[];
  writePreview: {
    target: 'Chapter.craftBrief';
    requiresApprovalBeforePersist: true;
    chapters: Array<{
      candidateId: string;
      chapterId: string;
      chapterNo: number;
      title: string;
      status: string;
      action: 'update' | 'skip_by_default';
      reason?: string;
      proposedFields: ChapterCraftBriefCandidate['proposedFields'];
      sourceTrace: ChapterCraftBriefSourceTrace;
    }>;
  };
}

type ChapterTarget = {
  id: string;
  volumeId: string | null;
  chapterNo: number;
  title: string | null;
  objective: string | null;
  conflict: string | null;
  outline: string | null;
  status: string;
  craftBrief?: Prisma.JsonValue | null;
};

const CHAPTER_CRAFT_BRIEF_SOURCE_KIND = 'chapter_craft_brief' as const;
const CHAPTER_CRAFT_BRIEF_ORIGIN_TOOL = 'generate_chapter_craft_brief_preview' as const;
const CHAPTER_CRAFT_BRIEF_LLM_TIMEOUT_MS = 90_000;
const CHAPTER_CRAFT_BRIEF_MAX_TARGETS = 80;

@Injectable()
export class GenerateChapterCraftBriefPreviewTool implements BaseTool<GenerateChapterCraftBriefPreviewInput, GenerateChapterCraftBriefPreviewOutput> {
  name = 'generate_chapter_craft_brief_preview';
  description = 'Generate Chapter.craftBrief execution-card previews for one or more chapters without writing to the database.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      volumeId: { type: 'string' as const },
      chapterId: { type: 'string' as const },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
      chapterNos: { type: 'array' as const, items: { type: 'number' as const, minimum: 1, integer: true } },
      onlyMissing: { type: 'boolean' as const },
      includeDrafted: { type: 'boolean' as const },
      limit: { type: 'number' as const, minimum: 1, maximum: CHAPTER_CRAFT_BRIEF_MAX_TARGETS, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['candidates', 'assumptions', 'risks', 'writePlan'],
    properties: {
      candidates: { type: 'array' as const },
      assumptions: { type: 'array' as const, items: { type: 'string' as const } },
      risks: { type: 'array' as const, items: { type: 'string' as const } },
      writePlan: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Generate Chapter Craft Brief Preview',
    description: 'Create chapter-level progress/execution-card previews for Chapter.craftBrief. This tool is read-only and never writes Chapter rows.',
    whenToUse: [
      'The user asks for a chapter progress card, execution card, craftBrief, action chain, clues, dialogue subtext, or irreversible consequence.',
      'The user asks to refine the current chapter outline into a chapter-level execution card.',
      'The user asks to fill missing Chapter.craftBrief fields for one chapter or planned chapters in a volume.',
    ],
    whenNotToUse: [
      'The user asks to write or continue chapter prose; use write_chapter or write_chapter_series.',
      'The user asks to split a chapter into scenes or SceneCards; use generate_scene_cards_preview.',
      'The user asks for a whole-volume or 60-chapter outline; use generate_outline_preview.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'Chapter/project context from collect_chapter_context or collect_task_context.' },
      instruction: { source: 'user_message', description: 'User request, including desired emphasis such as action chain, clues, subtext, or consequence.' },
      chapterId: { source: 'resolver', description: 'Real chapterId from resolve_chapter or context.session.currentChapterId; do not invent it.' },
      chapterNo: { source: 'user_message', description: 'Use when the user says "chapter 3"; the tool resolves it to a real Chapter row.' },
      volumeId: { source: 'resolver', description: 'Use only for bulk planned-chapter craftBrief fill within a real volume.' },
      onlyMissing: { source: 'literal', description: 'Set true when the user asks to fill missing craftBriefs only.' },
    },
    examples: [
      {
        user: 'Give chapter 3 a progress card.',
        plan: [
          { tool: 'resolve_chapter', args: { chapterRef: 'chapter 3' } },
          { tool: 'collect_chapter_context', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}' } },
          { tool: 'generate_chapter_craft_brief_preview', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', context: '{{steps.collect_chapter_context.output}}', instruction: '{{context.userMessage}}' } },
          { tool: 'validate_chapter_craft_brief', args: { preview: '{{steps.generate_chapter_craft_brief_preview.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId'],
      allowedSources: ['projectId from ToolContext only', 'chapterId from resolve_chapter/context/DB lookup by chapterNo', 'volumeId from resolver or DB context'],
    },
  };

  constructor(private readonly llm: LlmGatewayService, private readonly prisma: PrismaService) {}

  async run(args: GenerateChapterCraftBriefPreviewInput, context: ToolContext): Promise<GenerateChapterCraftBriefPreviewOutput> {
    await context.updateProgress?.({
      phase: 'preparing_context',
      phaseMessage: 'Preparing chapter craft brief targets',
      progressCurrent: 0,
      progressTotal: 1,
    });
    const instruction = text(args.instruction, 'Create a chapter craft brief.');
    const targetResult = await resolveChapterTargets(this.prisma, context, args);
    const targets = targetResult.targets;
    if (!targets.length) throw new BadRequestException('generate_chapter_craft_brief_preview requires at least one target chapter.');

    try {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: targets.length === 1 ? `Generating craft brief for chapter ${targets[0].chapterNo}` : `Generating craft briefs for ${targets.length} chapters`,
        progressCurrent: 0,
        progressTotal: targets.length,
        timeoutMs: CHAPTER_CRAFT_BRIEF_LLM_TIMEOUT_MS,
      });
      const response = await this.llm.chatJson<Partial<GenerateChapterCraftBriefPreviewOutput> & { chapters?: unknown; chapter?: unknown }>(
        [
          {
            role: 'system',
            content: [
              'You are the AI Novel chapter craft-brief planning agent. Return JSON only, no Markdown.',
              'Generate chapter-level execution cards, not prose and not scene cards.',
              'Each candidate must include chapterNo, title, proposedFields.objective, proposedFields.conflict, proposedFields.outline, and proposedFields.craftBrief.',
              'craftBrief must include visibleGoal, hiddenEmotion, coreConflict, mainlineTask, subplotTasks, actionBeats, concreteClues, dialogueSubtext, characterShift, irreversibleConsequence, and progressTypes.',
              'actionBeats must contain at least 3 concrete actions. concreteClues must contain at least 1 tangible clue or prop with sensory detail or later use.',
              'irreversibleConsequence must name the concrete fact, relationship, resource, status, rule, or danger that changes by the end of the chapter.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: `Instruction: ${instruction}
Targets:
${JSON.stringify(targets.map(compactChapterTarget), null, 2)}
Project/chapter context:
${JSON.stringify(args.context ?? {}, null, 2).slice(0, 24000)}`,
          },
        ],
        {
          appStep: 'planner',
          maxTokens: Math.min(12000, targets.length * 950 + 1600),
          timeoutMs: CHAPTER_CRAFT_BRIEF_LLM_TIMEOUT_MS,
          retries: 0,
        },
      );
      recordToolLlmUsage(context, 'planner', response.result);
      await context.updateProgress?.({
        phase: 'validating',
        phaseMessage: 'Normalizing chapter craft brief preview',
        progressCurrent: targets.length,
        progressTotal: targets.length,
      });
      return this.normalize(response.data, args, context, targets, instruction, targetResult.risks);
    } catch (error) {
      await context.updateProgress?.({
        phase: 'fallback_generating',
        phaseMessage: 'Craft brief model call failed; generating deterministic preview',
        progressCurrent: 0,
        progressTotal: targets.length,
      });
      return this.normalize(
        { candidates: [] },
        args,
        context,
        targets,
        instruction,
        [
          ...targetResult.risks,
          `${isLlmTimeout(error) ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_FALLBACK'}: generated baseline Chapter.craftBrief preview; manual review recommended.`,
          text(error instanceof Error ? error.message : String(error), 'Unknown model error').slice(0, 180),
        ],
      );
    }
  }

  private normalize(
    data: Partial<GenerateChapterCraftBriefPreviewOutput> & { chapters?: unknown; chapter?: unknown },
    args: GenerateChapterCraftBriefPreviewInput,
    context: ToolContext,
    targets: ChapterTarget[],
    instruction: string,
    initialRisks: string[] = [],
  ): GenerateChapterCraftBriefPreviewOutput {
    const rawCandidates = normalizeRawCandidates(data);
    const rawByChapterNo = new Map<number, Record<string, unknown>>();
    rawCandidates.forEach((item, index) => {
      const record = asRecord(item) ?? {};
      const chapterNo = positiveInt(record.chapterNo) ?? targets[index]?.chapterNo;
      if (chapterNo) rawByChapterNo.set(chapterNo, record);
    });
    const contextSources = extractContextSources(args.context);
    const candidates = targets.map((target, index) => this.normalizeCandidate(rawByChapterNo.get(target.chapterNo) ?? {}, target, index, instruction, context, contextSources));
    const risks = [...initialRisks, ...stringArray(data.risks)];

    return {
      candidates,
      assumptions: stringArray(data.assumptions),
      risks: [...new Set(risks)],
      writePlan: {
        mode: 'preview_only',
        target: 'Chapter.craftBrief',
        requiresValidation: true,
        requiresApprovalBeforePersist: true,
      },
    };
  }

  private normalizeCandidate(
    raw: Record<string, unknown>,
    target: ChapterTarget,
    index: number,
    instruction: string,
    context: ToolContext,
    contextSources: ChapterCraftBriefSourceTrace['contextSources'],
  ): ChapterCraftBriefCandidate {
    const proposed = asRecord(raw.proposedFields) ?? raw;
    const title = compactText(text(raw.title, target.title ?? `Chapter ${target.chapterNo}`), 255);
    const objective = optionalText(proposed.objective) ?? target.objective ?? undefined;
    const conflict = optionalText(proposed.conflict) ?? target.conflict ?? undefined;
    const outline = optionalText(proposed.outline) ?? target.outline ?? undefined;
    const base = {
      chapterNo: target.chapterNo,
      title,
      objective: objective ?? '',
      conflict: conflict ?? '',
      outline: outline ?? '',
    };
    const sourceTrace: ChapterCraftBriefSourceTrace = {
      sourceKind: CHAPTER_CRAFT_BRIEF_SOURCE_KIND,
      originTool: CHAPTER_CRAFT_BRIEF_ORIGIN_TOOL,
      agentRunId: context.agentRunId,
      candidateIndex: index,
      instruction: compactText(instruction, 500),
      chapterNo: target.chapterNo,
      contextSources,
    };
    const risks: string[] = [];
    if (target.status !== 'planned') risks.push(`Chapter ${target.chapterNo} status is ${target.status}; persist will skip it unless explicitly allowed after approval.`);
    if (hasRecordContent(target.craftBrief)) risks.push(`Chapter ${target.chapterNo} already has Chapter.craftBrief; approved persist may update the planning card.`);

    return {
      candidateId: buildCandidateId(target.id, target.chapterNo, index),
      chapterId: target.id,
      chapterNo: target.chapterNo,
      title,
      status: target.status,
      hasExistingCraftBrief: hasRecordContent(target.craftBrief),
      proposedFields: {
        ...(objective ? { objective } : {}),
        ...(conflict ? { conflict } : {}),
        ...(outline ? { outline } : {}),
        craftBrief: normalizeCraftBrief(asRecord(proposed.craftBrief), base),
      },
      risks,
      sourceTrace,
    };
  }
}

@Injectable()
export class ValidateChapterCraftBriefTool implements BaseTool<ValidateChapterCraftBriefInput, ValidateChapterCraftBriefOutput> {
  name = 'validate_chapter_craft_brief';
  description = 'Validate Chapter.craftBrief preview candidates before approved persistence.';
  inputSchema = {
    type: 'object' as const,
    required: ['preview'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      taskContext: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'accepted', 'rejected', 'warnings', 'writePreview'],
    properties: {
      valid: { type: 'boolean' as const },
      accepted: { type: 'array' as const },
      rejected: { type: 'array' as const },
      warnings: { type: 'array' as const, items: { type: 'string' as const } },
      writePreview: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Validate Chapter Craft Brief',
    description: 'Checks Chapter.craftBrief preview completeness, action-chain density, tangible clues, irreversible consequence, source trace, and default skip behavior for drafted/non-planned chapters.',
    whenToUse: [
      'generate_chapter_craft_brief_preview has produced candidates.',
      'The next step may persist Chapter.craftBrief and needs an approval-ready write preview.',
      'The agent needs to catch missing actionBeats, concreteClues, dialogue subtext, character shift, or irreversible consequence before saving.',
    ],
    whenNotToUse: [
      'There is no Chapter.craftBrief preview output.',
      'The user is asking for SceneCard validation; use validate_scene_cards.',
      'The user is asking to validate a whole outline_preview; use validate_outline.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_chapter_craft_brief_preview.' },
      taskContext: { source: 'previous_step', description: 'Optional context for audit visibility; database refs are the source of truth.' },
    },
    examples: [
      {
        user: 'Validate the chapter progress card before saving.',
        plan: [
          { tool: 'generate_chapter_craft_brief_preview', args: { instruction: '{{context.userMessage}}' } },
          { tool: 'validate_chapter_craft_brief', args: { preview: '{{steps.generate_chapter_craft_brief_preview.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId', 'candidateId'],
      allowedSources: ['projectId from ToolContext only', 'candidateId/sourceTrace from generate_chapter_craft_brief_preview output', 'chapter refs read from the database'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateChapterCraftBriefInput, context: ToolContext): Promise<ValidateChapterCraftBriefOutput> {
    if (!args.preview) throw new BadRequestException('validate_chapter_craft_brief requires generate_chapter_craft_brief_preview output.');
    if (args.preview.writePlan?.target !== 'Chapter.craftBrief' || args.preview.writePlan?.requiresApprovalBeforePersist !== true) {
      throw new BadRequestException('Chapter craft brief preview has an invalid writePlan.');
    }
    await assertProjectExists(this.prisma, context.projectId);
    const candidates = getPreviewCandidates(args.preview);
    const refs = await loadChapterRefs(this.prisma, context.projectId, candidates);
    const accepted: ValidateChapterCraftBriefOutput['accepted'] = [];
    const rejected: ValidateChapterCraftBriefOutput['rejected'] = [];
    const warnings: string[] = [];
    const writeChapters: ValidateChapterCraftBriefOutput['writePreview']['chapters'] = [];

    candidates.forEach((candidate) => {
      const dbChapter = refs.get(candidate.chapterId);
      const status = dbChapter?.status ?? candidate.status;
      const reasons = validateCraftBriefCandidate(candidate, context, dbChapter);
      if (reasons.length) {
        rejected.push({
          candidateId: text(candidate.candidateId, ''),
          chapterNo: positiveInt(candidate.chapterNo),
          title: text(candidate.title, ''),
          reasons,
        });
        return;
      }
      const action = status === 'planned' ? 'update' : 'skip_by_default';
      if (action === 'skip_by_default') warnings.push(`Chapter ${candidate.chapterNo} status is ${status}; persist_chapter_craft_brief will skip it by default unless allowDrafted is explicitly approved.`);
      accepted.push({
        candidateId: candidate.candidateId,
        chapterId: candidate.chapterId,
        chapterNo: candidate.chapterNo,
        title: candidate.title,
        status,
        action,
        sourceTrace: candidate.sourceTrace,
      });
      writeChapters.push({
        candidateId: candidate.candidateId,
        chapterId: candidate.chapterId,
        chapterNo: candidate.chapterNo,
        title: candidate.title,
        status,
        action,
        ...(action === 'skip_by_default' ? { reason: `Chapter status ${status} is not planned.` } : {}),
        proposedFields: candidate.proposedFields,
        sourceTrace: candidate.sourceTrace,
      });
    });

    return {
      valid: candidates.length > 0 && rejected.length === 0,
      accepted,
      rejected,
      warnings: [...new Set(warnings)],
      writePreview: {
        target: 'Chapter.craftBrief',
        requiresApprovalBeforePersist: true,
        chapters: writeChapters,
      },
    };
  }
}

async function assertProjectExists(prisma: Pick<PrismaService, 'project'>, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new NotFoundException(`Project not found: ${projectId}`);
}

async function resolveChapterTargets(
  prisma: Pick<PrismaService, 'project' | 'volume' | 'chapter'>,
  context: ToolContext,
  args: GenerateChapterCraftBriefPreviewInput,
): Promise<{ targets: ChapterTarget[]; risks: string[] }> {
  await assertProjectExists(prisma, context.projectId);
  const limit = clampInt(args.limit, CHAPTER_CRAFT_BRIEF_MAX_TARGETS, 1, CHAPTER_CRAFT_BRIEF_MAX_TARGETS);
  const risks: string[] = [];
  const selectedChapterNos = uniqueNumbers([
    ...(typeof args.chapterNo === 'number' ? [args.chapterNo] : []),
    ...numberArray(args.chapterNos),
  ]);

  let targets: ChapterTarget[] = [];
  if (args.chapterId || (!selectedChapterNos.length && context.chapterId && !args.volumeId)) {
    const chapterId = text(args.chapterId, context.chapterId ?? '');
    const chapter = await prisma.chapter.findFirst({ where: { id: chapterId, projectId: context.projectId }, select: chapterSelect });
    if (!chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId}`);
    targets = [normalizeChapterTarget(chapter)];
  } else if (selectedChapterNos.length) {
    targets = (await prisma.chapter.findMany({
      where: { projectId: context.projectId, chapterNo: { in: selectedChapterNos } },
      select: chapterSelect,
      orderBy: { chapterNo: 'asc' },
      take: limit,
    })).map(normalizeChapterTarget);
    const found = new Set(targets.map((chapter) => chapter.chapterNo));
    const missing = selectedChapterNos.filter((chapterNo) => !found.has(chapterNo));
    if (missing.length) throw new NotFoundException(`Chapter number not found in project: ${missing.join(', ')}`);
  } else if (args.volumeId) {
    const volume = await prisma.volume.findFirst({ where: { id: args.volumeId, projectId: context.projectId }, select: { id: true } });
    if (!volume) throw new NotFoundException(`Volume not found in project: ${args.volumeId}`);
    targets = (await prisma.chapter.findMany({
      where: {
        projectId: context.projectId,
        volumeId: args.volumeId,
        ...(args.includeDrafted ? {} : { status: 'planned' }),
      },
      select: chapterSelect,
      orderBy: { chapterNo: 'asc' },
      take: limit,
    })).map(normalizeChapterTarget);
  }

  if (args.onlyMissing) targets = targets.filter((chapter) => !hasRecordContent(chapter.craftBrief));
  if (targets.length >= limit) risks.push(`Target list was capped at ${limit} chapters for one preview request.`);
  return { targets, risks };
}

const chapterSelect = {
  id: true,
  volumeId: true,
  chapterNo: true,
  title: true,
  objective: true,
  conflict: true,
  outline: true,
  status: true,
  craftBrief: true,
} satisfies Prisma.ChapterSelect;

function normalizeChapterTarget(chapter: {
  id: string;
  volumeId: string | null;
  chapterNo: number;
  title: string | null;
  objective: string | null;
  conflict: string | null;
  outline: string | null;
  status: string;
  craftBrief?: Prisma.JsonValue | null;
}): ChapterTarget {
  return {
    id: chapter.id,
    volumeId: chapter.volumeId,
    chapterNo: chapter.chapterNo,
    title: chapter.title,
    objective: chapter.objective,
    conflict: chapter.conflict,
    outline: chapter.outline,
    status: chapter.status,
    craftBrief: chapter.craftBrief,
  };
}

function normalizeRawCandidates(data: Partial<GenerateChapterCraftBriefPreviewOutput> & { chapters?: unknown; chapter?: unknown }): unknown[] {
  if (Array.isArray(data.candidates)) return data.candidates;
  if (Array.isArray(data.chapters)) return data.chapters;
  if (data.chapter) return [data.chapter];
  return [];
}

function getPreviewCandidates(preview?: GenerateChapterCraftBriefPreviewOutput): ChapterCraftBriefCandidate[] {
  if (!preview || !Array.isArray(preview.candidates)) return [];
  return preview.candidates.filter((item): item is ChapterCraftBriefCandidate => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

async function loadChapterRefs(
  prisma: Pick<PrismaService, 'chapter'>,
  projectId: string,
  candidates: ChapterCraftBriefCandidate[],
): Promise<Map<string, Pick<ChapterTarget, 'id' | 'chapterNo' | 'title' | 'status'>>> {
  const chapterIds = [...new Set(candidates.map((candidate) => candidate.chapterId).filter(Boolean))];
  const chapters = chapterIds.length
    ? await prisma.chapter.findMany({
        where: { projectId, id: { in: chapterIds } },
        select: { id: true, chapterNo: true, title: true, status: true },
      })
    : [];
  return new Map(chapters.map((chapter) => [chapter.id, chapter]));
}

function validateCraftBriefCandidate(
  candidate: ChapterCraftBriefCandidate,
  context: ToolContext,
  dbChapter?: Pick<ChapterTarget, 'id' | 'chapterNo' | 'title' | 'status'>,
): string[] {
  const reasons: string[] = [];
  const sourceTrace = candidate.sourceTrace;
  const brief = asRecord(candidate.proposedFields?.craftBrief);

  if (!text(candidate.candidateId, '')) reasons.push('Missing candidateId.');
  if (!text(candidate.chapterId, '')) reasons.push('Missing chapterId.');
  if (!Number.isInteger(candidate.chapterNo) || candidate.chapterNo < 1) reasons.push('chapterNo must be a positive integer.');
  if (!text(candidate.title, '')) reasons.push('Missing title.');
  if (!dbChapter) reasons.push(`Chapter not found in project: ${candidate.chapterId}.`);
  if (dbChapter && dbChapter.chapterNo !== candidate.chapterNo) reasons.push(`chapterNo does not match database chapter: ${candidate.chapterNo}.`);
  if (!isSameCraftBriefSourceTrace(sourceTrace, context)) reasons.push('sourceTrace is not from generate_chapter_craft_brief_preview in the current agent run.');
  if (!brief) {
    reasons.push('Missing proposedFields.craftBrief.');
    return [...new Set(reasons)];
  }
  reasons.push(...validateCraftBriefQuality(brief));
  return [...new Set(reasons)];
}

function validateCraftBriefQuality(brief: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const requiredTextFields = [
    'visibleGoal',
    'hiddenEmotion',
    'coreConflict',
    'mainlineTask',
    'dialogueSubtext',
    'characterShift',
    'irreversibleConsequence',
  ];
  requiredTextFields.forEach((field) => {
    if (!optionalText(brief[field])) reasons.push(`craftBrief.${field} is required.`);
  });
  if (stringArray(brief.subplotTasks).length < 1) reasons.push('craftBrief.subplotTasks must contain at least 1 item.');
  if (stringArray(brief.actionBeats).length < 3) reasons.push('craftBrief.actionBeats must contain at least 3 concrete action beats.');
  if (!normalizeClues(brief.concreteClues, []).length) reasons.push('craftBrief.concreteClues must contain at least 1 tangible clue.');
  if (stringArray(brief.progressTypes).length < 1) reasons.push('craftBrief.progressTypes must contain at least 1 item.');
  return reasons;
}

function isSameCraftBriefSourceTrace(sourceTrace: ChapterCraftBriefSourceTrace | undefined, context: ToolContext): boolean {
  return Boolean(sourceTrace)
    && sourceTrace?.sourceKind === CHAPTER_CRAFT_BRIEF_SOURCE_KIND
    && sourceTrace?.originTool === CHAPTER_CRAFT_BRIEF_ORIGIN_TOOL
    && sourceTrace?.agentRunId === context.agentRunId
    && Number.isInteger(sourceTrace?.candidateIndex)
    && Number.isInteger(sourceTrace?.chapterNo);
}

function normalizeCraftBrief(raw: Record<string, unknown> | undefined, base: { chapterNo: number; title: string; objective: string; conflict: string; outline: string }): ChapterCraftBrief {
  const visibleGoal = text(raw?.visibleGoal, base.objective || `Clarify the concrete goal of chapter ${base.chapterNo}.`);
  const coreConflict = text(raw?.coreConflict, base.conflict || 'A visible obstacle blocks the chapter goal.');
  const mainlineTask = text(raw?.mainlineTask, base.objective || `Advance ${base.title}.`);
  const clueName = compactText(`${base.title} clue`, 80);
  return {
    visibleGoal,
    hiddenEmotion: text(raw?.hiddenEmotion, 'The viewpoint character hides fear, guilt, or desire behind practical action.'),
    coreConflict,
    mainlineTask,
    subplotTasks: stringArray(raw?.subplotTasks).length ? stringArray(raw?.subplotTasks) : ['Advance one relationship, resource, or mystery thread tied to the chapter goal.'],
    actionBeats: padStrings(stringArray(raw?.actionBeats), [
      `Define the immediate move toward: ${visibleGoal}`,
      `Force resistance through: ${coreConflict}`,
      `End the attempt with a changed fact or relationship in chapter ${base.chapterNo}.`,
    ], 3),
    concreteClues: normalizeClues(raw?.concreteClues, [{ name: clueName, sensoryDetail: 'A tangible detail appears on page and can be noticed by a character.', laterUse: 'Use this clue to unlock or complicate a later choice.' }]),
    dialogueSubtext: text(raw?.dialogueSubtext, 'At least one exchange hides the speaker intent behind a practical topic.'),
    characterShift: text(raw?.characterShift, 'The protagonist leaves the chapter with a changed stance, debt, doubt, or commitment.'),
    irreversibleConsequence: text(raw?.irreversibleConsequence, `By the end of chapter ${base.chapterNo}, a fact, relationship, resource, status, rule, or danger level changes and cannot cleanly reset.`),
    progressTypes: stringArray(raw?.progressTypes).length ? stringArray(raw?.progressTypes) : ['plot'],
  };
}

function normalizeClues(value: unknown, fallback: ChapterCraftBrief['concreteClues']): ChapterCraftBrief['concreteClues'] {
  if (!Array.isArray(value)) return fallback;
  const clues = value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      name: compactText(text(item.name, ''), 120),
      ...(optionalText(item.sensoryDetail) ? { sensoryDetail: compactText(optionalText(item.sensoryDetail) ?? '', 240) } : {}),
      ...(optionalText(item.laterUse) ? { laterUse: compactText(optionalText(item.laterUse) ?? '', 240) } : {}),
    }))
    .filter((item) => item.name);
  return clues.length ? clues : fallback;
}

function compactChapterTarget(target: ChapterTarget) {
  return {
    id: target.id,
    volumeId: target.volumeId,
    chapterNo: target.chapterNo,
    title: target.title,
    status: target.status,
    objective: target.objective,
    conflict: target.conflict,
    outline: target.outline,
    hasCraftBrief: hasRecordContent(target.craftBrief),
  };
}

function extractContextSources(context?: Record<string, unknown>): ChapterCraftBriefSourceTrace['contextSources'] {
  if (!context) return [];
  return [
    ...sourceRefs(context.chapters, 'chapter'),
    ...sourceRefs(context.characters, 'character'),
    ...sourceRefs(context.worldFacts, 'lorebook'),
    ...sourceRefs(context.lorebookEntries, 'lorebook'),
    ...sourceRefs(context.sceneCards, 'scene_card'),
    ...sourceRefs(context.pacingTargets, 'pacing_beat'),
    ...sourceRefs(context.memoryChunks, 'memory'),
  ].slice(0, 20);
}

function sourceRefs(value: unknown, sourceType: string): ChapterCraftBriefSourceTrace['contextSources'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      sourceType,
      sourceId: optionalText(item.id),
      title: optionalText(item.title) ?? optionalText(item.name) ?? optionalText(item.summary),
    }));
}

function buildCandidateId(chapterId: string, chapterNo: number, index: number): string {
  const seed = `${chapterId}:${chapterNo}:${index}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `ccb_${chapterNo}_${(hash >>> 0).toString(36)}`;
}

function text(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function optionalText(value: unknown): string | undefined {
  const valueText = text(value, '');
  return valueText || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value) ? value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 1) : [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1))];
}

function positiveInt(value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 1 ? numeric : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hasRecordContent(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(record && Object.keys(record).length > 0);
}

function padStrings(values: string[], fallback: string[], minLength: number): string[] {
  const merged = [...values];
  for (const item of fallback) {
    if (merged.length >= minLength) break;
    merged.push(item);
  }
  return merged.slice(0, Math.max(minLength, merged.length));
}

function compactText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function isLlmTimeout(error: unknown): boolean {
  const record = asRecord(error);
  const name = text(record?.name, '');
  const message = error instanceof Error ? error.message : text(error, '');
  return /timeout/i.test(name) || /timeout|timed out|LLM_TIMEOUT/i.test(message);
}
