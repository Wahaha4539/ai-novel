import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface ListSceneCardsInput {
  volumeId?: string;
  chapterId?: string;
  chapterNo?: number;
  status?: string;
  q?: string;
  limit?: number;
}

export interface ListSceneCardsOutput {
  scenes: SceneCardView[];
  count: number;
}

interface GenerateSceneCardsPreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeId?: string;
  chapterId?: string;
  chapterNo?: number;
  maxScenes?: number;
}

export interface SceneCardSourceTrace {
  sourceKind: 'planned_scene_card';
  originTool: 'generate_scene_cards_preview';
  agentRunId: string;
  candidateIndex: number;
  instruction: string;
  chapterNo?: number;
  contextSources: Array<{ sourceType: string; sourceId?: string; title?: string }>;
}

export interface SceneCardCandidate {
  candidateId: string;
  volumeId: string | null;
  chapterId: string | null;
  sceneNo: number | null;
  title: string;
  locationName: string | null;
  participants: string[];
  purpose: string | null;
  conflict: string | null;
  emotionalTone: string | null;
  keyInformation: string | null;
  result: string | null;
  relatedForeshadowIds: string[];
  status: string;
  sourceTrace: SceneCardSourceTrace;
  metadata: Record<string, unknown> & { sourceKind: 'planned_scene_card' };
  proposedFields: SceneCardWriteFields;
}

export interface SceneCardWriteFields {
  volumeId: string | null;
  chapterId: string | null;
  sceneNo: number | null;
  title: string;
  locationName: string | null;
  participants: string[];
  purpose: string | null;
  conflict: string | null;
  emotionalTone: string | null;
  keyInformation: string | null;
  result: string | null;
  relatedForeshadowIds: string[];
  status: string;
  metadata: Record<string, unknown>;
}

export interface GenerateSceneCardsPreviewOutput {
  candidates: SceneCardCandidate[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    target: 'SceneCard';
    sourceKind: 'planned_scene_card';
    requiresValidation: boolean;
    requiresApprovalBeforePersist: boolean;
  };
}

interface ValidateSceneCardsInput {
  preview?: GenerateSceneCardsPreviewOutput;
  taskContext?: Record<string, unknown>;
}

export interface ValidateSceneCardsOutput {
  valid: boolean;
  accepted: Array<{
    candidateId: string;
    title: string;
    volumeId: string | null;
    chapterId: string | null;
    sceneNo: number | null;
    sourceTrace: SceneCardSourceTrace;
  }>;
  rejected: Array<{
    candidateId: string;
    title: string;
    reasons: string[];
  }>;
  warnings: string[];
  writePreview: {
    target: 'SceneCard';
    requiresApprovalBeforePersist: boolean;
    scenes: Array<SceneCardWriteFields & { action: 'create'; candidateId: string; sourceTrace: SceneCardSourceTrace }>;
  };
}

interface PersistSceneCardsInput {
  preview?: GenerateSceneCardsPreviewOutput;
  validation?: ValidateSceneCardsOutput;
  selectedCandidateIds?: string[];
  selectedTitles?: string[];
}

export interface PersistSceneCardsOutput {
  createdCount: number;
  skippedUnselectedCount: number;
  createdScenes: Array<{ id: string; title: string; chapterId: string | null; sceneNo: number | null }>;
  skippedUnselectedCandidates: Array<{ candidateId: string; title: string }>;
  perSceneAudit: Array<{
    candidateId: string;
    title: string;
    selected: boolean;
    action: 'created' | 'skipped_unselected';
    sceneId: string | null;
    reason: string;
    sourceStep: 'persist_scene_cards';
  }>;
  approval: { required: true; approved: boolean; mode: string };
  persistedAt: string;
  approvalMessage: string;
}

interface UpdateSceneCardInput {
  sceneId?: string;
  volumeId?: string | null;
  chapterId?: string | null;
  sceneNo?: number | null;
  title?: string;
  locationName?: string | null;
  participants?: string[];
  purpose?: string | null;
  conflict?: string | null;
  emotionalTone?: string | null;
  keyInformation?: string | null;
  result?: string | null;
  relatedForeshadowIds?: string[];
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateSceneCardOutput {
  scene: SceneCardView;
  approval: { required: true; approved: boolean; mode: string };
  updatedAt: string;
}

interface SceneCardView {
  id: string;
  projectId: string;
  volumeId: string | null;
  chapterId: string | null;
  sceneNo: number | null;
  title: string;
  locationName: string | null;
  participants: string[];
  purpose: string | null;
  conflict: string | null;
  emotionalTone: string | null;
  keyInformation: string | null;
  result: string | null;
  relatedForeshadowIds: string[];
  status: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

type SceneRefs = { volumeId: string | null; chapterId: string | null };
type ChapterRef = { id: string; volumeId: string | null; chapterNo?: number | null; title?: string | null };
type VolumeRef = { id: string };
type ForeshadowRef = { id: string };
type ExistingSceneRef = { id: string; chapterId: string | null; sceneNo: number | null; title: string };

const SCENE_SOURCE_KIND = 'planned_scene_card' as const;
const SCENE_ORIGIN_TOOL = 'generate_scene_cards_preview' as const;
const SCENE_CARDS_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const SCENE_CARDS_PREVIEW_LLM_RETRIES = 1;
const SCENE_CARDS_PREVIEW_PHASE_TIMEOUT_MS = SCENE_CARDS_PREVIEW_LLM_TIMEOUT_MS * (SCENE_CARDS_PREVIEW_LLM_RETRIES + 1) + 5_000;

@Injectable()
export class ListSceneCardsTool implements BaseTool<ListSceneCardsInput, ListSceneCardsOutput> {
  name = 'list_scene_cards';
  description = 'List SceneCard rows for the current project.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      volumeId: { type: 'string' as const },
      chapterId: { type: 'string' as const },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
      status: { type: 'string' as const, maxLength: 50 },
      q: { type: 'string' as const, maxLength: 200 },
      limit: { type: 'number' as const, minimum: 1, maximum: 100, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['scenes', 'count'],
    properties: {
      scenes: { type: 'array' as const },
      count: { type: 'number' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'List Scene Cards',
    description: 'Read existing SceneCard rows in context.projectId, optionally filtered by chapter, volume, status, or text search.',
    whenToUse: [
      'The user asks what scene cards already exist.',
      'A later update_scene_card step needs a real sceneId from the database.',
      'The agent needs existing SceneCard context before planning or revising scene cards.',
    ],
    whenNotToUse: [
      'The user asks to generate new scene cards; use generate_scene_cards_preview first.',
      'The user asks to write chapter prose.',
      'The agent already has exact SceneCard rows in previous tool output.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterNo: { source: 'user_message', description: 'Natural chapter number when the user says "chapter 3". This tool resolves it to a real chapterId internally.' },
      chapterId: { source: 'resolver', description: 'Use a real chapterId from resolve_chapter or context.session.currentChapterId; do not invent it.' },
      status: { source: 'literal', description: 'Optional SceneCard status filter, such as planned or archived.' },
    },
    examples: [
      { user: 'List the scene cards for chapter 3.', plan: [{ tool: 'list_scene_cards', args: { chapterNo: 3 } }] },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId', 'sceneId'],
      allowedSources: ['projectId from ToolContext only', 'chapterId from resolve_chapter or context', 'sceneId from this tool output'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ListSceneCardsInput, context: ToolContext): Promise<ListSceneCardsOutput> {
    await assertProjectExists(this.prisma, context.projectId);
    const limit = clampInt(args.limit, 50, 1, 100);
    const chapterId = typeof args.chapterNo === 'number'
      ? await findChapterIdByNo(this.prisma, context.projectId, args.chapterNo)
      : text(args.chapterId, '');
    if (typeof args.chapterNo === 'number' && !chapterId) return { scenes: [], count: 0 };

    const rows = await this.prisma.sceneCard.findMany({
      where: buildSceneWhere(context.projectId, { ...args, chapterId: chapterId || undefined }),
      orderBy: [{ chapterId: 'asc' }, { sceneNo: 'asc' }, { updatedAt: 'desc' }],
      take: limit,
    });
    const scenes = rows.map(normalizeSceneCardView);
    return { scenes, count: scenes.length };
  }
}

@Injectable()
export class GenerateSceneCardsPreviewTool implements BaseTool<GenerateSceneCardsPreviewInput, GenerateSceneCardsPreviewOutput> {
  name = 'generate_scene_cards_preview';
  description = 'Generate planned SceneCard candidates without writing to the database.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      volumeId: { type: 'string' as const },
      chapterId: { type: 'string' as const },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
      maxScenes: { type: 'number' as const, minimum: 1, maximum: 12, integer: true },
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
    displayName: 'Generate Scene Card Preview',
    description: 'Create planned SceneCard candidates for chapter/scene planning. This tool only previews candidates and never writes business tables.',
    whenToUse: [
      'The user asks to split a chapter into scenes or create scene cards.',
      'The agent needs SceneCard candidates before validate_scene_cards and persist_scene_cards.',
      'The user asks for scene goals, conflicts, emotional tone, participants, or scene order planning.',
    ],
    whenNotToUse: [
      'The user asks to write final chapter prose.',
      'The user wants to update an existing sceneId directly; use list_scene_cards then update_scene_card.',
      'The plan would claim planned scene events already happened in chapter text.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'Project or chapter context from collect_task_context, collect_chapter_context, inspect_project_context, or list_scene_cards.' },
      instruction: { source: 'user_message', description: 'User request and constraints for scene card planning.' },
      chapterId: { source: 'resolver', description: 'Real chapterId from resolve_chapter or context.session.currentChapterId; do not invent it.' },
      chapterNo: { source: 'user_message', description: 'Numeric chapter reference; this tool resolves it to a real chapter when possible.' },
      maxScenes: { source: 'literal', description: 'Maximum number of SceneCard candidates to preview. Defaults to 5.' },
    },
    examples: [
      {
        user: 'Split chapter 3 into four scene cards.',
        plan: [
          { tool: 'collect_task_context', args: { taskType: 'scene_card_planning', chapterNo: 3, focus: ['outline', 'characters', 'pacing'] } },
          { tool: 'generate_scene_cards_preview', args: { context: '{{steps.collect_task_context.output}}', instruction: '{{user_message}}', chapterNo: 3, maxScenes: 4 } },
          { tool: 'validate_scene_cards', args: { preview: '{{steps.generate_scene_cards_preview.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId', 'sceneId', 'relatedForeshadowIds'],
      allowedSources: ['projectId from ToolContext only', 'chapterId/volumeId from resolve_chapter, context, or DB lookup by chapterNo', 'candidateId generated by this tool', 'relatedForeshadowIds copied from previous context only'],
    },
  };

  constructor(private readonly llm: LlmGatewayService, private readonly prisma: PrismaService) {}

  async run(args: GenerateSceneCardsPreviewInput, context: ToolContext): Promise<GenerateSceneCardsPreviewOutput> {
    const maxScenes = clampInt(args.maxScenes, 5, 1, 12);
    const instruction = text(args.instruction, 'Plan scene cards for the current chapter.');
    await context.updateProgress?.({
      phase: 'preparing_context',
      phaseMessage: '正在读取场景卡上下文',
      progressCurrent: 0,
      progressTotal: maxScenes,
    });
    const target = await resolveTargetRefs(this.prisma, context.projectId, args.volumeId, args.chapterId, args.chapterNo);
    const existingScenes = target.chapterId
      ? await this.prisma.sceneCard.findMany({
          where: { projectId: context.projectId, chapterId: target.chapterId, NOT: { status: 'archived' } },
          orderBy: [{ sceneNo: 'asc' }, { updatedAt: 'asc' }],
          take: 12,
        })
      : [];
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成场景卡预览',
      progressCurrent: 0,
      progressTotal: maxScenes,
      timeoutMs: SCENE_CARDS_PREVIEW_PHASE_TIMEOUT_MS,
    });

    const { data } = await this.llm.chatJson<Partial<GenerateSceneCardsPreviewOutput> & { scenes?: unknown }>(
      [
        {
          role: 'system',
          content:
            'You are the AI Novel scene-card planning agent. Return JSON only, no Markdown. Generate planned SceneCard candidates, not chapter prose. Each candidate should include sceneNo, title, locationName, participants, purpose, conflict, emotionalTone, keyInformation, result, relatedForeshadowIds, status, and metadata. Do not invent database IDs. If you are not given a foreshadow ID, leave relatedForeshadowIds empty.',
        },
        {
          role: 'user',
          content: `Instruction: ${instruction}
Max scenes: ${maxScenes}
Target: ${JSON.stringify(target)}
Existing scene cards:
${JSON.stringify(existingScenes.map(normalizeSceneCardView), null, 2).slice(0, 8000)}
Project context:
${JSON.stringify(args.context ?? {}, null, 2).slice(0, 24000)}`,
        },
      ],
      { appStep: 'planner', maxTokens: Math.min(7000, maxScenes * 700 + 1200), timeoutMs: SCENE_CARDS_PREVIEW_LLM_TIMEOUT_MS, retries: SCENE_CARDS_PREVIEW_LLM_RETRIES },
    );

    const nextSceneNo = Math.max(0, ...existingScenes.map((scene) => Number(scene.sceneNo) || 0)) + 1;
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验场景卡预览', progressCurrent: maxScenes, progressTotal: maxScenes });
    return this.normalize(data, args, context, target, maxScenes, nextSceneNo);
  }

  private normalize(
    data: Partial<GenerateSceneCardsPreviewOutput> & { scenes?: unknown },
    args: GenerateSceneCardsPreviewInput,
    context: ToolContext,
    target: SceneRefs & { chapterNo?: number },
    maxScenes: number,
    nextSceneNo: number,
  ): GenerateSceneCardsPreviewOutput {
    const rawCandidates = Array.isArray(data.candidates) ? data.candidates : Array.isArray(data.scenes) ? data.scenes : [];
    const instruction = text(args.instruction, 'Plan scene cards for the current chapter.');
    const contextSources = extractContextSources(args.context).slice(0, 12);
    const candidates = rawCandidates.slice(0, maxScenes).map((raw, index) => this.normalizeCandidate(raw, index, instruction, contextSources, target, context, nextSceneNo + index));

    return {
      candidates,
      assumptions: stringArray(data.assumptions),
      risks: stringArray(data.risks),
      writePlan: {
        mode: 'preview_only',
        target: 'SceneCard',
        sourceKind: SCENE_SOURCE_KIND,
        requiresValidation: true,
        requiresApprovalBeforePersist: true,
      },
    };
  }

  private normalizeCandidate(
    raw: unknown,
    index: number,
    instruction: string,
    contextSources: SceneCardSourceTrace['contextSources'],
    target: SceneRefs & { chapterNo?: number },
    context: ToolContext,
    defaultSceneNo: number,
  ): SceneCardCandidate {
    const record = asRecord(raw) ?? {};
    const title = compactText(text(record.title, `Scene ${index + 1}`), 255);
    const status = compactText(text(record.status, 'planned'), 50);
    const sceneNo = positiveIntOrNull(record.sceneNo) ?? defaultSceneNo;
    const sourceTrace: SceneCardSourceTrace = {
      sourceKind: SCENE_SOURCE_KIND,
      originTool: SCENE_ORIGIN_TOOL,
      agentRunId: context.agentRunId,
      candidateIndex: index,
      instruction: compactText(instruction, 500),
      ...(target.chapterNo ? { chapterNo: target.chapterNo } : {}),
      contextSources,
    };
    const metadata = {
      ...(asRecord(record.metadata) ?? {}),
      sourceKind: SCENE_SOURCE_KIND,
      lifecycle: 'planned',
      sourceTool: SCENE_ORIGIN_TOOL,
      sourceTrace,
    };
    const fields: SceneCardWriteFields = {
      volumeId: target.volumeId,
      chapterId: target.chapterId,
      sceneNo,
      title,
      locationName: nullableText(record.locationName),
      participants: stringArray(record.participants),
      purpose: nullableText(record.purpose),
      conflict: nullableText(record.conflict),
      emotionalTone: nullableText(record.emotionalTone),
      keyInformation: nullableText(record.keyInformation),
      result: nullableText(record.result),
      relatedForeshadowIds: stringArray(record.relatedForeshadowIds),
      status,
      metadata,
    };

    return {
      candidateId: buildCandidateId(title, sceneNo, index),
      sourceTrace,
      ...fields,
      metadata: metadata as SceneCardCandidate['metadata'],
      proposedFields: fields,
    };
  }
}

@Injectable()
export class ValidateSceneCardsTool implements BaseTool<ValidateSceneCardsInput, ValidateSceneCardsOutput> {
  name = 'validate_scene_cards';
  description = 'Validate SceneCard preview candidates before approved persistence.';
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
    displayName: 'Validate Scene Cards',
    description: 'Check generate_scene_cards_preview output against project refs, duplicate scene numbers, source trace, and write-time safety rules without writing business tables.',
    whenToUse: [
      'generate_scene_cards_preview has produced candidates.',
      'The next step may persist SceneCard rows and needs an approval-ready write preview.',
      'The agent needs to catch duplicate scene numbers or invalid chapter/volume/foreshadow references.',
    ],
    whenNotToUse: [
      'There is no SceneCard preview output.',
      'The user is only asking to list existing scene cards.',
      'The task is final chapter prose writing rather than scene card planning.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_scene_cards_preview.' },
      taskContext: { source: 'previous_step', description: 'Optional project/chapter context for audit visibility; validation uses database refs as source of truth.' },
    },
    examples: [
      {
        user: 'Validate these scene cards before saving.',
        plan: [
          { tool: 'generate_scene_cards_preview', args: { instruction: '{{user_message}}' } },
          { tool: 'validate_scene_cards', args: { preview: '{{steps.generate_scene_cards_preview.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId', 'sceneId', 'candidateId'],
      allowedSources: ['projectId from ToolContext only', 'candidateId/sourceTrace from generate_scene_cards_preview output', 'chapter/volume/foreshadow IDs read from the database'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateSceneCardsInput, context: ToolContext): Promise<ValidateSceneCardsOutput> {
    const candidates = getPreviewCandidates(args.preview);
    if (!args.preview) throw new BadRequestException('validate_scene_cards requires generate_scene_cards_preview output.');
    if (args.preview.writePlan?.sourceKind !== SCENE_SOURCE_KIND || args.preview.writePlan?.target !== 'SceneCard') {
      throw new BadRequestException('SceneCard preview has an invalid writePlan.');
    }
    await assertProjectExists(this.prisma, context.projectId);

    const refs = await loadSceneValidationRefs(this.prisma, context.projectId, candidates);
    const duplicateKeys = findDuplicateSceneKeys(candidates);
    const accepted: ValidateSceneCardsOutput['accepted'] = [];
    const rejected: ValidateSceneCardsOutput['rejected'] = [];
    const writeScenes: ValidateSceneCardsOutput['writePreview']['scenes'] = [];
    const warnings: string[] = [];

    candidates.forEach((candidate) => {
      const reasons = validateCandidate(candidate, context, refs, duplicateKeys);
      const resolved = resolveCandidateWriteRefs(candidate, refs);
      if (reasons.length) {
        rejected.push({ candidateId: text(candidate.candidateId, ''), title: text(candidate.title, ''), reasons });
        return;
      }
      accepted.push({
        candidateId: candidate.candidateId,
        title: candidate.title,
        volumeId: resolved.volumeId,
        chapterId: resolved.chapterId,
        sceneNo: candidate.sceneNo,
        sourceTrace: candidate.sourceTrace,
      });
      writeScenes.push({ action: 'create', candidateId: candidate.candidateId, sourceTrace: candidate.sourceTrace, ...candidate.proposedFields, volumeId: resolved.volumeId, chapterId: resolved.chapterId });
      if (!candidate.conflict) warnings.push(`${candidate.title} has no conflict field; consider adding a visible tension source before writing.`);
      if (!candidate.purpose) warnings.push(`${candidate.title} has no purpose field; consider clarifying what this scene changes.`);
    });

    return {
      valid: candidates.length > 0 && rejected.length === 0,
      accepted,
      rejected,
      warnings: [...new Set(warnings)],
      writePreview: {
        target: 'SceneCard',
        requiresApprovalBeforePersist: true,
        scenes: writeScenes,
      },
    };
  }
}

@Injectable()
export class PersistSceneCardsTool implements BaseTool<PersistSceneCardsInput, PersistSceneCardsOutput> {
  name = 'persist_scene_cards';
  description = 'Persist approved SceneCard preview candidates into SceneCard rows for the current project.';
  inputSchema = {
    type: 'object' as const,
    required: ['preview', 'validation'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      validation: { type: 'object' as const },
      selectedCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      selectedTitles: { type: 'array' as const, items: { type: 'string' as const } },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['createdCount', 'skippedUnselectedCount', 'createdScenes', 'skippedUnselectedCandidates', 'perSceneAudit', 'approval', 'persistedAt', 'approvalMessage'],
    properties: {
      createdCount: { type: 'number' as const, minimum: 0 },
      skippedUnselectedCount: { type: 'number' as const, minimum: 0 },
      createdScenes: { type: 'array' as const },
      skippedUnselectedCandidates: { type: 'array' as const },
      perSceneAudit: { type: 'array' as const },
      approval: { type: 'object' as const },
      persistedAt: { type: 'string' as const },
      approvalMessage: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_scene_cards', 'invalidate_project_recall_cache'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Persist Scene Cards',
    description: 'After user approval, creates SceneCard rows from validate_scene_cards accepted candidates. It rechecks refs and unique scene numbers at write time.',
    whenToUse: [
      'validate_scene_cards has passed and the user approved saving the planned scene cards.',
      'SceneCard preview candidates should become real SceneCard rows.',
      'The write target is only context.projectId and only approved candidates are selected.',
    ],
    whenNotToUse: [
      'The run is in plan mode or lacks explicit user approval.',
      'There is no generate_scene_cards_preview and validate_scene_cards output.',
      'The user wants to edit an existing sceneId; use update_scene_card.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_scene_cards_preview. Required because it contains the write payload.' },
      validation: { source: 'previous_step', description: 'Output from validate_scene_cards. Accepted rows constrain default selection.' },
      selectedCandidateIds: { source: 'previous_step', description: 'Candidate IDs copied from preview/validation output. Unknown IDs are rejected.' },
      selectedTitles: { source: 'previous_step', description: 'Candidate titles copied from preview/validation output. Unknown titles are rejected.' },
    },
    examples: [
      {
        user: 'Save the scene cards.',
        plan: [
          { tool: 'generate_scene_cards_preview', args: { instruction: '{{user_message}}' } },
          { tool: 'validate_scene_cards', args: { preview: '{{steps.generate_scene_cards_preview.output}}' } },
          { tool: 'persist_scene_cards', args: { preview: '{{steps.generate_scene_cards_preview.output}}', validation: '{{steps.validate_scene_cards.output}}' } },
        ],
      },
    ],
    preconditions: ['context.mode must be act', 'context.approved must be true', 'validate_scene_cards.valid must be true'],
    postconditions: ['Creates SceneCard rows only under context.projectId', 'Invalidates project recall cache after successful writes'],
    failureHints: [
      { code: 'APPROVAL_REQUIRED', meaning: 'persist_scene_cards is a write tool and must run only after approval in act mode.', suggestedRepair: 'Ask for user approval and re-run in act mode.' },
      { code: 'UNKNOWN_SELECTION', meaning: 'A selected candidateId or title is not present in the preview.', suggestedRepair: 'Use candidateId or title from generate_scene_cards_preview output.' },
      { code: 'VALIDATION_FAILED', meaning: 'The selected candidates no longer pass write-time validation.', suggestedRepair: 'Run validate_scene_cards again and resolve rejected candidates.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'volumeId', 'sceneId', 'candidateId'],
      allowedSources: ['projectId from ToolContext only', 'candidateId from generate_scene_cards_preview output', 'chapter/volume IDs from preview sourceTrace or database validation'],
    },
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  async run(args: PersistSceneCardsInput, context: ToolContext): Promise<PersistSceneCardsOutput> {
    this.assertExecutableInput(args, context);
    const candidates = getPreviewCandidates(args.preview);
    const selected = selectSceneCandidates(args, candidates);
    assertSelectedAllowedByValidation(args.validation, selected, context);

    const selectedIds = new Set(selected.map((candidate) => candidate.candidateId));
    const skippedUnselectedCandidates = candidates
      .filter((candidate) => !selectedIds.has(candidate.candidateId))
      .map((candidate) => ({ candidateId: candidate.candidateId, title: candidate.title }));
    const persistedAt = new Date().toISOString();

    const result = await this.prisma.$transaction(async (tx) => {
      const refs = await loadSceneValidationRefs(tx, context.projectId, selected);
      const duplicateKeys = findDuplicateSceneKeys(selected);
      const createdScenes: PersistSceneCardsOutput['createdScenes'] = [];
      const perSceneAudit: PersistSceneCardsOutput['perSceneAudit'] = [];

      for (const candidate of selected) {
        const reasons = validateCandidate(candidate, context, refs, duplicateKeys);
        if (reasons.length) throw new BadRequestException(`SceneCard write-time validation failed for ${candidate.title}: ${reasons.join('; ')}`);
        const resolved = resolveCandidateWriteRefs(candidate, refs);
        const created = await tx.sceneCard.create({
          data: {
            projectId: context.projectId,
            volumeId: resolved.volumeId,
            chapterId: resolved.chapterId,
            sceneNo: candidate.sceneNo,
            title: candidate.title,
            locationName: candidate.locationName,
            participants: toJsonValue(candidate.participants),
            purpose: candidate.purpose,
            conflict: candidate.conflict,
            emotionalTone: candidate.emotionalTone,
            keyInformation: candidate.keyInformation,
            result: candidate.result,
            relatedForeshadowIds: toJsonValue(candidate.relatedForeshadowIds),
            status: candidate.status,
            metadata: toJsonValue(buildPersistMetadata(candidate, context, persistedAt)),
          },
          select: { id: true, title: true, chapterId: true, sceneNo: true },
        });
        createdScenes.push(created);
        perSceneAudit.push({ candidateId: candidate.candidateId, title: created.title, selected: true, action: 'created', sceneId: created.id, reason: 'Approved SceneCard candidate created.', sourceStep: 'persist_scene_cards' });
      }

      skippedUnselectedCandidates.forEach((candidate) => {
        perSceneAudit.push({ candidateId: candidate.candidateId, title: candidate.title, selected: false, action: 'skipped_unselected', sceneId: null, reason: 'Candidate was not selected for this approved persist step.', sourceStep: 'persist_scene_cards' });
      });

      return {
        createdCount: createdScenes.length,
        skippedUnselectedCount: skippedUnselectedCandidates.length,
        createdScenes,
        skippedUnselectedCandidates,
        perSceneAudit,
        approval: { required: true as const, approved: context.approved, mode: context.mode },
        persistedAt,
        approvalMessage: 'SceneCard candidates were persisted only after approval, under context.projectId, with write-time validation.',
      };
    });

    if (result.createdCount > 0) await this.cacheService.deleteProjectRecallResults(context.projectId);
    return result;
  }

  private assertExecutableInput(args: PersistSceneCardsInput, context: ToolContext) {
    if (context.mode !== 'act') throw new BadRequestException('persist_scene_cards can only run in Agent act mode.');
    if (!context.approved) throw new BadRequestException('persist_scene_cards requires explicit user approval.');
    if (!args.preview) throw new BadRequestException('persist_scene_cards requires generate_scene_cards_preview output.');
    if (!args.validation) throw new BadRequestException('persist_scene_cards requires validate_scene_cards output.');
    if (args.validation.valid !== true) throw new BadRequestException('validate_scene_cards did not pass; persist_scene_cards will not write.');
    if (args.preview.writePlan?.requiresApprovalBeforePersist !== true) throw new BadRequestException('SceneCard preview did not declare approval-before-persist.');
    if (args.preview.writePlan?.sourceKind !== SCENE_SOURCE_KIND || args.preview.writePlan?.target !== 'SceneCard') throw new BadRequestException('SceneCard preview has an invalid writePlan.');
    if (!getPreviewCandidates(args.preview).length) throw new BadRequestException('persist_scene_cards requires at least one preview candidate.');
  }
}

@Injectable()
export class UpdateSceneCardTool implements BaseTool<UpdateSceneCardInput, UpdateSceneCardOutput> {
  name = 'update_scene_card';
  description = 'Update one existing SceneCard row in the current project after approval.';
  inputSchema = {
    type: 'object' as const,
    required: ['sceneId'],
    additionalProperties: false,
    properties: {
      sceneId: { type: 'string' as const },
      volumeId: { type: ['string', 'null'] as const },
      chapterId: { type: ['string', 'null'] as const },
      sceneNo: { type: ['number', 'null'] as const, minimum: 1, integer: true },
      title: { type: 'string' as const, maxLength: 255 },
      locationName: { type: ['string', 'null'] as const },
      participants: { type: 'array' as const, items: { type: 'string' as const } },
      purpose: { type: ['string', 'null'] as const },
      conflict: { type: ['string', 'null'] as const },
      emotionalTone: { type: ['string', 'null'] as const },
      keyInformation: { type: ['string', 'null'] as const },
      result: { type: ['string', 'null'] as const },
      relatedForeshadowIds: { type: 'array' as const, items: { type: 'string' as const } },
      status: { type: 'string' as const, maxLength: 50 },
      metadata: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['scene', 'approval', 'updatedAt'],
    properties: {
      scene: { type: 'object' as const },
      approval: { type: 'object' as const },
      updatedAt: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['update_scene_card', 'invalidate_project_recall_cache'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Update Scene Card',
    description: 'After user approval, updates one existing SceneCard row in context.projectId. sceneId must come from list_scene_cards or prior database output.',
    whenToUse: [
      'The user asks to modify an existing scene card.',
      'list_scene_cards has returned the target sceneId.',
      'The update is scoped to one SceneCard row and should preserve unrelated fields.',
    ],
    whenNotToUse: [
      'The user asks to generate multiple new scene cards; use generate_scene_cards_preview.',
      'The agent only has a natural-language scene title and no sceneId; list_scene_cards first.',
      'The run is in plan mode or lacks explicit user approval.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      sceneId: { source: 'previous_step', description: 'Real SceneCard id from list_scene_cards or prior tool output; do not invent it.' },
      chapterId: { source: 'resolver', description: 'Optional real chapterId from resolve_chapter when rebinding a scene card.' },
      sceneNo: { source: 'user_message', description: 'Optional new order number inside the bound chapter.' },
    },
    examples: [
      {
        user: 'Make the second scene more tense.',
        plan: [
          { tool: 'list_scene_cards', args: { chapterNo: 3 } },
          { tool: 'update_scene_card', args: { sceneId: '{{steps.list_scene_cards.output.scenes.1.id}}', emotionalTone: 'tense', conflict: 'The clue points at an ally, forcing the protagonist to hide suspicion.' } },
        ],
      },
    ],
    preconditions: ['context.mode must be act', 'context.approved must be true', 'sceneId must exist under context.projectId'],
    postconditions: ['Updates only the requested SceneCard row', 'Invalidates project recall cache after update'],
    failureHints: [
      { code: 'APPROVAL_REQUIRED', meaning: 'update_scene_card is a write tool and must run only after approval in act mode.', suggestedRepair: 'Ask for user approval and rerun in act mode.' },
      { code: 'SCENE_NOT_FOUND', meaning: 'sceneId does not exist in context.projectId.', suggestedRepair: 'Run list_scene_cards and use one of the returned ids.' },
      { code: 'SCENE_NO_CONFLICT', meaning: 'chapterId + sceneNo conflicts with another SceneCard.', suggestedRepair: 'Choose a different sceneNo or update the other SceneCard first.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'sceneId', 'chapterId', 'volumeId'],
      allowedSources: ['projectId from ToolContext only', 'sceneId from list_scene_cards or previous tool output', 'chapterId/volumeId from resolver, context, or existing SceneCard row'],
    },
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  async run(args: UpdateSceneCardInput, context: ToolContext): Promise<UpdateSceneCardOutput> {
    if (context.mode !== 'act') throw new BadRequestException('update_scene_card can only run in Agent act mode.');
    if (!context.approved) throw new BadRequestException('update_scene_card requires explicit user approval.');
    const sceneId = text(args.sceneId, '');
    if (!sceneId) throw new BadRequestException('update_scene_card requires sceneId.');

    const existing = await this.prisma.sceneCard.findFirst({
      where: { id: sceneId, projectId: context.projectId },
      select: { id: true, projectId: true, volumeId: true, chapterId: true, sceneNo: true },
    });
    if (!existing) throw new NotFoundException(`SceneCard not found: ${sceneId}`);

    const refs = args.volumeId !== undefined || args.chapterId !== undefined
      ? await resolveRefs(this.prisma, context.projectId, args.volumeId !== undefined ? args.volumeId : existing.volumeId, args.chapterId !== undefined ? args.chapterId : existing.chapterId)
      : { volumeId: existing.volumeId, chapterId: existing.chapterId };
    const nextSceneNo = args.sceneNo !== undefined ? args.sceneNo : existing.sceneNo;
    await assertSceneNoAvailable(this.prisma, context.projectId, refs.chapterId, nextSceneNo, sceneId);

    const data = buildSceneUpdateData(args, refs);
    const updated = await this.prisma.sceneCard.update({ where: { id: sceneId }, data });
    await this.cacheService.deleteProjectRecallResults(context.projectId);
    return {
      scene: normalizeSceneCardView(updated),
      approval: { required: true, approved: context.approved, mode: context.mode },
      updatedAt: new Date().toISOString(),
    };
  }
}

function buildSceneWhere(projectId: string, query: ListSceneCardsInput): Prisma.SceneCardWhereInput {
  return {
    projectId,
    ...(query.volumeId ? { volumeId: query.volumeId } : {}),
    ...(query.chapterId ? { chapterId: query.chapterId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: 'insensitive' } },
            { locationName: { contains: query.q, mode: 'insensitive' } },
            { purpose: { contains: query.q, mode: 'insensitive' } },
            { conflict: { contains: query.q, mode: 'insensitive' } },
            { keyInformation: { contains: query.q, mode: 'insensitive' } },
            { result: { contains: query.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

async function assertProjectExists(prisma: Pick<PrismaService, 'project'>, projectId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
  if (!project) throw new NotFoundException(`Project not found: ${projectId}`);
}

async function findChapterIdByNo(prisma: Pick<PrismaService, 'chapter'>, projectId: string, chapterNo: number): Promise<string | undefined> {
  const chapter = await prisma.chapter.findFirst({ where: { projectId, chapterNo }, select: { id: true } });
  return chapter?.id;
}

async function resolveTargetRefs(
  prisma: Pick<PrismaService, 'project' | 'volume' | 'chapter'>,
  projectId: string,
  volumeId?: string | null,
  chapterId?: string | null,
  chapterNo?: number,
): Promise<SceneRefs & { chapterNo?: number }> {
  await assertProjectExists(prisma, projectId);
  const chapter = chapterId
    ? await prisma.chapter.findFirst({ where: { id: chapterId, projectId }, select: { id: true, volumeId: true, chapterNo: true, title: true } })
    : typeof chapterNo === 'number'
      ? await prisma.chapter.findFirst({ where: { projectId, chapterNo }, select: { id: true, volumeId: true, chapterNo: true, title: true } })
      : null;
  if ((chapterId || typeof chapterNo === 'number') && !chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId ?? chapterNo}`);
  const volume = volumeId
    ? await prisma.volume.findFirst({ where: { id: volumeId, projectId }, select: { id: true } })
    : null;
  if (volumeId && !volume) throw new NotFoundException(`Volume not found in project: ${volumeId}`);
  if (chapter && volumeId && chapter.volumeId !== volumeId) throw new BadRequestException(`chapterId does not belong to volumeId: ${chapter.id}`);
  return {
    volumeId: chapter ? chapter.volumeId : volumeId ?? null,
    chapterId: chapter?.id ?? null,
    ...(chapter?.chapterNo ? { chapterNo: chapter.chapterNo } : {}),
  };
}

async function resolveRefs(
  prisma: Pick<PrismaService, 'volume' | 'chapter'>,
  projectId: string,
  volumeId?: string | null,
  chapterId?: string | null,
): Promise<SceneRefs> {
  const volume = volumeId ? await prisma.volume.findFirst({ where: { id: volumeId, projectId }, select: { id: true } }) : null;
  if (volumeId && !volume) throw new NotFoundException(`Volume not found in project: ${volumeId}`);
  const chapter = chapterId ? await prisma.chapter.findFirst({ where: { id: chapterId, projectId }, select: { id: true, volumeId: true } }) : null;
  if (chapterId && !chapter) throw new NotFoundException(`Chapter not found in project: ${chapterId}`);
  if (chapter && volumeId && chapter.volumeId !== volumeId) throw new BadRequestException(`chapterId does not belong to volumeId: ${chapterId}`);
  return { volumeId: chapter ? chapter.volumeId : volumeId ?? null, chapterId: chapterId ?? null };
}

async function assertSceneNoAvailable(
  prisma: Pick<PrismaService, 'sceneCard'>,
  projectId: string,
  chapterId: string | null,
  sceneNo: number | null,
  excludeSceneId?: string,
) {
  if (!chapterId || sceneNo === null) return;
  const conflict = await prisma.sceneCard.findFirst({
    where: {
      projectId,
      chapterId,
      sceneNo,
      ...(excludeSceneId ? { NOT: { id: excludeSceneId } } : {}),
    },
    select: { id: true, title: true },
  });
  if (conflict) throw new BadRequestException(`SceneCard sceneNo already exists in chapter: ${sceneNo} (${conflict.title})`);
}

async function loadSceneValidationRefs(
  prisma: Pick<PrismaService, 'volume' | 'chapter' | 'foreshadowTrack' | 'sceneCard'> | Prisma.TransactionClient,
  projectId: string,
  candidates: SceneCardCandidate[],
): Promise<{
  volumes: Map<string, VolumeRef>;
  chapters: Map<string, ChapterRef>;
  foreshadows: Set<string>;
  existingSceneKeyMap: Map<string, ExistingSceneRef>;
}> {
  const volumeIds = unique(candidates.map((candidate) => candidate.volumeId).filter(isNonEmptyString));
  const chapterIds = unique(candidates.map((candidate) => candidate.chapterId).filter(isNonEmptyString));
  const foreshadowIds = unique(candidates.flatMap((candidate) => candidate.relatedForeshadowIds));
  const [volumes, chapters, foreshadows, existingScenes] = await Promise.all([
    volumeIds.length ? prisma.volume.findMany({ where: { projectId, id: { in: volumeIds } }, select: { id: true } }) : Promise.resolve([]),
    chapterIds.length ? prisma.chapter.findMany({ where: { projectId, id: { in: chapterIds } }, select: { id: true, volumeId: true, chapterNo: true, title: true } }) : Promise.resolve([]),
    foreshadowIds.length ? prisma.foreshadowTrack.findMany({ where: { projectId, id: { in: foreshadowIds } }, select: { id: true } }) : Promise.resolve([]),
    chapterIds.length ? prisma.sceneCard.findMany({ where: { projectId, chapterId: { in: chapterIds } }, select: { id: true, chapterId: true, sceneNo: true, title: true } }) : Promise.resolve([]),
  ]);

  return {
    volumes: new Map((volumes as VolumeRef[]).map((item) => [item.id, item])),
    chapters: new Map((chapters as ChapterRef[]).map((item) => [item.id, item])),
    foreshadows: new Set((foreshadows as ForeshadowRef[]).map((item) => item.id)),
    existingSceneKeyMap: new Map((existingScenes as ExistingSceneRef[]).filter((item) => item.chapterId && item.sceneNo !== null).map((item) => [`${item.chapterId}:${item.sceneNo}`, item])),
  };
}

function validateCandidate(
  candidate: SceneCardCandidate,
  context: ToolContext,
  refs: Awaited<ReturnType<typeof loadSceneValidationRefs>>,
  duplicateKeys: Set<string>,
): string[] {
  const reasons: string[] = [];
  const title = text(candidate.title, '');
  const sourceTrace = asRecord(candidate.sourceTrace);
  const chapter = candidate.chapterId ? refs.chapters.get(candidate.chapterId) : undefined;
  const volumeId = candidate.volumeId ?? chapter?.volumeId ?? null;
  const sceneKey = candidate.chapterId && candidate.sceneNo !== null ? `${candidate.chapterId}:${candidate.sceneNo}` : '';

  if (!candidate.candidateId) reasons.push('Missing candidateId.');
  if (!title) reasons.push('Missing title.');
  if (title.length > 255) reasons.push('Title is longer than 255 characters.');
  if (candidate.status.length > 50) reasons.push('Status is longer than 50 characters.');
  if (candidate.sceneNo !== null && (!Number.isInteger(candidate.sceneNo) || candidate.sceneNo < 1)) reasons.push('sceneNo must be a positive integer.');
  if (!sourceTrace || sourceTrace.sourceKind !== SCENE_SOURCE_KIND || sourceTrace.originTool !== SCENE_ORIGIN_TOOL || sourceTrace.agentRunId !== context.agentRunId) reasons.push('sourceTrace is not from generate_scene_cards_preview in the current agent run.');
  if (candidate.volumeId && !refs.volumes.has(candidate.volumeId)) reasons.push(`Volume not found in project: ${candidate.volumeId}.`);
  if (candidate.chapterId && !chapter) reasons.push(`Chapter not found in project: ${candidate.chapterId}.`);
  if (candidate.chapterId && chapter && candidate.volumeId && chapter.volumeId !== candidate.volumeId) reasons.push(`chapterId does not belong to volumeId: ${candidate.chapterId}.`);
  if (volumeId && candidate.volumeId && candidate.volumeId !== volumeId) reasons.push(`Resolved volumeId mismatch: ${candidate.volumeId}.`);
  if (sceneKey && duplicateKeys.has(sceneKey)) reasons.push(`Duplicate candidate sceneNo in chapter: ${candidate.sceneNo}.`);
  if (sceneKey && refs.existingSceneKeyMap.has(sceneKey)) reasons.push(`SceneCard sceneNo already exists in chapter: ${candidate.sceneNo}.`);
  candidate.relatedForeshadowIds.forEach((id) => {
    if (!refs.foreshadows.has(id)) reasons.push(`ForeshadowTrack not found in project: ${id}.`);
  });
  if (!Array.isArray(candidate.participants) || candidate.participants.some((item) => typeof item !== 'string')) reasons.push('participants must be an array of strings.');
  if (!Array.isArray(candidate.relatedForeshadowIds) || candidate.relatedForeshadowIds.some((item) => typeof item !== 'string')) reasons.push('relatedForeshadowIds must be an array of strings.');
  return [...new Set(reasons)];
}

function resolveCandidateWriteRefs(candidate: SceneCardCandidate, refs: Awaited<ReturnType<typeof loadSceneValidationRefs>>): SceneRefs {
  const chapter = candidate.chapterId ? refs.chapters.get(candidate.chapterId) : undefined;
  return {
    volumeId: candidate.volumeId ?? chapter?.volumeId ?? null,
    chapterId: candidate.chapterId ?? null,
  };
}

function findDuplicateSceneKeys(candidates: SceneCardCandidate[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  candidates.forEach((candidate) => {
    if (!candidate.chapterId || candidate.sceneNo === null) return;
    const key = `${candidate.chapterId}:${candidate.sceneNo}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  });
  return duplicates;
}

function getPreviewCandidates(preview?: GenerateSceneCardsPreviewOutput): SceneCardCandidate[] {
  if (!preview || !Array.isArray(preview.candidates)) return [];
  return preview.candidates.filter((item): item is SceneCardCandidate => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function selectSceneCandidates(args: PersistSceneCardsInput, candidates: SceneCardCandidate[]): SceneCardCandidate[] {
  const selectedCandidateIds = stringArray(args.selectedCandidateIds);
  const selectedTitles = stringArray(args.selectedTitles);
  const candidateIdSet = new Set(candidates.map((candidate) => candidate.candidateId));
  const titleSet = new Set(candidates.map((candidate) => candidate.title));
  const unknownIds = selectedCandidateIds.filter((candidateId) => !candidateIdSet.has(candidateId));
  if (unknownIds.length) throw new BadRequestException(`Unknown SceneCard candidateId selection: ${unknownIds.join(', ')}`);
  const unknownTitles = selectedTitles.filter((title) => !titleSet.has(title));
  if (unknownTitles.length) throw new BadRequestException(`Unknown SceneCard title selection: ${unknownTitles.join(', ')}`);

  if (selectedCandidateIds.length) {
    const selectedSet = new Set(selectedCandidateIds);
    return candidates.filter((candidate) => selectedSet.has(candidate.candidateId));
  }
  if (selectedTitles.length) {
    const selectedSet = new Set(selectedTitles);
    return candidates.filter((candidate) => selectedSet.has(candidate.title));
  }
  const acceptedIds = new Set(stringArray(args.validation?.accepted?.map((item) => item.candidateId)));
  return acceptedIds.size ? candidates.filter((candidate) => acceptedIds.has(candidate.candidateId)) : candidates;
}

function assertSelectedAllowedByValidation(validation: ValidateSceneCardsOutput | undefined, selected: SceneCardCandidate[], context: ToolContext) {
  if (!validation) throw new BadRequestException('persist_scene_cards requires validate_scene_cards output.');
  const acceptedById = new Map(validation.accepted.map((item) => [item.candidateId, item]));
  const writeById = new Map(validation.writePreview?.scenes?.map((item) => [item.candidateId, item]) ?? []);
  const rejectedIds = new Set(validation.rejected.map((item) => item.candidateId));
  const errors: string[] = [];
  selected.forEach((candidate) => {
    const accepted = acceptedById.get(candidate.candidateId);
    const write = writeById.get(candidate.candidateId);
    if (rejectedIds.has(candidate.candidateId)) errors.push(`${candidate.title} was rejected by validate_scene_cards`);
    if (!accepted) errors.push(`${candidate.title} was not accepted by validate_scene_cards`);
    if (!write) errors.push(`${candidate.title} is missing validate_scene_cards writePreview`);
    if (accepted && accepted.title !== candidate.title) errors.push(`${candidate.candidateId} title does not match validate_scene_cards output`);
    if (!isSameSceneSourceTrace(candidate.sourceTrace, accepted?.sourceTrace) || candidate.sourceTrace.agentRunId !== context.agentRunId) errors.push(`${candidate.title} sourceTrace does not match validate_scene_cards output`);
  });
  if (errors.length) throw new BadRequestException(`validate_scene_cards output does not approve selected candidates: ${[...new Set(errors)].join('; ')}`);
}

function buildPersistMetadata(candidate: SceneCardCandidate, context: ToolContext, persistedAt: string): Record<string, unknown> {
  const record = { ...(asRecord(candidate.metadata) ?? {}) };
  delete record.locked;
  delete record.isLocked;
  delete record.lockState;
  return {
    ...record,
    sourceKind: SCENE_SOURCE_KIND,
    sourceType: 'agent_scene_card',
    sourceTool: 'persist_scene_cards',
    sourceTrace: candidate.sourceTrace,
    sceneCardCandidateId: candidate.candidateId,
    agentRunId: context.agentRunId,
    persistedAt,
  };
}

function buildSceneUpdateData(args: UpdateSceneCardInput, refs: SceneRefs): Prisma.SceneCardUpdateInput {
  if (args.title !== undefined && !text(args.title, '')) throw new BadRequestException('title cannot be empty.');
  if (args.status !== undefined && !text(args.status, '')) throw new BadRequestException('status cannot be empty.');
  if (args.metadata !== undefined && !asRecord(args.metadata)) throw new BadRequestException('metadata must be a JSON object.');
  const data: Prisma.SceneCardUpdateInput = {
    volume: refs.volumeId === null ? { disconnect: true } : { connect: { id: refs.volumeId } },
    chapter: refs.chapterId === null ? { disconnect: true } : { connect: { id: refs.chapterId } },
  };
  if (args.sceneNo !== undefined) data.sceneNo = args.sceneNo;
  if (args.title !== undefined) data.title = args.title;
  if (args.locationName !== undefined) data.locationName = args.locationName;
  if (args.participants !== undefined) data.participants = toJsonValue(stringArray(args.participants));
  if (args.purpose !== undefined) data.purpose = args.purpose;
  if (args.conflict !== undefined) data.conflict = args.conflict;
  if (args.emotionalTone !== undefined) data.emotionalTone = args.emotionalTone;
  if (args.keyInformation !== undefined) data.keyInformation = args.keyInformation;
  if (args.result !== undefined) data.result = args.result;
  if (args.relatedForeshadowIds !== undefined) data.relatedForeshadowIds = toJsonValue(stringArray(args.relatedForeshadowIds));
  if (args.status !== undefined) data.status = compactText(args.status, 50);
  if (args.metadata !== undefined) data.metadata = toJsonValue(args.metadata);
  return data;
}

function normalizeSceneCardView(row: Record<string, unknown>): SceneCardView {
  return {
    id: text(row.id, ''),
    projectId: text(row.projectId, ''),
    volumeId: nullableId(row.volumeId),
    chapterId: nullableId(row.chapterId),
    sceneNo: positiveIntOrNull(row.sceneNo),
    title: text(row.title, ''),
    locationName: nullableText(row.locationName),
    participants: stringArray(row.participants),
    purpose: nullableText(row.purpose),
    conflict: nullableText(row.conflict),
    emotionalTone: nullableText(row.emotionalTone),
    keyInformation: nullableText(row.keyInformation),
    result: nullableText(row.result),
    relatedForeshadowIds: stringArray(row.relatedForeshadowIds),
    status: text(row.status, 'planned'),
    metadata: asRecord(row.metadata) ?? {},
    ...(row.createdAt instanceof Date ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt instanceof Date ? { updatedAt: row.updatedAt } : {}),
  };
}

function extractContextSources(context?: Record<string, unknown>): SceneCardSourceTrace['contextSources'] {
  if (!context) return [];
  return [
    ...sourceRefs(context.chapters, 'chapter'),
    ...sourceRefs(context.characters, 'character'),
    ...sourceRefs(context.worldFacts, 'lorebook'),
    ...sourceRefs(context.lorebookEntries, 'lorebook'),
    ...sourceRefs(context.pacingTargets, 'pacing_beat'),
    ...sourceRefs(context.sceneCards, 'scene_card'),
    ...sourceRefs(context.memoryChunks, 'memory'),
  ];
}

function sourceRefs(value: unknown, sourceType: string): SceneCardSourceTrace['contextSources'] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => ({
      sourceType,
      sourceId: text(item.id, '') || undefined,
      title: text(item.title, '') || text(item.name, '') || text(item.summary, '') || undefined,
    }));
}

function buildCandidateId(title: string, sceneNo: number | null, index: number): string {
  const seed = `${index}:${sceneNo ?? 'null'}:${title}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `scc_${index + 1}_${(hash >>> 0).toString(36)}`;
}

function isSameSceneSourceTrace(left?: SceneCardSourceTrace, right?: SceneCardSourceTrace): boolean {
  return Boolean(left && right)
    && left?.sourceKind === right?.sourceKind
    && left?.originTool === right?.originTool
    && left?.agentRunId === right?.agentRunId
    && left?.candidateIndex === right?.candidateIndex;
}

function text(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

function nullableText(value: unknown): string | null {
  const valueText = text(value, '');
  return valueText || null;
}

function nullableId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function positiveIntOrNull(value: unknown): number | null {
  const numberValue = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  return Number.isInteger(numberValue) && numberValue >= 1 ? numberValue : null;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}
