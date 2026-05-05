import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

type ContinuityAction = 'create' | 'update' | 'delete';
type ContinuityCandidateType = 'relationship' | 'timeline';
type ContinuityIssueSeverity = 'warning' | 'error';

interface GenerateContinuityPreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  focus?: string[];
  maxRelationshipCandidates?: number;
  maxTimelineCandidates?: number;
}

interface ValidateContinuityChangesInput {
  preview?: ContinuityPreviewOutput;
  taskContext?: Record<string, unknown>;
}

interface PersistContinuityChangesInput {
  preview?: ContinuityPreviewOutput;
  validation?: ValidateContinuityChangesOutput;
  selectedCandidateIds?: string[];
  selectedRelationshipCandidateIds?: string[];
  selectedTimelineCandidateIds?: string[];
  dryRun?: boolean;
}

export interface ContinuitySourceTrace {
  sourceKind: 'planned_continuity_change';
  originTool: 'generate_continuity_preview';
  agentRunId: string;
  candidateType: ContinuityCandidateType;
  candidateIndex: number;
  instruction: string;
  focus: string[];
  contextSources: Array<{ sourceType: string; sourceId?: string; title?: string }>;
}

export interface ContinuityRelationshipCandidate {
  candidateId: string;
  action: ContinuityAction;
  existingRelationshipId?: string;
  characterAId?: string;
  characterBId?: string;
  characterAName?: string;
  characterBName?: string;
  relationType?: string;
  publicState?: string;
  hiddenState?: string;
  conflictPoint?: string;
  emotionalArc?: string;
  turnChapterNos: number[];
  finalState?: string;
  status?: string;
  impactAnalysis: string;
  conflictRisk: string;
  sourceTrace: ContinuitySourceTrace;
  metadata: Record<string, unknown> & { sourceKind: 'planned_continuity_change' };
  diffKey: { characterAName?: string; characterBName?: string; relationType?: string; existingRelationshipId?: string };
  proposedFields: Record<string, unknown>;
}

export interface ContinuityTimelineCandidate {
  candidateId: string;
  action: ContinuityAction;
  existingTimelineEventId?: string;
  chapterId?: string;
  chapterNo?: number;
  title?: string;
  eventTime?: string;
  locationName?: string;
  participants: string[];
  participantIds?: string[];
  cause?: string;
  result?: string;
  impactScope?: string;
  isPublic?: boolean;
  knownBy: string[];
  knownByIds?: string[];
  unknownBy: string[];
  unknownByIds?: string[];
  eventStatus?: string;
  impactAnalysis: string;
  conflictRisk: string;
  sourceTrace: ContinuitySourceTrace;
  metadata: Record<string, unknown> & { sourceKind: 'planned_continuity_change' };
  diffKey: { chapterNo?: number; title?: string; eventTime?: string; existingTimelineEventId?: string };
  proposedFields: Record<string, unknown>;
}

export interface ContinuityPreviewOutput {
  relationshipCandidates: ContinuityRelationshipCandidate[];
  timelineCandidates: ContinuityTimelineCandidate[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    sourceKind: 'planned_continuity_change';
    targets: ['RelationshipEdge', 'TimelineEvent'];
    relationshipCandidates: { target: 'RelationshipEdge'; count: number; allowedActions: ContinuityAction[] };
    timelineCandidates: { target: 'TimelineEvent'; count: number; allowedActions: ContinuityAction[] };
    requiresValidation: boolean;
    requiresApprovalBeforePersist: boolean;
  };
}

interface ContinuityValidationIssue {
  severity: ContinuityIssueSeverity;
  candidateType?: ContinuityCandidateType;
  candidateId?: string;
  action?: ContinuityAction | string;
  message: string;
  path?: string;
  suggestion?: string;
}

interface ContinuityAcceptedCandidate {
  candidateId: string;
  action: ContinuityAction;
  existingId: string | null;
  label: string;
  sourceTrace?: ContinuitySourceTrace;
}

interface ContinuityRejectedCandidate {
  candidateId: string;
  action: ContinuityAction | string;
  label: string;
  reason: string;
  issues: string[];
}

interface ContinuityWritePreviewEntry {
  candidateId: string;
  action: ContinuityAction | 'reject';
  existingId: string | null;
  label: string;
  reason?: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  fieldDiff: Record<string, boolean>;
  sourceTrace?: ContinuitySourceTrace;
}

export interface ValidateContinuityChangesOutput {
  valid: boolean;
  issueCount: number;
  issues: ContinuityValidationIssue[];
  accepted: {
    relationshipCandidates: ContinuityAcceptedCandidate[];
    timelineCandidates: ContinuityAcceptedCandidate[];
  };
  rejected: {
    relationshipCandidates: ContinuityRejectedCandidate[];
    timelineCandidates: ContinuityRejectedCandidate[];
  };
  writePreview: {
    projectScope: 'context.projectId';
    sourceKind: 'planned_continuity_change';
    relationshipCandidates: {
      target: 'RelationshipEdge';
      summary: { createCount: number; updateCount: number; deleteCount: number; rejectCount: number };
      entries: ContinuityWritePreviewEntry[];
    };
    timelineCandidates: {
      target: 'TimelineEvent';
      summary: { createCount: number; updateCount: number; deleteCount: number; rejectCount: number };
      entries: ContinuityWritePreviewEntry[];
    };
    approvalMessage: string;
  };
}

interface PersistContinuityChangesOutput {
  dryRun: boolean;
  relationshipResults: ContinuityPersistSectionResult;
  timelineResults: ContinuityPersistSectionResult;
  skippedUnselectedCandidates: {
    relationshipCandidates: Array<{ candidateId: string; label: string }>;
    timelineCandidates: Array<{ candidateId: string; label: string }>;
  };
  writePreview: {
    relationshipCandidates: ContinuityWritePreviewEntry[];
    timelineCandidates: ContinuityWritePreviewEntry[];
  };
  approval: { required: true; approved: boolean; mode: string };
  persistedAt: string | null;
  approvalMessage: string;
}

interface ContinuityPersistSectionResult {
  createdCount: number;
  updatedCount: number;
  deletedCount: number;
  created: Array<{ id: string; label: string }>;
  updated: Array<{ id: string; label: string }>;
  deleted: Array<{ id: string; label: string }>;
}

interface ExistingRelationshipEdge {
  id: string;
  characterAId: string | null;
  characterBId: string | null;
  characterAName: string;
  characterBName: string;
  relationType: string;
  publicState: string | null;
  hiddenState: string | null;
  conflictPoint: string | null;
  emotionalArc: string | null;
  turnChapterNos: unknown;
  finalState: string | null;
  status: string;
  sourceType: string;
  metadata: unknown;
  updatedAt?: Date;
}

interface ExistingTimelineEvent {
  id: string;
  chapterId: string | null;
  chapterNo: number | null;
  title: string;
  eventTime: string | null;
  locationName: string | null;
  participants: unknown;
  cause: string | null;
  result: string | null;
  impactScope: string | null;
  isPublic: boolean;
  knownBy: unknown;
  unknownBy: unknown;
  eventStatus: string;
  sourceType: string;
  metadata: unknown;
  updatedAt?: Date;
}

interface CharacterRef {
  id: string;
  name: string;
}

interface ChapterRef {
  id: string;
  chapterNo: number;
}

interface RelationshipPersistDecision {
  candidate: ContinuityRelationshipCandidate;
  action: ContinuityAction;
  existing: ExistingRelationshipEdge | null;
}

interface TimelinePersistDecision {
  candidate: ContinuityTimelineCandidate;
  action: ContinuityAction;
  existing: ExistingTimelineEvent | null;
  chapterRef?: { chapterId: string | null; chapterNo: number | null };
}

abstract class ContinuityToolSupport {
  protected readonly sourceKind = 'planned_continuity_change' as const;

  protected asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  protected recordArray(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  }

  protected text(value: unknown, fallback = ''): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }

  protected optionalText(value: unknown): string | undefined {
    const text = this.text(value, '');
    return text || undefined;
  }

  protected stringArray(value: unknown): string[] {
    return Array.isArray(value)
      ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))]
      : [];
  }

  protected idArray(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
      return [...new Set(value.map((item) => this.text(item, '')).filter(Boolean))];
    }
    const text = this.text(value, '');
    return text ? [text] : [];
  }

  protected numberArray(value: unknown): number[] {
    return Array.isArray(value)
      ? [...new Set(value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))]
      : [];
  }

  protected boolValue(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  protected readAction(value: unknown): ContinuityAction | '' {
    return value === 'create' || value === 'update' || value === 'delete' ? value : '';
  }

  protected normalizeAction(value: unknown): ContinuityAction {
    const action = this.readAction(value);
    return action || 'create';
  }

  protected compactText(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  protected normalizeTextKey(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  protected looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$/i.test(value);
  }

  protected buildCandidateId(prefix: string, seed: string, index: number): string {
    let hash = 2166136261;
    const source = `${index}:${seed}`;
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${prefix}_${index + 1}_${(hash >>> 0).toString(36)}`;
  }

  protected relationshipLabel(candidate: ContinuityRelationshipCandidate, existing?: ExistingRelationshipEdge | null): string {
    const a = candidate.characterAName || existing?.characterAName || 'unknown A';
    const b = candidate.characterBName || existing?.characterBName || 'unknown B';
    const type = candidate.relationType || existing?.relationType || candidate.action;
    return `${a} -> ${b} (${type})`;
  }

  protected timelineLabel(candidate: ContinuityTimelineCandidate, existing?: ExistingTimelineEvent | null): string {
    return candidate.title || existing?.title || candidate.existingTimelineEventId || candidate.candidateId;
  }

  protected relationshipAfter(candidate: ContinuityRelationshipCandidate, existing?: ExistingRelationshipEdge | null): Record<string, unknown> {
    return {
      characterAId: candidate.characterAId ?? existing?.characterAId ?? null,
      characterBId: candidate.characterBId ?? existing?.characterBId ?? null,
      characterAName: candidate.characterAName || existing?.characterAName || '',
      characterBName: candidate.characterBName || existing?.characterBName || '',
      relationType: candidate.relationType || existing?.relationType || '',
      publicState: candidate.publicState ?? existing?.publicState ?? null,
      hiddenState: candidate.hiddenState ?? existing?.hiddenState ?? null,
      conflictPoint: candidate.conflictPoint ?? existing?.conflictPoint ?? null,
      emotionalArc: candidate.emotionalArc ?? existing?.emotionalArc ?? null,
      turnChapterNos: candidate.turnChapterNos.length ? candidate.turnChapterNos : this.numberArray(existing?.turnChapterNos),
      finalState: candidate.finalState ?? existing?.finalState ?? null,
      status: candidate.status || existing?.status || 'active',
      sourceType: 'agent_continuity',
      metadata: { sourceKind: this.sourceKind, sourceTrace: candidate.sourceTrace },
    };
  }

  protected timelineAfter(candidate: ContinuityTimelineCandidate, existing?: ExistingTimelineEvent | null, chapterRef?: { chapterId: string | null; chapterNo: number | null }): Record<string, unknown> {
    return {
      chapterId: chapterRef?.chapterId ?? candidate.chapterId ?? existing?.chapterId ?? null,
      chapterNo: chapterRef?.chapterNo ?? candidate.chapterNo ?? existing?.chapterNo ?? null,
      title: candidate.title || existing?.title || '',
      eventTime: candidate.eventTime ?? existing?.eventTime ?? null,
      locationName: candidate.locationName ?? existing?.locationName ?? null,
      participants: candidate.participants.length ? candidate.participants : this.stringArray(existing?.participants),
      cause: candidate.cause ?? existing?.cause ?? null,
      result: candidate.result ?? existing?.result ?? null,
      impactScope: candidate.impactScope ?? existing?.impactScope ?? null,
      isPublic: candidate.isPublic ?? existing?.isPublic ?? false,
      knownBy: candidate.knownBy.length ? candidate.knownBy : this.stringArray(existing?.knownBy),
      unknownBy: candidate.unknownBy.length ? candidate.unknownBy : this.stringArray(existing?.unknownBy),
      eventStatus: candidate.eventStatus || existing?.eventStatus || 'active',
      sourceType: 'agent_continuity',
      metadata: { sourceKind: this.sourceKind, sourceTrace: candidate.sourceTrace },
    };
  }

  protected relationshipBefore(existing: ExistingRelationshipEdge): Record<string, unknown> {
    return {
      id: existing.id,
      characterAId: existing.characterAId,
      characterBId: existing.characterBId,
      characterAName: existing.characterAName,
      characterBName: existing.characterBName,
      relationType: existing.relationType,
      publicState: existing.publicState,
      hiddenState: existing.hiddenState,
      conflictPoint: existing.conflictPoint,
      emotionalArc: existing.emotionalArc,
      turnChapterNos: this.numberArray(existing.turnChapterNos),
      finalState: existing.finalState,
      status: existing.status,
      sourceType: existing.sourceType,
      updatedAt: existing.updatedAt?.toISOString(),
    };
  }

  protected timelineBefore(existing: ExistingTimelineEvent): Record<string, unknown> {
    return {
      id: existing.id,
      chapterId: existing.chapterId,
      chapterNo: existing.chapterNo,
      title: existing.title,
      eventTime: existing.eventTime,
      locationName: existing.locationName,
      participants: this.stringArray(existing.participants),
      cause: existing.cause,
      result: existing.result,
      impactScope: existing.impactScope,
      isPublic: existing.isPublic,
      knownBy: this.stringArray(existing.knownBy),
      unknownBy: this.stringArray(existing.unknownBy),
      eventStatus: existing.eventStatus,
      sourceType: existing.sourceType,
      updatedAt: existing.updatedAt?.toISOString(),
    };
  }

  protected relationshipKeyFromAfter(after: Record<string, unknown>): string {
    const a = this.normalizeTextKey(this.text(after.characterAId, '') || this.text(after.characterAName, ''));
    const b = this.normalizeTextKey(this.text(after.characterBId, '') || this.text(after.characterBName, ''));
    const endpoints = [a, b].sort().join('|');
    return `${endpoints}|${this.normalizeTextKey(this.text(after.relationType, ''))}`;
  }

  protected timelineKeyFromAfter(after: Record<string, unknown>): string {
    const chapter = this.text(after.chapterId, '') || this.text(after.chapterNo, '') || 'unspecified';
    return `${chapter}|${this.normalizeTextKey(this.text(after.title, ''))}|${this.normalizeTextKey(this.text(after.eventTime, ''))}`;
  }

  protected relationshipKeyFromExisting(existing: ExistingRelationshipEdge): string {
    const a = this.normalizeTextKey(this.text(existing.characterAId, '') || existing.characterAName);
    const b = this.normalizeTextKey(this.text(existing.characterBId, '') || existing.characterBName);
    const endpoints = [a, b].sort().join('|');
    return `${endpoints}|${this.normalizeTextKey(existing.relationType)}`;
  }

  protected timelineKeyFromExisting(existing: ExistingTimelineEvent): string {
    const chapter = this.text(existing.chapterId, '') || this.text(existing.chapterNo, '') || 'unspecified';
    return `${chapter}|${this.normalizeTextKey(existing.title)}|${this.normalizeTextKey(this.text(existing.eventTime, ''))}`;
  }

  protected fieldDiff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, boolean> {
    if (!after) return {};
    if (!before) return Object.fromEntries(Object.keys(after).map((key) => [key, true]));
    return Object.fromEntries(Object.keys(after).map((key) => [key, JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)]));
  }

  protected sourceTraceMatchesCurrentRun(sourceTrace: unknown, context: ToolContext, candidateType: ContinuityCandidateType): boolean {
    const trace = this.asRecord(sourceTrace);
    return Boolean(trace)
      && trace?.sourceKind === this.sourceKind
      && trace?.originTool === 'generate_continuity_preview'
      && trace?.agentRunId === context.agentRunId
      && trace?.candidateType === candidateType;
  }

  protected sameSourceTrace(left: unknown, right: unknown): boolean {
    const a = this.asRecord(left);
    const b = this.asRecord(right);
    return Boolean(a && b)
      && a?.sourceKind === b?.sourceKind
      && a?.originTool === b?.originTool
      && a?.agentRunId === b?.agentRunId
      && a?.candidateType === b?.candidateType
      && Number(a?.candidateIndex) === Number(b?.candidateIndex);
  }

  protected findDuplicateStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.filter(Boolean).forEach((value) => {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  protected toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}

@Injectable()
export class GenerateContinuityPreviewTool extends ContinuityToolSupport implements BaseTool<GenerateContinuityPreviewInput, ContinuityPreviewOutput> {
  name = 'generate_continuity_preview';
  description = 'Generate relationship and timeline continuity candidates without writing to the database.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      focus: { type: 'array' as const, items: { type: 'string' as const } },
      maxRelationshipCandidates: { type: 'number' as const, minimum: 0, maximum: 20, integer: true },
      maxTimelineCandidates: { type: 'number' as const, minimum: 0, maximum: 20, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['relationshipCandidates', 'timelineCandidates', 'assumptions', 'risks', 'writePlan'],
    properties: {
      relationshipCandidates: { type: 'array' as const },
      timelineCandidates: { type: 'array' as const },
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
    displayName: 'Generate Continuity Preview',
    description: 'Creates separate RelationshipEdge and TimelineEvent change candidates. This is read-only and never writes business tables.',
    whenToUse: [
      'The user asks to repair, extend, or inspect relationship/timeline continuity and needs proposed structured changes.',
      'Before validate_continuity_changes and any approved persist_continuity_changes step.',
      'The agent needs a diff-friendly plan for relationship and timeline fact-layer writes.',
    ],
    whenNotToUse: [
      'The user only wants prose rewriting with no structured relationship or timeline change.',
      'The user wants an immediate write; validate_continuity_changes and approved persist_continuity_changes must run later.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'Project context from inspect_project_context or collect_task_context.' },
      instruction: { source: 'user_message', description: 'User request and constraints for relationship/timeline continuity.' },
      focus: { source: 'literal', description: 'Optional focus such as relationship_graph, timeline_order, knowledge_visibility.' },
      maxRelationshipCandidates: { source: 'literal', description: 'Maximum RelationshipEdge candidates. Defaults to 5.' },
      maxTimelineCandidates: { source: 'literal', description: 'Maximum TimelineEvent candidates. Defaults to 5.' },
    },
    examples: [
      {
        user: 'Check relationship and timeline continuity, then prepare approved changes if needed.',
        plan: [
          { tool: 'collect_task_context', args: { taskType: 'continuity_check', focus: ['relationship_graph', 'timeline_events', 'plot_facts'] } },
          { tool: 'generate_continuity_preview', args: { context: '{{steps.collect_task_context.output}}', instruction: '{{user_message}}' } },
          { tool: 'validate_continuity_changes', args: { preview: '{{steps.generate_continuity_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'characterId', 'chapterId', 'relationshipId', 'timelineEventId'],
      allowedSources: ['projectId from ToolContext only', 'IDs copied from context, resolver output, or existing preview references'],
    },
  };

  constructor(private readonly llm: LlmGatewayService) {
    super();
  }

  async run(args: GenerateContinuityPreviewInput, context: ToolContext): Promise<ContinuityPreviewOutput> {
    const maxRelationshipCandidates = Math.min(20, Math.max(0, Number(args.maxRelationshipCandidates ?? 5) || 5));
    const maxTimelineCandidates = Math.min(20, Math.max(0, Number(args.maxTimelineCandidates ?? 5) || 5));
    const focus = this.stringArray(args.focus);
    const instruction = this.text(args.instruction, 'Plan continuity relationship/timeline changes.');
    const { data } = await this.llm.chatJson<Partial<ContinuityPreviewOutput> & { relationships?: unknown; timeline?: unknown; timelineEvents?: unknown }>(
      [
        {
          role: 'system',
          content:
            'You are the AI Novel continuity planning agent. Return JSON only, no Markdown. Produce separate relationshipCandidates and timelineCandidates arrays. This is a preview only: never claim anything was written. Relationship candidates target RelationshipEdge and may use action create/update/delete. Timeline candidates target TimelineEvent and may use action create/update/delete. Use natural-language names for participants, knownBy, and unknownBy. If you include participantIds, knownByIds, or unknownByIds, they must be UUID strings copied from context, never names. Include source impact/conflict analysis, but do not include projectId.',
        },
        {
          role: 'user',
          content: `Instruction: ${instruction}
Focus: ${focus.join(', ') || 'continuity_check'}
Max relationship candidates: ${maxRelationshipCandidates}
Max timeline candidates: ${maxTimelineCandidates}
Project context:
${JSON.stringify(args.context ?? {}, null, 2).slice(0, 28000)}`,
        },
      ],
      { appStep: 'planner', maxTokens: Math.min(10000, (maxRelationshipCandidates + maxTimelineCandidates) * 800 + 1600), timeoutMs: 120_000, retries: 1 },
    );

    return this.normalize(data, args, context, maxRelationshipCandidates, maxTimelineCandidates);
  }

  private normalize(data: Partial<ContinuityPreviewOutput> & { relationships?: unknown; timeline?: unknown; timelineEvents?: unknown }, args: GenerateContinuityPreviewInput, context: ToolContext, maxRelationships: number, maxTimeline: number): ContinuityPreviewOutput {
    const record = this.asRecord(data) ?? {};
    const focus = this.stringArray(args.focus);
    const instruction = this.text(args.instruction, 'Plan continuity relationship/timeline changes.');
    const contextSources = this.extractContextSources(args.context).slice(0, 16);
    const rawRelationships = this.recordArray(record.relationshipCandidates).length ? this.recordArray(record.relationshipCandidates) : this.recordArray(record.relationships);
    const rawTimeline = this.recordArray(record.timelineCandidates).length
      ? this.recordArray(record.timelineCandidates)
      : this.recordArray(record.timelineEvents).length
        ? this.recordArray(record.timelineEvents)
        : this.recordArray(record.timeline);

    const relationshipCandidates = rawRelationships
      .slice(0, maxRelationships)
      .map((candidate, index) => this.normalizeRelationshipCandidate(candidate, index, instruction, focus, contextSources, context));
    const timelineCandidates = rawTimeline
      .slice(0, maxTimeline)
      .map((candidate, index) => this.normalizeTimelineCandidate(candidate, index, instruction, focus, contextSources, context));

    return {
      relationshipCandidates,
      timelineCandidates,
      assumptions: this.stringArray(record.assumptions),
      risks: this.stringArray(record.risks),
      writePlan: {
        mode: 'preview_only',
        sourceKind: this.sourceKind,
        targets: ['RelationshipEdge', 'TimelineEvent'],
        relationshipCandidates: { target: 'RelationshipEdge', count: relationshipCandidates.length, allowedActions: ['create', 'update', 'delete'] },
        timelineCandidates: { target: 'TimelineEvent', count: timelineCandidates.length, allowedActions: ['create', 'update', 'delete'] },
        requiresValidation: true,
        requiresApprovalBeforePersist: true,
      },
    };
  }

  private normalizeRelationshipCandidate(record: Record<string, unknown>, index: number, instruction: string, focus: string[], contextSources: ContinuitySourceTrace['contextSources'], context: ToolContext): ContinuityRelationshipCandidate {
    const action = this.normalizeAction(record.action);
    const existingRelationshipId = this.optionalText(record.existingRelationshipId ?? record.relationshipId);
    const characterAName = this.optionalText(record.characterAName);
    const characterBName = this.optionalText(record.characterBName);
    const relationType = this.optionalText(record.relationType);
    const seed = `${action}:${existingRelationshipId ?? ''}:${characterAName ?? ''}:${characterBName ?? ''}:${relationType ?? ''}`;
    const sourceTrace: ContinuitySourceTrace = {
      sourceKind: this.sourceKind,
      originTool: 'generate_continuity_preview',
      agentRunId: context.agentRunId,
      candidateType: 'relationship',
      candidateIndex: index,
      instruction: this.compactText(instruction, 500),
      focus,
      contextSources,
    };
    const candidateId = this.optionalText(record.candidateId) || this.buildCandidateId('relc', seed, index);
    const metadata = {
      ...(this.asRecord(record.metadata) ?? {}),
      sourceKind: this.sourceKind,
      lifecycle: 'planned',
      sourceTool: 'generate_continuity_preview',
      sourceTrace,
    };
    const candidate: ContinuityRelationshipCandidate = {
      candidateId,
      action,
      ...(existingRelationshipId ? { existingRelationshipId } : {}),
      ...(this.optionalText(record.characterAId) ? { characterAId: this.optionalText(record.characterAId) } : {}),
      ...(this.optionalText(record.characterBId) ? { characterBId: this.optionalText(record.characterBId) } : {}),
      ...(characterAName ? { characterAName } : {}),
      ...(characterBName ? { characterBName } : {}),
      ...(relationType ? { relationType } : {}),
      ...(this.optionalText(record.publicState) ? { publicState: this.optionalText(record.publicState) } : {}),
      ...(this.optionalText(record.hiddenState) ? { hiddenState: this.optionalText(record.hiddenState) } : {}),
      ...(this.optionalText(record.conflictPoint) ? { conflictPoint: this.optionalText(record.conflictPoint) } : {}),
      ...(this.optionalText(record.emotionalArc) ? { emotionalArc: this.optionalText(record.emotionalArc) } : {}),
      turnChapterNos: this.numberArray(record.turnChapterNos),
      ...(this.optionalText(record.finalState) ? { finalState: this.optionalText(record.finalState) } : {}),
      ...(this.optionalText(record.status) ? { status: this.optionalText(record.status) } : {}),
      impactAnalysis: this.text(record.impactAnalysis, 'Validate before persist; only write approved same-project continuity changes.'),
      conflictRisk: this.text(record.conflictRisk, 'Requires validation against existing relationship graph and character references.'),
      sourceTrace,
      metadata,
      diffKey: { characterAName, characterBName, relationType, existingRelationshipId },
      proposedFields: {},
    };
    candidate.proposedFields = this.relationshipAfter(candidate);
    return candidate;
  }

  private normalizeTimelineCandidate(record: Record<string, unknown>, index: number, instruction: string, focus: string[], contextSources: ContinuitySourceTrace['contextSources'], context: ToolContext): ContinuityTimelineCandidate {
    const action = this.normalizeAction(record.action);
    const existingTimelineEventId = this.optionalText(record.existingTimelineEventId ?? record.timelineEventId);
    const title = this.optionalText(record.title);
    const eventTime = this.optionalText(record.eventTime);
    const chapterNo = Number(record.chapterNo);
    const sourceTrace: ContinuitySourceTrace = {
      sourceKind: this.sourceKind,
      originTool: 'generate_continuity_preview',
      agentRunId: context.agentRunId,
      candidateType: 'timeline',
      candidateIndex: index,
      instruction: this.compactText(instruction, 500),
      focus,
      contextSources,
    };
    const seed = `${action}:${existingTimelineEventId ?? ''}:${title ?? ''}:${eventTime ?? ''}:${Number.isInteger(chapterNo) ? chapterNo : ''}`;
    const candidateId = this.optionalText(record.candidateId) || this.buildCandidateId('tlc', seed, index);
    const metadata = {
      ...(this.asRecord(record.metadata) ?? {}),
      sourceKind: this.sourceKind,
      lifecycle: 'planned',
      sourceTool: 'generate_continuity_preview',
      sourceTrace,
    };
    const participantIds = this.idArray(record.participantIds);
    const knownByIds = this.idArray(record.knownByIds);
    const unknownByIds = this.idArray(record.unknownByIds);
    const candidate: ContinuityTimelineCandidate = {
      candidateId,
      action,
      ...(existingTimelineEventId ? { existingTimelineEventId } : {}),
      ...(this.optionalText(record.chapterId) ? { chapterId: this.optionalText(record.chapterId) } : {}),
      ...(Number.isInteger(chapterNo) && chapterNo > 0 ? { chapterNo } : {}),
      ...(title ? { title } : {}),
      ...(eventTime ? { eventTime } : {}),
      ...(this.optionalText(record.locationName) ? { locationName: this.optionalText(record.locationName) } : {}),
      participants: this.stringArray(record.participants),
      ...(participantIds !== undefined ? { participantIds } : {}),
      ...(this.optionalText(record.cause) ? { cause: this.optionalText(record.cause) } : {}),
      ...(this.optionalText(record.result) ? { result: this.optionalText(record.result) } : {}),
      ...(this.optionalText(record.impactScope) ? { impactScope: this.optionalText(record.impactScope) } : {}),
      ...(this.boolValue(record.isPublic) !== undefined ? { isPublic: this.boolValue(record.isPublic) } : {}),
      knownBy: this.stringArray(record.knownBy),
      ...(knownByIds !== undefined ? { knownByIds } : {}),
      unknownBy: this.stringArray(record.unknownBy),
      ...(unknownByIds !== undefined ? { unknownByIds } : {}),
      ...(this.optionalText(record.eventStatus) ? { eventStatus: this.optionalText(record.eventStatus) } : {}),
      impactAnalysis: this.text(record.impactAnalysis, 'Validate before persist; only write approved same-project timeline changes.'),
      conflictRisk: this.text(record.conflictRisk, 'Requires validation against chapter references, duplicate events, and knowledge visibility.'),
      sourceTrace,
      metadata,
      diffKey: { chapterNo: Number.isInteger(chapterNo) && chapterNo > 0 ? chapterNo : undefined, title, eventTime, existingTimelineEventId },
      proposedFields: {},
    };
    candidate.proposedFields = this.timelineAfter(candidate);
    return candidate;
  }

  private extractContextSources(context?: Record<string, unknown>): ContinuitySourceTrace['contextSources'] {
    if (!context) return [];
    return [
      ...this.sourceRefs(context.relationshipGraph, 'relationship_edge'),
      ...this.sourceRefs(context.relationships, 'relationship_edge'),
      ...this.sourceRefs(context.timelineEvents, 'timeline_event'),
      ...this.sourceRefs(context.plotEvents, 'story_event'),
      ...this.sourceRefs(context.characters, 'character'),
      ...this.sourceRefs(context.chapters, 'chapter'),
      ...this.sourceRefs(context.worldFacts, 'lorebook'),
    ];
  }

  private sourceRefs(value: unknown, sourceType: string): ContinuitySourceTrace['contextSources'] {
    return this.recordArray(value).map((item) => ({
      sourceType,
      sourceId: this.optionalText(item.id),
      title: this.optionalText(item.title) || this.optionalText(item.name) || this.optionalText(item.summary),
    }));
  }
}

@Injectable()
export class ValidateContinuityChangesTool extends ContinuityToolSupport implements BaseTool<ValidateContinuityChangesInput, ValidateContinuityChangesOutput> {
  name = 'validate_continuity_changes';
  description = 'Validate relationship and timeline continuity candidates, producing accepted/rejected candidates and a read-only write preview.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      taskContext: { type: 'object' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['valid', 'issueCount', 'issues', 'accepted', 'rejected', 'writePreview'],
    properties: {
      valid: { type: 'boolean' as const },
      issueCount: { type: 'number' as const },
      issues: { type: 'array' as const },
      accepted: { type: 'object' as const },
      rejected: { type: 'object' as const },
      writePreview: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Validate Continuity Changes',
    description: 'Read-only validation for generate_continuity_preview output. Checks same-project characters, chapters, existing relationship/timeline IDs, duplicate/conflicting writes, and source traces.',
    whenToUse: [
      'After generate_continuity_preview and before persist_continuity_changes.',
      'When relationshipCandidates and timelineCandidates need accepted/rejected lists and an approval-ready diff.',
      'When user-selected continuity writes must be constrained to current-project facts.',
    ],
    whenNotToUse: [
      'There is no continuity preview output.',
      'The user only wants prose and no structured continuity write.',
      'This must not be used as the approved write step.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_continuity_preview.' },
      taskContext: { source: 'previous_step', description: 'Optional task context retained for traceability; database validation uses context.projectId.' },
    },
    failureHints: [
      { code: 'VALIDATION_FAILED', meaning: 'A candidate has invalid references, duplicates, source trace mismatch, or cross-project IDs.', suggestedRepair: 'Regenerate or select only accepted candidates from writePreview.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'characterId', 'chapterId', 'relationshipId', 'timelineEventId'],
      allowedSources: ['candidateId from generate_continuity_preview', 'existing IDs read from current project rows', 'projectId from ToolContext only'],
    },
  };

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async run(args: ValidateContinuityChangesInput, context: ToolContext): Promise<ValidateContinuityChangesOutput> {
    const relationshipCandidates = this.getRelationshipCandidates(args.preview);
    const timelineCandidates = this.getTimelineCandidates(args.preview);
    const issues: ContinuityValidationIssue[] = [];

    if (!args.preview) {
      issues.push({ severity: 'error', message: 'Missing continuity preview. Run generate_continuity_preview first.' });
      return this.buildOutput(issues, [], [], [], []);
    }
    if (!relationshipCandidates.length && !timelineCandidates.length) {
      issues.push({ severity: 'error', message: 'Continuity preview contains no relationshipCandidates or timelineCandidates.' });
      return this.buildOutput(issues, [], [], [], []);
    }

    const [relationships, timelineEvents, characters, chaptersById, chaptersByNo] = await Promise.all([
      this.loadRelationships(context.projectId),
      this.loadTimelineEvents(context.projectId),
      this.loadCharacters(context.projectId, this.collectCharacterIds(relationshipCandidates, timelineCandidates)),
      this.loadChaptersById(context.projectId, timelineCandidates.map((candidate) => this.optionalText(candidate.chapterId)).filter((id): id is string => Boolean(id))),
      this.loadChaptersByNo(context.projectId, timelineCandidates.map((candidate) => candidate.chapterNo).filter((value): value is number => Number.isInteger(value))),
    ]);

    const relationshipById = new Map(relationships.map((item) => [item.id, item]));
    const timelineById = new Map(timelineEvents.map((item) => [item.id, item]));
    const duplicateRelationshipCandidateIds = new Set(this.findDuplicateStrings(relationshipCandidates.map((candidate) => this.text(candidate.candidateId, ''))));
    const duplicateTimelineCandidateIds = new Set(this.findDuplicateStrings(timelineCandidates.map((candidate) => this.text(candidate.candidateId, ''))));
    const duplicateRelationshipTargets = new Set(this.findDuplicateStrings(relationshipCandidates.map((candidate) => candidate.action !== 'create' ? this.text(candidate.existingRelationshipId, '') : '').filter(Boolean)));
    const duplicateTimelineTargets = new Set(this.findDuplicateStrings(timelineCandidates.map((candidate) => candidate.action !== 'create' ? this.text(candidate.existingTimelineEventId, '') : '').filter(Boolean)));
    const duplicateRelationshipWriteKeys = new Set(this.findDuplicateStrings(relationshipCandidates.map((candidate) => this.relationshipWriteKey(candidate, relationshipById.get(this.text(candidate.existingRelationshipId, '')))).filter(Boolean)));
    const duplicateTimelineWriteKeys = new Set(this.findDuplicateStrings(timelineCandidates.map((candidate) => this.timelineWriteKey(candidate, timelineById.get(this.text(candidate.existingTimelineEventId, '')), chaptersById, chaptersByNo)).filter(Boolean)));

    const relationshipAccepted: ContinuityAcceptedCandidate[] = [];
    const relationshipRejected: ContinuityRejectedCandidate[] = [];
    const relationshipWriteEntries: ContinuityWritePreviewEntry[] = [];
    relationshipCandidates.forEach((candidate, index) => {
      const candidateIssues = this.validateRelationshipCandidate(candidate, index, context, relationshipById, relationships, characters, duplicateRelationshipCandidateIds, duplicateRelationshipTargets, duplicateRelationshipWriteKeys);
      issues.push(...candidateIssues);
      const errors = candidateIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
      const existing = relationshipById.get(this.text(candidate.existingRelationshipId, '')) ?? null;
      const label = this.relationshipLabel(candidate, existing);
      const before = existing ? this.relationshipBefore(existing) : null;
      const after = candidate.action === 'delete' ? null : this.relationshipAfter(candidate, existing);
      const writeEntry = this.buildWriteEntry(candidate.candidateId, candidate.action, existing?.id ?? null, label, before, after, candidate.sourceTrace, errors);
      relationshipWriteEntries.push(writeEntry);
      if (errors.length) relationshipRejected.push({ candidateId: candidate.candidateId, action: candidate.action, label, reason: errors.join('; '), issues: errors });
      else relationshipAccepted.push({ candidateId: candidate.candidateId, action: candidate.action, existingId: existing?.id ?? null, label, sourceTrace: candidate.sourceTrace });
    });

    const timelineAccepted: ContinuityAcceptedCandidate[] = [];
    const timelineRejected: ContinuityRejectedCandidate[] = [];
    const timelineWriteEntries: ContinuityWritePreviewEntry[] = [];
    timelineCandidates.forEach((candidate, index) => {
      const candidateIssues = this.validateTimelineCandidate(candidate, index, context, timelineById, timelineEvents, characters, chaptersById, chaptersByNo, duplicateTimelineCandidateIds, duplicateTimelineTargets, duplicateTimelineWriteKeys);
      issues.push(...candidateIssues);
      const errors = candidateIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
      const existing = timelineById.get(this.text(candidate.existingTimelineEventId, '')) ?? null;
      const chapterRef = this.resolveChapterPreviewRef(candidate, chaptersById, chaptersByNo);
      const label = this.timelineLabel(candidate, existing);
      const before = existing ? this.timelineBefore(existing) : null;
      const after = candidate.action === 'delete' ? null : this.timelineAfter(candidate, existing, chapterRef);
      const writeEntry = this.buildWriteEntry(candidate.candidateId, candidate.action, existing?.id ?? null, label, before, after, candidate.sourceTrace, errors);
      timelineWriteEntries.push(writeEntry);
      if (errors.length) timelineRejected.push({ candidateId: candidate.candidateId, action: candidate.action, label, reason: errors.join('; '), issues: errors });
      else timelineAccepted.push({ candidateId: candidate.candidateId, action: candidate.action, existingId: existing?.id ?? null, label, sourceTrace: candidate.sourceTrace });
    });

    return this.buildOutput(issues, relationshipAccepted, relationshipRejected, timelineAccepted, timelineRejected, relationshipWriteEntries, timelineWriteEntries);
  }

  private validateRelationshipCandidate(
    candidate: ContinuityRelationshipCandidate,
    index: number,
    context: ToolContext,
    relationshipById: Map<string, ExistingRelationshipEdge>,
    relationships: ExistingRelationshipEdge[],
    characters: Map<string, CharacterRef>,
    duplicateCandidateIds: Set<string>,
    duplicateTargets: Set<string>,
    duplicateWriteKeys: Set<string>,
  ): ContinuityValidationIssue[] {
    const issues: ContinuityValidationIssue[] = [];
    const action = this.readAction(candidate.action);
    const candidateId = this.text(candidate.candidateId, `relationship_${index + 1}`);
    const existingId = this.text(candidate.existingRelationshipId, '');
    const existing = relationshipById.get(existingId) ?? null;
    const after = this.relationshipAfter(candidate, existing);
    const writeKey = action === 'delete' ? '' : this.relationshipKeyFromAfter(after);

    if (!candidate.candidateId) issues.push(this.issue('error', 'relationship', candidateId, action, 'Candidate is missing candidateId.', `relationshipCandidates[${index}].candidateId`));
    if (duplicateCandidateIds.has(candidateId)) issues.push(this.issue('error', 'relationship', candidateId, action, `Duplicate relationship candidateId: ${candidateId}.`));
    if (!action) issues.push(this.issue('error', 'relationship', candidateId, candidate.action, `Invalid relationship action: ${this.text(candidate.action, '<missing>')}.`));
    if (!this.sourceTraceMatchesCurrentRun(candidate.sourceTrace, context, 'relationship')) issues.push(this.issue('error', 'relationship', candidateId, action, 'Relationship candidate sourceTrace is not from generate_continuity_preview in the current agent run.', `relationshipCandidates[${index}].sourceTrace`));
    this.validateExplicitProjectId(candidate, context, issues, 'relationship', candidateId, action, `relationshipCandidates[${index}]`);

    if (action === 'create' && existingId) issues.push(this.issue('error', 'relationship', candidateId, action, 'Create relationship candidate must not include existingRelationshipId.', `relationshipCandidates[${index}].existingRelationshipId`));
    if ((action === 'update' || action === 'delete') && !existingId) issues.push(this.issue('error', 'relationship', candidateId, action, `${action} relationship candidate requires existingRelationshipId.`, `relationshipCandidates[${index}].existingRelationshipId`));
    if (existingId && !this.looksLikeUuid(existingId)) issues.push(this.issue('error', 'relationship', candidateId, action, `existingRelationshipId is not a UUID: ${existingId}.`, `relationshipCandidates[${index}].existingRelationshipId`));
    else if (existingId && !existing) issues.push(this.issue('error', 'relationship', candidateId, action, `existingRelationshipId does not belong to current project: ${existingId}.`, `relationshipCandidates[${index}].existingRelationshipId`));
    if (existingId && duplicateTargets.has(existingId)) issues.push(this.issue('error', 'relationship', candidateId, action, `Multiple relationship candidates target the same existingRelationshipId: ${existingId}.`));

    if (action !== 'delete') {
      if (!this.text(after.characterAName, '')) issues.push(this.issue('error', 'relationship', candidateId, action, 'Relationship candidate is missing characterAName.', `relationshipCandidates[${index}].characterAName`));
      if (!this.text(after.characterBName, '')) issues.push(this.issue('error', 'relationship', candidateId, action, 'Relationship candidate is missing characterBName.', `relationshipCandidates[${index}].characterBName`));
      if (!this.text(after.relationType, '')) issues.push(this.issue('error', 'relationship', candidateId, action, 'Relationship candidate is missing relationType.', `relationshipCandidates[${index}].relationType`));
      if (this.normalizeTextKey(this.text(after.characterAName, '')) && this.normalizeTextKey(this.text(after.characterAName, '')) === this.normalizeTextKey(this.text(after.characterBName, ''))) {
        issues.push(this.issue('error', 'relationship', candidateId, action, 'Relationship candidate references the same character on both sides.'));
      }
      if (writeKey && duplicateWriteKeys.has(writeKey)) issues.push(this.issue('error', 'relationship', candidateId, action, 'Duplicate or conflicting relationship write key in preview.'));
      const duplicateExisting = relationships.find((row) => row.id !== existingId && this.relationshipKeyFromExisting(row) === writeKey);
      if (duplicateExisting) issues.push(this.issue('error', 'relationship', candidateId, action, `Relationship write would duplicate existing same-project RelationshipEdge: ${duplicateExisting.id}.`));
    }

    this.validateCharacterRef(candidate.characterAId, candidate.characterAName, 'characterA', characters, issues, 'relationship', candidateId, action, `relationshipCandidates[${index}]`);
    this.validateCharacterRef(candidate.characterBId, candidate.characterBName, 'characterB', characters, issues, 'relationship', candidateId, action, `relationshipCandidates[${index}]`);
    return issues;
  }

  private validateTimelineCandidate(
    candidate: ContinuityTimelineCandidate,
    index: number,
    context: ToolContext,
    timelineById: Map<string, ExistingTimelineEvent>,
    timelineEvents: ExistingTimelineEvent[],
    characters: Map<string, CharacterRef>,
    chaptersById: Map<string, ChapterRef>,
    chaptersByNo: Map<number, ChapterRef>,
    duplicateCandidateIds: Set<string>,
    duplicateTargets: Set<string>,
    duplicateWriteKeys: Set<string>,
  ): ContinuityValidationIssue[] {
    const issues: ContinuityValidationIssue[] = [];
    const action = this.readAction(candidate.action);
    const candidateId = this.text(candidate.candidateId, `timeline_${index + 1}`);
    const existingId = this.text(candidate.existingTimelineEventId, '');
    const existing = timelineById.get(existingId) ?? null;
    const chapterRef = this.resolveChapterPreviewRef(candidate, chaptersById, chaptersByNo);
    const after = this.timelineAfter(candidate, existing, chapterRef);
    const writeKey = action === 'delete' ? '' : this.timelineKeyFromAfter(after);

    if (!candidate.candidateId) issues.push(this.issue('error', 'timeline', candidateId, action, 'Candidate is missing candidateId.', `timelineCandidates[${index}].candidateId`));
    if (duplicateCandidateIds.has(candidateId)) issues.push(this.issue('error', 'timeline', candidateId, action, `Duplicate timeline candidateId: ${candidateId}.`));
    if (!action) issues.push(this.issue('error', 'timeline', candidateId, candidate.action, `Invalid timeline action: ${this.text(candidate.action, '<missing>')}.`));
    if (!this.sourceTraceMatchesCurrentRun(candidate.sourceTrace, context, 'timeline')) issues.push(this.issue('error', 'timeline', candidateId, action, 'Timeline candidate sourceTrace is not from generate_continuity_preview in the current agent run.', `timelineCandidates[${index}].sourceTrace`));
    this.validateExplicitProjectId(candidate, context, issues, 'timeline', candidateId, action, `timelineCandidates[${index}]`);

    if (action === 'create' && existingId) issues.push(this.issue('error', 'timeline', candidateId, action, 'Create timeline candidate must not include existingTimelineEventId.', `timelineCandidates[${index}].existingTimelineEventId`));
    if ((action === 'update' || action === 'delete') && !existingId) issues.push(this.issue('error', 'timeline', candidateId, action, `${action} timeline candidate requires existingTimelineEventId.`, `timelineCandidates[${index}].existingTimelineEventId`));
    if (existingId && !this.looksLikeUuid(existingId)) issues.push(this.issue('error', 'timeline', candidateId, action, `existingTimelineEventId is not a UUID: ${existingId}.`, `timelineCandidates[${index}].existingTimelineEventId`));
    else if (existingId && !existing) issues.push(this.issue('error', 'timeline', candidateId, action, `existingTimelineEventId does not belong to current project: ${existingId}.`, `timelineCandidates[${index}].existingTimelineEventId`));
    if (existingId && duplicateTargets.has(existingId)) issues.push(this.issue('error', 'timeline', candidateId, action, `Multiple timeline candidates target the same existingTimelineEventId: ${existingId}.`));

    if (action !== 'delete') {
      if (!this.text(after.title, '')) issues.push(this.issue('error', 'timeline', candidateId, action, 'Timeline candidate is missing title.', `timelineCandidates[${index}].title`));
      if (writeKey && duplicateWriteKeys.has(writeKey)) issues.push(this.issue('error', 'timeline', candidateId, action, 'Duplicate or conflicting timeline write key in preview.'));
      const duplicateExisting = timelineEvents.find((row) => row.id !== existingId && this.timelineKeyFromExisting(row) === writeKey);
      if (duplicateExisting) issues.push(this.issue('error', 'timeline', candidateId, action, `Timeline write would duplicate existing same-project TimelineEvent: ${duplicateExisting.id}.`));
    }

    this.validateChapterRef(candidate, chaptersById, chaptersByNo, issues, candidateId, action, index);
    this.validateNameArray((candidate as unknown as Record<string, unknown>).participants, 'participants', issues, candidateId, action, index);
    this.validateNameArray((candidate as unknown as Record<string, unknown>).knownBy, 'knownBy', issues, candidateId, action, index);
    this.validateNameArray((candidate as unknown as Record<string, unknown>).unknownBy, 'unknownBy', issues, candidateId, action, index);
    this.validateTimelineCharacterIds(candidate.participantIds, candidate.participants, 'participantIds', 'participants', characters, issues, candidateId, action, index);
    this.validateTimelineCharacterIds(candidate.knownByIds, candidate.knownBy, 'knownByIds', 'knownBy', characters, issues, candidateId, action, index);
    this.validateTimelineCharacterIds(candidate.unknownByIds, candidate.unknownBy, 'unknownByIds', 'unknownBy', characters, issues, candidateId, action, index);
    return issues;
  }

  private validateExplicitProjectId(candidate: unknown, context: ToolContext, issues: ContinuityValidationIssue[], type: ContinuityCandidateType, candidateId: string, action: ContinuityAction | string, path: string) {
    const record = this.asRecord(candidate);
    if (record && Object.prototype.hasOwnProperty.call(record, 'projectId')) {
      issues.push(this.issue('error', type, candidateId, action, 'Candidate must not include projectId. Continuity writes always use context.projectId.', `${path}.projectId`));
    }
  }

  private validateCharacterRef(id: string | undefined, name: string | undefined, label: string, characters: Map<string, CharacterRef>, issues: ContinuityValidationIssue[], type: ContinuityCandidateType, candidateId: string, action: ContinuityAction | string, path: string) {
    if (!id) return;
    if (!this.looksLikeUuid(id)) {
      issues.push(this.issue('error', type, candidateId, action, `${label}Id is not a UUID: ${id}.`, `${path}.${label}Id`));
      return;
    }
    const character = characters.get(id);
    if (!character) {
      issues.push(this.issue('error', type, candidateId, action, `${label}Id does not belong to current project: ${id}.`, `${path}.${label}Id`));
      return;
    }
    if (!name?.trim()) {
      issues.push(this.issue('error', type, candidateId, action, `${label}Id requires matching ${label}Name.`, `${path}.${label}Name`));
    } else if (character.name.trim() !== name.trim()) {
      issues.push(this.issue('error', type, candidateId, action, `${label}Id/name mismatch: ${id} is ${character.name}, not ${name}.`, `${path}.${label}Name`));
    }
  }

  private validateChapterRef(candidate: ContinuityTimelineCandidate, chaptersById: Map<string, ChapterRef>, chaptersByNo: Map<number, ChapterRef>, issues: ContinuityValidationIssue[], candidateId: string, action: ContinuityAction | string, index: number) {
    const chapterId = this.optionalText(candidate.chapterId);
    const chapterNo = candidate.chapterNo;
    if (chapterId && !this.looksLikeUuid(chapterId)) {
      issues.push(this.issue('error', 'timeline', candidateId, action, `chapterId is not a UUID: ${chapterId}.`, `timelineCandidates[${index}].chapterId`));
      return;
    }
    if (chapterNo !== undefined && (!Number.isInteger(chapterNo) || chapterNo <= 0)) {
      issues.push(this.issue('error', 'timeline', candidateId, action, `chapterNo must be a positive integer: ${chapterNo}.`, `timelineCandidates[${index}].chapterNo`));
    }
    const byId = chapterId ? chaptersById.get(chapterId) : undefined;
    if (chapterId && !byId) issues.push(this.issue('error', 'timeline', candidateId, action, `chapterId does not belong to current project: ${chapterId}.`, `timelineCandidates[${index}].chapterId`));
    const byNo = Number.isInteger(chapterNo) ? chaptersByNo.get(chapterNo as number) : undefined;
    if (Number.isInteger(chapterNo) && !byNo) issues.push(this.issue('error', 'timeline', candidateId, action, `chapterNo does not belong to current project: ${chapterNo}.`, `timelineCandidates[${index}].chapterNo`));
    if (byId && Number.isInteger(chapterNo) && byId.chapterNo !== chapterNo) {
      issues.push(this.issue('error', 'timeline', candidateId, action, `chapterNo does not match chapterId: ${chapterNo} != ${byId.chapterNo}.`, `timelineCandidates[${index}].chapterNo`));
    }
  }

  private validateNameArray(value: unknown, field: 'participants' | 'knownBy' | 'unknownBy', issues: ContinuityValidationIssue[], candidateId: string, action: ContinuityAction | string, index: number) {
    if (value === undefined) return;
    if (!Array.isArray(value)) {
      issues.push(this.issue('error', 'timeline', candidateId, action, `${field} must be a name array.`, `timelineCandidates[${index}].${field}`));
      return;
    }
    value.forEach((item, itemIndex) => {
      if (typeof item !== 'string' || !item.trim()) {
        issues.push(this.issue('error', 'timeline', candidateId, action, `${field} must contain non-empty character names only.`, `timelineCandidates[${index}].${field}[${itemIndex}]`));
      } else if (this.looksLikeUuid(item.trim())) {
        issues.push(this.issue('error', 'timeline', candidateId, action, `${field} must contain names, not IDs: ${item}.`, `timelineCandidates[${index}].${field}[${itemIndex}]`));
      }
    });
  }

  private validateTimelineCharacterIds(ids: string[] | undefined, names: string[], field: 'participantIds' | 'knownByIds' | 'unknownByIds', nameField: 'participants' | 'knownBy' | 'unknownBy', characters: Map<string, CharacterRef>, issues: ContinuityValidationIssue[], candidateId: string, action: ContinuityAction | string, index: number) {
    if (ids === undefined) return;
    if (ids.length !== names.length) {
      issues.push(this.issue('error', 'timeline', candidateId, action, `${field} must align one-to-one with ${nameField}.`, `timelineCandidates[${index}].${field}`));
    }
    ids.forEach((id, idIndex) => {
      if (!this.looksLikeUuid(id)) {
        issues.push(this.issue('error', 'timeline', candidateId, action, `${field} contains a non-UUID value: ${id}. Natural-language names must stay in participants/knownBy/unknownBy.`, `timelineCandidates[${index}].${field}[${idIndex}]`));
        return;
      }
      const character = characters.get(id);
      if (!character) {
        issues.push(this.issue('error', 'timeline', candidateId, action, `${field} references a Character outside the current project: ${id}.`, `timelineCandidates[${index}].${field}[${idIndex}]`));
        return;
      }
      const name = names[idIndex];
      if (!name || character.name.trim() !== name.trim()) {
        issues.push(this.issue('error', 'timeline', candidateId, action, `${field}/${nameField} mismatch at index ${idIndex}: ${id} is ${character.name}, not ${name ?? '<missing>'}.`, `timelineCandidates[${index}].${nameField}[${idIndex}]`));
      }
    });
  }

  private relationshipWriteKey(candidate: ContinuityRelationshipCandidate, existing?: ExistingRelationshipEdge): string {
    if (candidate.action === 'delete') return '';
    const after = this.relationshipAfter(candidate, existing);
    return this.text(after.characterAName, '') && this.text(after.characterBName, '') && this.text(after.relationType, '') ? this.relationshipKeyFromAfter(after) : '';
  }

  private timelineWriteKey(candidate: ContinuityTimelineCandidate, existing: ExistingTimelineEvent | undefined, chaptersById: Map<string, ChapterRef>, chaptersByNo: Map<number, ChapterRef>): string {
    if (candidate.action === 'delete') return '';
    const after = this.timelineAfter(candidate, existing, this.resolveChapterPreviewRef(candidate, chaptersById, chaptersByNo));
    return this.text(after.title, '') ? this.timelineKeyFromAfter(after) : '';
  }

  private resolveChapterPreviewRef(candidate: ContinuityTimelineCandidate, chaptersById: Map<string, ChapterRef>, chaptersByNo: Map<number, ChapterRef>): { chapterId: string | null; chapterNo: number | null } | undefined {
    if (candidate.chapterId) {
      const chapter = chaptersById.get(candidate.chapterId);
      return chapter ? { chapterId: chapter.id, chapterNo: chapter.chapterNo } : undefined;
    }
    if (Number.isInteger(candidate.chapterNo)) {
      const chapter = chaptersByNo.get(candidate.chapterNo as number);
      return chapter ? { chapterId: chapter.id, chapterNo: chapter.chapterNo } : undefined;
    }
    return undefined;
  }

  private buildWriteEntry(candidateId: string, action: ContinuityAction, existingId: string | null, label: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, sourceTrace: ContinuitySourceTrace | undefined, errors: string[]): ContinuityWritePreviewEntry {
    return {
      candidateId,
      action: errors.length ? 'reject' : action,
      existingId,
      label,
      ...(errors.length ? { reason: errors.join('; ') } : {}),
      before,
      after,
      fieldDiff: this.fieldDiff(before, after),
      sourceTrace,
    };
  }

  private issue(severity: ContinuityIssueSeverity, candidateType: ContinuityCandidateType, candidateId: string, action: ContinuityAction | string, message: string, path?: string, suggestion?: string): ContinuityValidationIssue {
    return { severity, candidateType, candidateId, action, message, ...(path ? { path } : {}), ...(suggestion ? { suggestion } : {}) };
  }

  private collectCharacterIds(relationships: ContinuityRelationshipCandidate[], timelines: ContinuityTimelineCandidate[]): string[] {
    return [
      ...relationships.flatMap((candidate) => [candidate.characterAId, candidate.characterBId]),
      ...timelines.flatMap((candidate) => [...(candidate.participantIds ?? []), ...(candidate.knownByIds ?? []), ...(candidate.unknownByIds ?? [])]),
    ].filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && this.looksLikeUuid(id));
  }

  private async loadRelationships(projectId: string): Promise<ExistingRelationshipEdge[]> {
    return this.prisma.relationshipEdge.findMany({
      where: { projectId },
      select: { id: true, characterAId: true, characterBId: true, characterAName: true, characterBName: true, relationType: true, publicState: true, hiddenState: true, conflictPoint: true, emotionalArc: true, turnChapterNos: true, finalState: true, status: true, sourceType: true, metadata: true, updatedAt: true },
    });
  }

  private async loadTimelineEvents(projectId: string): Promise<ExistingTimelineEvent[]> {
    return this.prisma.timelineEvent.findMany({
      where: { projectId },
      select: { id: true, chapterId: true, chapterNo: true, title: true, eventTime: true, locationName: true, participants: true, cause: true, result: true, impactScope: true, isPublic: true, knownBy: true, unknownBy: true, eventStatus: true, sourceType: true, metadata: true, updatedAt: true },
    });
  }

  private async loadCharacters(projectId: string, ids: string[]): Promise<Map<string, CharacterRef>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Map();
    const rows = await this.prisma.character.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadChaptersById(projectId: string, ids: string[]): Promise<Map<string, ChapterRef>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Map();
    const rows = await this.prisma.chapter.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true, chapterNo: true } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadChaptersByNo(projectId: string, chapterNos: number[]): Promise<Map<number, ChapterRef>> {
    const validNos = [...new Set(chapterNos.filter((chapterNo) => Number.isInteger(chapterNo) && chapterNo > 0))];
    if (!validNos.length) return new Map();
    const rows = await this.prisma.chapter.findMany({ where: { projectId, chapterNo: { in: validNos } }, select: { id: true, chapterNo: true } });
    return new Map(rows.map((row) => [row.chapterNo, row]));
  }

  private getRelationshipCandidates(preview?: ContinuityPreviewOutput): ContinuityRelationshipCandidate[] {
    return this.recordArray(this.asRecord(preview)?.relationshipCandidates) as unknown as ContinuityRelationshipCandidate[];
  }

  private getTimelineCandidates(preview?: ContinuityPreviewOutput): ContinuityTimelineCandidate[] {
    return this.recordArray(this.asRecord(preview)?.timelineCandidates) as unknown as ContinuityTimelineCandidate[];
  }

  private buildOutput(
    issues: ContinuityValidationIssue[],
    relationshipAccepted: ContinuityAcceptedCandidate[],
    relationshipRejected: ContinuityRejectedCandidate[],
    timelineAccepted: ContinuityAcceptedCandidate[],
    timelineRejected: ContinuityRejectedCandidate[],
    relationshipEntries: ContinuityWritePreviewEntry[] = [],
    timelineEntries: ContinuityWritePreviewEntry[] = [],
  ): ValidateContinuityChangesOutput {
    return {
      valid: !issues.some((issue) => issue.severity === 'error') && (relationshipAccepted.length + timelineAccepted.length > 0),
      issueCount: issues.length,
      issues,
      accepted: { relationshipCandidates: relationshipAccepted, timelineCandidates: timelineAccepted },
      rejected: { relationshipCandidates: relationshipRejected, timelineCandidates: timelineRejected },
      writePreview: {
        projectScope: 'context.projectId',
        sourceKind: this.sourceKind,
        relationshipCandidates: { target: 'RelationshipEdge', summary: this.summaryForEntries(relationshipEntries), entries: relationshipEntries },
        timelineCandidates: { target: 'TimelineEvent', summary: this.summaryForEntries(timelineEntries), entries: timelineEntries },
        approvalMessage: 'Persist requires explicit approval in act mode. Only validation.accepted candidates with matching writePreview entries are eligible, and persist_continuity_changes revalidates against context.projectId before writing.',
      },
    };
  }

  private summaryForEntries(entries: ContinuityWritePreviewEntry[]) {
    return {
      createCount: entries.filter((entry) => entry.action === 'create').length,
      updateCount: entries.filter((entry) => entry.action === 'update').length,
      deleteCount: entries.filter((entry) => entry.action === 'delete').length,
      rejectCount: entries.filter((entry) => entry.action === 'reject').length,
    };
  }
}

@Injectable()
export class PersistContinuityChangesTool extends ContinuityToolSupport implements BaseTool<PersistContinuityChangesInput, PersistContinuityChangesOutput> {
  name = 'persist_continuity_changes';
  description = 'Persist approved relationship and timeline continuity candidates for the current project.';
  inputSchema = {
    type: 'object' as const,
    required: ['preview', 'validation'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      validation: { type: 'object' as const },
      selectedCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      selectedRelationshipCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      selectedTimelineCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      dryRun: { type: 'boolean' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['dryRun', 'relationshipResults', 'timelineResults', 'skippedUnselectedCandidates', 'writePreview', 'approval', 'persistedAt', 'approvalMessage'],
    properties: {
      dryRun: { type: 'boolean' as const },
      relationshipResults: { type: 'object' as const },
      timelineResults: { type: 'object' as const },
      skippedUnselectedCandidates: { type: 'object' as const },
      writePreview: { type: 'object' as const },
      approval: { type: 'object' as const },
      persistedAt: { type: ['string', 'null'] as const },
      approvalMessage: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = [
    'create_relationship_edges',
    'update_relationship_edges',
    'delete_relationship_edges',
    'create_timeline_events',
    'update_timeline_events',
    'delete_timeline_events',
    'fact_layer_continuity_write',
  ];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Persist Continuity Changes',
    description: 'After approval, writes only selected validation.accepted relationship/timeline candidates under context.projectId. Supports dryRun without writes.',
    whenToUse: [
      'validate_continuity_changes has produced accepted candidates and the user approved writing them.',
      'The selected relationshipCandidates or timelineCandidates should be created, updated, or deleted.',
      'A dry-run diff is needed for the approved persist step without mutating business tables.',
    ],
    whenNotToUse: [
      'The run is in plan mode or lacks explicit approval.',
      'There is no generate_continuity_preview and validate_continuity_changes output.',
      'Selected candidates are not present in validation.accepted and writePreview.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_continuity_preview.' },
      validation: { source: 'previous_step', description: 'Output from validate_continuity_changes.' },
      selectedCandidateIds: { source: 'previous_step', description: 'Optional combined candidate IDs copied from validation.accepted/writePreview.' },
      selectedRelationshipCandidateIds: { source: 'previous_step', description: 'Optional RelationshipEdge candidate IDs copied from validation.accepted.relationshipCandidates.' },
      selectedTimelineCandidateIds: { source: 'previous_step', description: 'Optional TimelineEvent candidate IDs copied from validation.accepted.timelineCandidates.' },
      dryRun: { source: 'literal', description: 'When true, revalidates and returns the selected diff without writing.' },
    },
    preconditions: [
      'context.mode must be act',
      'context.approved must be true',
      'preview.writePlan.requiresApprovalBeforePersist must be true',
      'preview and validation must be whole-object references to previous generate_continuity_preview and validate_continuity_changes outputs',
      'selected candidates must come from validation.accepted and writePreview',
      'candidate sourceTrace.agentRunId must equal context.agentRunId',
    ],
    postconditions: [
      'Writes only rows under context.projectId',
      'Invalidates NovelCacheService.deleteProjectRecallResults(projectId) after actual writes',
      'dryRun=true performs no business-table writes and no cache invalidation',
    ],
    failureHints: [
      { code: 'APPROVAL_REQUIRED', meaning: 'persist_continuity_changes is a write tool and must run after approval in act mode.', suggestedRepair: 'Ask for user approval and rerun in act mode.' },
      { code: 'UNKNOWN_SELECTION', meaning: 'A selected candidate is not in preview, validation.accepted, or writePreview.', suggestedRepair: 'Use candidate IDs copied from validate_continuity_changes output.' },
      { code: 'VALIDATION_FAILED', meaning: 'Write-time validation found changed, invalid, or cross-project references.', suggestedRepair: 'Run validate_continuity_changes again and resolve rejected candidates.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'characterId', 'chapterId', 'relationshipId', 'timelineEventId'],
      allowedSources: ['projectId from ToolContext only', 'candidate IDs from validate_continuity_changes', 'existing IDs from generate_continuity_preview/validate_continuity_changes output'],
    },
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {
    super();
  }

  async run(args: PersistContinuityChangesInput, context: ToolContext): Promise<PersistContinuityChangesOutput> {
    this.assertExecutableInput(args, context);
    const relationshipCandidates = this.getRelationshipCandidates(args.preview);
    const timelineCandidates = this.getTimelineCandidates(args.preview);
    this.assertExplicitSelectionsKnown(args, relationshipCandidates, timelineCandidates);
    const selectedRelationships = this.selectRelationshipCandidates(args, relationshipCandidates);
    const selectedTimeline = this.selectTimelineCandidates(args, timelineCandidates);
    this.assertSelectedAllowed(args.validation as ValidateContinuityChangesOutput, selectedRelationships, selectedTimeline, context);
    const skippedUnselectedCandidates = this.buildSkippedUnselected(relationshipCandidates, timelineCandidates, selectedRelationships, selectedTimeline);
    const writePreview = this.selectedWritePreview(args.validation as ValidateContinuityChangesOutput, selectedRelationships, selectedTimeline);

    const persistedAt = new Date().toISOString();
    const result = await this.prisma.$transaction(async (tx) => {
      const relationshipDecisions = await this.buildRelationshipDecisions(tx, selectedRelationships, context.projectId);
      const timelineDecisions = await this.buildTimelineDecisions(tx, selectedTimeline, context.projectId);
      if (args.dryRun === true) {
        return {
          relationshipResults: this.emptyPersistSection(),
          timelineResults: this.emptyPersistSection(),
          wrote: false,
        };
      }

      const relationshipResults = await this.persistRelationships(tx, relationshipDecisions, context, persistedAt);
      const timelineResults = await this.persistTimelineEvents(tx, timelineDecisions, context, persistedAt);
      return {
        relationshipResults,
        timelineResults,
        wrote: relationshipResults.createdCount + relationshipResults.updatedCount + relationshipResults.deletedCount + timelineResults.createdCount + timelineResults.updatedCount + timelineResults.deletedCount > 0,
      };
    });

    if (result.wrote && args.dryRun !== true) {
      await this.cacheService.deleteProjectRecallResults(context.projectId);
    }

    return {
      dryRun: args.dryRun === true,
      relationshipResults: result.relationshipResults,
      timelineResults: result.timelineResults,
      skippedUnselectedCandidates,
      writePreview,
      approval: { required: true, approved: context.approved, mode: context.mode },
      persistedAt: args.dryRun === true ? null : persistedAt,
      approvalMessage: args.dryRun === true
        ? 'Dry run completed: selected continuity changes were revalidated and no business tables were written.'
        : 'Selected continuity changes were persisted only after approval, under context.projectId, with cache invalidation after actual writes.',
    };
  }

  private assertExecutableInput(args: PersistContinuityChangesInput, context: ToolContext) {
    if (context.mode !== 'act') throw new BadRequestException('persist_continuity_changes can only run in Agent act mode.');
    if (!context.approved) throw new BadRequestException('persist_continuity_changes requires explicit user approval.');
    if (!args.preview) throw new BadRequestException('persist_continuity_changes requires generate_continuity_preview output.');
    if (!args.validation) throw new BadRequestException('persist_continuity_changes requires validate_continuity_changes output.');
    if (args.validation.valid !== true) throw new BadRequestException('validate_continuity_changes did not pass; persist_continuity_changes will not write.');
    this.assertPreviousToolOutput(args.preview, context, 'generate_continuity_preview', 'preview');
    this.assertPreviousToolOutput(args.validation, context, 'validate_continuity_changes', 'validation');
    if (args.preview.writePlan?.requiresApprovalBeforePersist !== true) throw new BadRequestException('Continuity preview did not declare approval-before-persist.');
    if (args.preview.writePlan?.sourceKind !== this.sourceKind) throw new BadRequestException('Continuity preview sourceKind must be planned_continuity_change.');
    if ((this.getRelationshipCandidates(args.preview).length + this.getTimelineCandidates(args.preview).length) === 0) throw new BadRequestException('persist_continuity_changes requires at least one preview candidate.');
  }

  private assertPreviousToolOutput(value: unknown, context: ToolContext, expectedTool: string, field: 'preview' | 'validation') {
    const match = Object.entries(context.outputs ?? {}).find(([stepNo, output]) => output === value && context.stepTools?.[Number(stepNo)] === expectedTool);
    if (!match) {
      throw new BadRequestException(`persist_continuity_changes ${field} must reference previous ${expectedTool} output via {{steps.N.output}}.`);
    }
  }

  private assertExplicitSelectionsKnown(args: PersistContinuityChangesInput, relationships: ContinuityRelationshipCandidate[], timeline: ContinuityTimelineCandidate[]) {
    const allCandidateIds = new Set([...relationships.map((candidate) => candidate.candidateId), ...timeline.map((candidate) => candidate.candidateId)]);
    const explicitIds = [
      ...this.stringArray(args.selectedCandidateIds),
      ...this.stringArray(args.selectedRelationshipCandidateIds),
      ...this.stringArray(args.selectedTimelineCandidateIds),
    ];
    const unknown = explicitIds.filter((candidateId) => !allCandidateIds.has(candidateId));
    if (unknown.length) throw new BadRequestException(`Unknown continuity candidate selection: ${[...new Set(unknown)].join(', ')}`);
  }

  private selectRelationshipCandidates(args: PersistContinuityChangesInput, candidates: ContinuityRelationshipCandidate[]): ContinuityRelationshipCandidate[] {
    const explicit = new Set([...this.stringArray(args.selectedCandidateIds), ...this.stringArray(args.selectedRelationshipCandidateIds)]);
    return this.selectCandidates(candidates, explicit, new Set(this.stringArray(args.validation?.accepted?.relationshipCandidates?.map((candidate) => candidate.candidateId))), this.hasExplicitSelection(args), 'relationship');
  }

  private selectTimelineCandidates(args: PersistContinuityChangesInput, candidates: ContinuityTimelineCandidate[]): ContinuityTimelineCandidate[] {
    const explicit = new Set([...this.stringArray(args.selectedCandidateIds), ...this.stringArray(args.selectedTimelineCandidateIds)]);
    return this.selectCandidates(candidates, explicit, new Set(this.stringArray(args.validation?.accepted?.timelineCandidates?.map((candidate) => candidate.candidateId))), this.hasExplicitSelection(args), 'timeline');
  }

  private hasExplicitSelection(args: PersistContinuityChangesInput): boolean {
    return this.stringArray(args.selectedCandidateIds).length > 0
      || this.stringArray(args.selectedRelationshipCandidateIds).length > 0
      || this.stringArray(args.selectedTimelineCandidateIds).length > 0;
  }

  private selectCandidates<T extends { candidateId: string }>(candidates: T[], explicitIds: Set<string>, defaultAcceptedIds: Set<string>, hasExplicitSelection: boolean, type: ContinuityCandidateType): T[] {
    const candidateIds = new Set(candidates.map((candidate) => candidate.candidateId));
    const explicitForType = [...explicitIds].filter((candidateId) => candidateIds.has(candidateId));
    const unknownForType = [...explicitIds].filter((candidateId) => !candidateIds.has(candidateId) && candidateId.startsWith(type === 'relationship' ? 'relc_' : 'tlc_'));
    if (unknownForType.length) throw new BadRequestException(`Unknown ${type} candidate selection: ${unknownForType.join(', ')}`);
    const selectedIds = explicitForType.length ? new Set(explicitForType) : hasExplicitSelection ? new Set<string>() : defaultAcceptedIds;
    const missingAccepted = [...selectedIds].filter((candidateId) => !candidateIds.has(candidateId));
    if (missingAccepted.length) throw new BadRequestException(`validate_continuity_changes output does not match ${type} preview candidates: ${missingAccepted.join(', ')}`);
    return candidates.filter((candidate) => selectedIds.has(candidate.candidateId));
  }

  private assertSelectedAllowed(validation: ValidateContinuityChangesOutput, relationships: ContinuityRelationshipCandidate[], timeline: ContinuityTimelineCandidate[], context: ToolContext) {
    const errors: string[] = [];
    this.assertSectionSelectedAllowed('relationship', relationships, validation.accepted.relationshipCandidates, validation.rejected.relationshipCandidates, validation.writePreview.relationshipCandidates.entries, context, errors);
    this.assertSectionSelectedAllowed('timeline', timeline, validation.accepted.timelineCandidates, validation.rejected.timelineCandidates, validation.writePreview.timelineCandidates.entries, context, errors);
    if (!relationships.length && !timeline.length) errors.push('No accepted continuity candidates selected for persist.');
    if (errors.length) throw new BadRequestException(`validate_continuity_changes output does not approve selected candidates: ${[...new Set(errors)].join('; ')}`);
  }

  private assertSectionSelectedAllowed(
    type: ContinuityCandidateType,
    selected: Array<ContinuityRelationshipCandidate | ContinuityTimelineCandidate>,
    accepted: ContinuityAcceptedCandidate[],
    rejected: ContinuityRejectedCandidate[],
    writeEntries: ContinuityWritePreviewEntry[],
    context: ToolContext,
    errors: string[],
  ) {
    const acceptedById = new Map(accepted.map((item) => [item.candidateId, item]));
    const rejectedById = new Set(rejected.map((item) => item.candidateId));
    const writeById = new Map(writeEntries.filter((entry) => entry.action !== 'reject').map((entry) => [entry.candidateId, entry]));
    selected.forEach((candidate) => {
      const acceptedCandidate = acceptedById.get(candidate.candidateId);
      const writeEntry = writeById.get(candidate.candidateId);
      if (rejectedById.has(candidate.candidateId)) errors.push(`${candidate.candidateId} was rejected by validate_continuity_changes`);
      if (!acceptedCandidate) errors.push(`${candidate.candidateId} was not accepted by validate_continuity_changes`);
      if (!writeEntry) errors.push(`${candidate.candidateId} is missing an accepted writePreview entry`);
      if (!this.sourceTraceMatchesCurrentRun(candidate.sourceTrace, context, type)) errors.push(`${candidate.candidateId} sourceTrace.agentRunId does not match current agent run`);
      if (acceptedCandidate && !this.sameSourceTrace(candidate.sourceTrace, acceptedCandidate.sourceTrace)) errors.push(`${candidate.candidateId} sourceTrace does not match validation.accepted`);
      if (writeEntry && !this.sameSourceTrace(candidate.sourceTrace, writeEntry.sourceTrace)) errors.push(`${candidate.candidateId} sourceTrace does not match validation.writePreview`);
      if (acceptedCandidate && acceptedCandidate.action !== candidate.action) errors.push(`${candidate.candidateId} action does not match validation.accepted`);
      if (writeEntry && writeEntry.action !== candidate.action) errors.push(`${candidate.candidateId} action does not match validation.writePreview`);
    });
  }

  private async buildRelationshipDecisions(tx: Prisma.TransactionClient, candidates: ContinuityRelationshipCandidate[], projectId: string): Promise<RelationshipPersistDecision[]> {
    const errors: string[] = [];
    const relationships = await tx.relationshipEdge.findMany({
      where: { projectId },
      select: { id: true, characterAId: true, characterBId: true, characterAName: true, characterBName: true, relationType: true, publicState: true, hiddenState: true, conflictPoint: true, emotionalArc: true, turnChapterNos: true, finalState: true, status: true, sourceType: true, metadata: true },
    });
    const relationshipById = new Map(relationships.map((item) => [item.id, item]));
    const characters = await this.loadCharactersForTx(tx, projectId, candidates.flatMap((candidate) => [candidate.characterAId, candidate.characterBId]).filter((id): id is string => Boolean(id && this.looksLikeUuid(id))));
    const duplicateCandidateIds = new Set(this.findDuplicateStrings(candidates.map((candidate) => candidate.candidateId)));
    const duplicateTargets = new Set(this.findDuplicateStrings(candidates.map((candidate) => candidate.action !== 'create' ? this.text(candidate.existingRelationshipId, '') : '').filter(Boolean)));
    const duplicateWriteKeys = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.relationshipKeyForPersist(candidate, relationshipById.get(this.text(candidate.existingRelationshipId, '')))).filter(Boolean)));

    const decisions: RelationshipPersistDecision[] = [];
    candidates.forEach((candidate) => {
      const existingId = this.text(candidate.existingRelationshipId, '');
      const existing = relationshipById.get(existingId) ?? null;
      const after = this.relationshipAfter(candidate, existing);
      const writeKey = candidate.action === 'delete' ? '' : this.relationshipKeyFromAfter(after);
      this.appendExplicitProjectIdError(candidate, errors, candidate.candidateId);
      if (!candidate.candidateId) errors.push('Relationship candidate missing candidateId.');
      if (duplicateCandidateIds.has(candidate.candidateId)) errors.push(`Duplicate relationship candidateId selected: ${candidate.candidateId}`);
      if (candidate.action !== 'create' && (!existingId || !this.looksLikeUuid(existingId) || !existing)) errors.push(`Relationship ${candidate.candidateId} targets a missing or cross-project existingRelationshipId.`);
      if (existingId && duplicateTargets.has(existingId)) errors.push(`Duplicate relationship existingRelationshipId selected: ${existingId}`);
      this.appendCharacterRefErrors(candidate.characterAId, candidate.characterAName, 'characterA', characters, errors, candidate.candidateId);
      this.appendCharacterRefErrors(candidate.characterBId, candidate.characterBName, 'characterB', characters, errors, candidate.candidateId);
      if (candidate.action !== 'delete') {
        if (!this.text(after.characterAName, '') || !this.text(after.characterBName, '') || !this.text(after.relationType, '')) errors.push(`Relationship ${candidate.candidateId} is missing required write fields.`);
        if (writeKey && duplicateWriteKeys.has(writeKey)) errors.push(`Duplicate relationship write selected: ${candidate.candidateId}`);
        const duplicateExisting = relationships.find((row) => row.id !== existingId && this.relationshipKeyFromExisting(row) === writeKey);
        if (duplicateExisting) errors.push(`Relationship ${candidate.candidateId} would duplicate existing RelationshipEdge ${duplicateExisting.id}.`);
      }
      decisions.push({ candidate, action: candidate.action, existing });
    });
    if (errors.length) throw new BadRequestException(`Continuity relationship write-time validation failed: ${[...new Set(errors)].join('; ')}`);
    return decisions;
  }

  private async buildTimelineDecisions(tx: Prisma.TransactionClient, candidates: ContinuityTimelineCandidate[], projectId: string): Promise<TimelinePersistDecision[]> {
    const errors: string[] = [];
    const timelineEvents = await tx.timelineEvent.findMany({
      where: { projectId },
      select: { id: true, chapterId: true, chapterNo: true, title: true, eventTime: true, locationName: true, participants: true, cause: true, result: true, impactScope: true, isPublic: true, knownBy: true, unknownBy: true, eventStatus: true, sourceType: true, metadata: true },
    });
    const timelineById = new Map(timelineEvents.map((item) => [item.id, item]));
    const characters = await this.loadCharactersForTx(tx, projectId, candidates.flatMap((candidate) => [...(candidate.participantIds ?? []), ...(candidate.knownByIds ?? []), ...(candidate.unknownByIds ?? [])]).filter((id) => this.looksLikeUuid(id)));
    const chaptersById = await this.loadChaptersByIdForTx(tx, projectId, candidates.map((candidate) => this.optionalText(candidate.chapterId)).filter((id): id is string => Boolean(id)));
    const chaptersByNo = await this.loadChaptersByNoForTx(tx, projectId, candidates.map((candidate) => candidate.chapterNo).filter((value): value is number => Number.isInteger(value)));
    const duplicateCandidateIds = new Set(this.findDuplicateStrings(candidates.map((candidate) => candidate.candidateId)));
    const duplicateTargets = new Set(this.findDuplicateStrings(candidates.map((candidate) => candidate.action !== 'create' ? this.text(candidate.existingTimelineEventId, '') : '').filter(Boolean)));
    const duplicateWriteKeys = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.timelineKeyForPersist(candidate, timelineById.get(this.text(candidate.existingTimelineEventId, '')), chaptersById, chaptersByNo)).filter(Boolean)));

    const decisions: TimelinePersistDecision[] = [];
    candidates.forEach((candidate) => {
      const existingId = this.text(candidate.existingTimelineEventId, '');
      const existing = timelineById.get(existingId) ?? null;
      const chapterRef = this.resolveChapterRefForPersist(candidate, chaptersById, chaptersByNo, errors);
      const after = this.timelineAfter(candidate, existing, chapterRef);
      const writeKey = candidate.action === 'delete' ? '' : this.timelineKeyFromAfter(after);
      this.appendExplicitProjectIdError(candidate, errors, candidate.candidateId);
      if (!candidate.candidateId) errors.push('Timeline candidate missing candidateId.');
      if (duplicateCandidateIds.has(candidate.candidateId)) errors.push(`Duplicate timeline candidateId selected: ${candidate.candidateId}`);
      if (candidate.action !== 'create' && (!existingId || !this.looksLikeUuid(existingId) || !existing)) errors.push(`Timeline ${candidate.candidateId} targets a missing or cross-project existingTimelineEventId.`);
      if (existingId && duplicateTargets.has(existingId)) errors.push(`Duplicate timeline existingTimelineEventId selected: ${existingId}`);
      this.appendTimelineCharacterIdErrors(candidate.participantIds, candidate.participants, 'participantIds', 'participants', characters, errors, candidate.candidateId);
      this.appendTimelineCharacterIdErrors(candidate.knownByIds, candidate.knownBy, 'knownByIds', 'knownBy', characters, errors, candidate.candidateId);
      this.appendTimelineCharacterIdErrors(candidate.unknownByIds, candidate.unknownBy, 'unknownByIds', 'unknownBy', characters, errors, candidate.candidateId);
      if (candidate.action !== 'delete') {
        if (!this.text(after.title, '')) errors.push(`Timeline ${candidate.candidateId} is missing title.`);
        if (writeKey && duplicateWriteKeys.has(writeKey)) errors.push(`Duplicate timeline write selected: ${candidate.candidateId}`);
        const duplicateExisting = timelineEvents.find((row) => row.id !== existingId && this.timelineKeyFromExisting(row) === writeKey);
        if (duplicateExisting) errors.push(`Timeline ${candidate.candidateId} would duplicate existing TimelineEvent ${duplicateExisting.id}.`);
      }
      decisions.push({ candidate, action: candidate.action, existing, chapterRef });
    });
    if (errors.length) throw new BadRequestException(`Continuity timeline write-time validation failed: ${[...new Set(errors)].join('; ')}`);
    return decisions;
  }

  private async persistRelationships(tx: Prisma.TransactionClient, decisions: RelationshipPersistDecision[], context: ToolContext, persistedAt: string): Promise<ContinuityPersistSectionResult> {
    const result = this.emptyPersistSection();
    for (const decision of decisions) {
      const label = this.relationshipLabel(decision.candidate, decision.existing);
      if (decision.action === 'create') {
        const after = this.relationshipAfter(decision.candidate);
        const created = await tx.relationshipEdge.create({
          data: {
            projectId: context.projectId,
            characterAId: this.text(after.characterAId, '') || null,
            characterBId: this.text(after.characterBId, '') || null,
            characterAName: this.text(after.characterAName, ''),
            characterBName: this.text(after.characterBName, ''),
            relationType: this.text(after.relationType, ''),
            publicState: this.text(after.publicState, '') || null,
            hiddenState: this.text(after.hiddenState, '') || null,
            conflictPoint: this.text(after.conflictPoint, '') || null,
            emotionalArc: this.text(after.emotionalArc, '') || null,
            turnChapterNos: this.toJsonValue(after.turnChapterNos),
            finalState: this.text(after.finalState, '') || null,
            status: this.text(after.status, 'active'),
            sourceType: 'agent_continuity',
            metadata: this.buildMetadata(decision.candidate, context, persistedAt),
          },
          select: { id: true },
        });
        result.created.push({ id: created.id, label });
      } else if (decision.action === 'update' && decision.existing) {
        const after = this.relationshipAfter(decision.candidate, decision.existing);
        const updated = await tx.relationshipEdge.updateMany({
          where: { id: decision.existing.id, projectId: context.projectId },
          data: {
            characterAId: this.text(after.characterAId, '') || null,
            characterBId: this.text(after.characterBId, '') || null,
            characterAName: this.text(after.characterAName, ''),
            characterBName: this.text(after.characterBName, ''),
            relationType: this.text(after.relationType, ''),
            publicState: this.text(after.publicState, '') || null,
            hiddenState: this.text(after.hiddenState, '') || null,
            conflictPoint: this.text(after.conflictPoint, '') || null,
            emotionalArc: this.text(after.emotionalArc, '') || null,
            turnChapterNos: this.toJsonValue(after.turnChapterNos),
            finalState: this.text(after.finalState, '') || null,
            status: this.text(after.status, decision.existing.status),
            sourceType: 'agent_continuity',
            metadata: this.buildMetadata(decision.candidate, context, persistedAt, decision.existing.metadata),
          },
        });
        this.assertSingleProjectMutation(updated.count, 'RelationshipEdge update', decision.existing.id);
        result.updated.push({ id: decision.existing.id, label });
      } else if (decision.action === 'delete' && decision.existing) {
        const deleted = await tx.relationshipEdge.deleteMany({ where: { id: decision.existing.id, projectId: context.projectId } });
        this.assertSingleProjectMutation(deleted.count, 'RelationshipEdge delete', decision.existing.id);
        result.deleted.push({ id: decision.existing.id, label });
      }
    }
    return this.countPersistSection(result);
  }

  private async persistTimelineEvents(tx: Prisma.TransactionClient, decisions: TimelinePersistDecision[], context: ToolContext, persistedAt: string): Promise<ContinuityPersistSectionResult> {
    const result = this.emptyPersistSection();
    for (const decision of decisions) {
      const label = this.timelineLabel(decision.candidate, decision.existing);
      if (decision.action === 'create') {
        const after = this.timelineAfter(decision.candidate, null, decision.chapterRef);
        const created = await tx.timelineEvent.create({
          data: {
            projectId: context.projectId,
            chapterId: this.text(after.chapterId, '') || null,
            chapterNo: typeof after.chapterNo === 'number' ? after.chapterNo : null,
            title: this.text(after.title, ''),
            eventTime: this.text(after.eventTime, '') || null,
            locationName: this.text(after.locationName, '') || null,
            participants: this.toJsonValue(after.participants),
            cause: this.text(after.cause, '') || null,
            result: this.text(after.result, '') || null,
            impactScope: this.text(after.impactScope, '') || null,
            isPublic: Boolean(after.isPublic),
            knownBy: this.toJsonValue(after.knownBy),
            unknownBy: this.toJsonValue(after.unknownBy),
            eventStatus: this.text(after.eventStatus, 'active'),
            sourceType: 'agent_continuity',
            metadata: this.buildMetadata(decision.candidate, context, persistedAt),
          },
          select: { id: true },
        });
        result.created.push({ id: created.id, label });
      } else if (decision.action === 'update' && decision.existing) {
        const after = this.timelineAfter(decision.candidate, decision.existing, decision.chapterRef);
        const updated = await tx.timelineEvent.updateMany({
          where: { id: decision.existing.id, projectId: context.projectId },
          data: {
            chapterId: this.text(after.chapterId, '') || null,
            chapterNo: typeof after.chapterNo === 'number' ? after.chapterNo : null,
            title: this.text(after.title, ''),
            eventTime: this.text(after.eventTime, '') || null,
            locationName: this.text(after.locationName, '') || null,
            participants: this.toJsonValue(after.participants),
            cause: this.text(after.cause, '') || null,
            result: this.text(after.result, '') || null,
            impactScope: this.text(after.impactScope, '') || null,
            isPublic: Boolean(after.isPublic),
            knownBy: this.toJsonValue(after.knownBy),
            unknownBy: this.toJsonValue(after.unknownBy),
            eventStatus: this.text(after.eventStatus, decision.existing.eventStatus),
            sourceType: 'agent_continuity',
            metadata: this.buildMetadata(decision.candidate, context, persistedAt, decision.existing.metadata),
          },
        });
        this.assertSingleProjectMutation(updated.count, 'TimelineEvent update', decision.existing.id);
        result.updated.push({ id: decision.existing.id, label });
      } else if (decision.action === 'delete' && decision.existing) {
        const deleted = await tx.timelineEvent.deleteMany({ where: { id: decision.existing.id, projectId: context.projectId } });
        this.assertSingleProjectMutation(deleted.count, 'TimelineEvent delete', decision.existing.id);
        result.deleted.push({ id: decision.existing.id, label });
      }
    }
    return this.countPersistSection(result);
  }

  private relationshipKeyForPersist(candidate: ContinuityRelationshipCandidate, existing?: ExistingRelationshipEdge): string {
    if (candidate.action === 'delete') return '';
    const after = this.relationshipAfter(candidate, existing);
    return this.text(after.characterAName, '') && this.text(after.characterBName, '') && this.text(after.relationType, '') ? this.relationshipKeyFromAfter(after) : '';
  }

  private timelineKeyForPersist(candidate: ContinuityTimelineCandidate, existing: ExistingTimelineEvent | undefined, chaptersById: Map<string, ChapterRef>, chaptersByNo: Map<number, ChapterRef>): string {
    if (candidate.action === 'delete') return '';
    const after = this.timelineAfter(candidate, existing, this.resolveChapterRefForPersist(candidate, chaptersById, chaptersByNo, []));
    return this.text(after.title, '') ? this.timelineKeyFromAfter(after) : '';
  }

  private resolveChapterRefForPersist(candidate: ContinuityTimelineCandidate, chaptersById: Map<string, ChapterRef>, chaptersByNo: Map<number, ChapterRef>, errors: string[]): { chapterId: string | null; chapterNo: number | null } | undefined {
    if (candidate.chapterId) {
      if (!this.looksLikeUuid(candidate.chapterId)) {
        errors.push(`Timeline ${candidate.candidateId} chapterId is not a UUID.`);
        return undefined;
      }
      const chapter = chaptersById.get(candidate.chapterId);
      if (!chapter) {
        errors.push(`Timeline ${candidate.candidateId} chapterId does not belong to current project.`);
        return undefined;
      }
      if (candidate.chapterNo !== undefined && candidate.chapterNo !== chapter.chapterNo) errors.push(`Timeline ${candidate.candidateId} chapterNo does not match chapterId.`);
      return { chapterId: chapter.id, chapterNo: chapter.chapterNo };
    }
    if (candidate.chapterNo !== undefined) {
      const chapter = chaptersByNo.get(candidate.chapterNo);
      if (!chapter) {
        errors.push(`Timeline ${candidate.candidateId} chapterNo does not belong to current project.`);
        return undefined;
      }
      return { chapterId: chapter.id, chapterNo: chapter.chapterNo };
    }
    return undefined;
  }

  private appendCharacterRefErrors(id: string | undefined, name: string | undefined, label: string, characters: Map<string, CharacterRef>, errors: string[], candidateId: string) {
    if (!id) return;
    if (!this.looksLikeUuid(id)) {
      errors.push(`${candidateId} ${label}Id is not a UUID.`);
      return;
    }
    const character = characters.get(id);
    if (!character) {
      errors.push(`${candidateId} ${label}Id does not belong to current project.`);
      return;
    }
    if (!name?.trim()) errors.push(`${candidateId} ${label}Id requires matching ${label}Name.`);
    else if (character.name.trim() !== name.trim()) errors.push(`${candidateId} ${label}Id/name mismatch.`);
  }

  private appendExplicitProjectIdError(candidate: unknown, errors: string[], candidateId: string) {
    const record = this.asRecord(candidate);
    if (record && Object.prototype.hasOwnProperty.call(record, 'projectId')) {
      errors.push(`${candidateId} must not include projectId; persist_continuity_changes always writes under context.projectId.`);
    }
  }

  private appendTimelineCharacterIdErrors(ids: string[] | undefined, names: string[], field: string, nameField: string, characters: Map<string, CharacterRef>, errors: string[], candidateId: string) {
    if (ids === undefined) return;
    if (ids.length !== names.length) errors.push(`${candidateId} ${field} must align one-to-one with ${nameField}.`);
    ids.forEach((id, index) => {
      if (!this.looksLikeUuid(id)) {
        errors.push(`${candidateId} ${field} contains a non-UUID value: ${id}.`);
        return;
      }
      const character = characters.get(id);
      if (!character) {
        errors.push(`${candidateId} ${field} references a Character outside current project: ${id}.`);
        return;
      }
      const name = names[index];
      if (!name || character.name.trim() !== name.trim()) errors.push(`${candidateId} ${field}/${nameField} mismatch at index ${index}: ${id} is ${character.name}, not ${name ?? '<missing>'}.`);
    });
  }

  private assertSingleProjectMutation(count: number, operation: string, id: string) {
    if (count !== 1) throw new BadRequestException(`${operation} failed project-scoped write check for ${id}.`);
  }

  private async loadCharactersForTx(tx: Prisma.TransactionClient, projectId: string, ids: string[]): Promise<Map<string, CharacterRef>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Map();
    const rows = await tx.character.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadChaptersByIdForTx(tx: Prisma.TransactionClient, projectId: string, ids: string[]): Promise<Map<string, ChapterRef>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Map();
    const rows = await tx.chapter.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true, chapterNo: true } });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private async loadChaptersByNoForTx(tx: Prisma.TransactionClient, projectId: string, chapterNos: number[]): Promise<Map<number, ChapterRef>> {
    const validNos = [...new Set(chapterNos.filter((chapterNo) => Number.isInteger(chapterNo) && chapterNo > 0))];
    if (!validNos.length) return new Map();
    const rows = await tx.chapter.findMany({ where: { projectId, chapterNo: { in: validNos } }, select: { id: true, chapterNo: true } });
    return new Map(rows.map((row) => [row.chapterNo, row]));
  }

  private buildMetadata(candidate: ContinuityRelationshipCandidate | ContinuityTimelineCandidate, context: ToolContext, persistedAt: string, existingMetadata?: unknown): Prisma.InputJsonValue {
    const base = this.asRecord(existingMetadata) ?? {};
    const candidateMetadata = { ...(this.asRecord(candidate.metadata) ?? {}) };
    delete candidateMetadata.projectId;
    return this.toJsonValue({
      ...base,
      ...candidateMetadata,
      sourceKind: this.sourceKind,
      sourceType: 'agent_continuity',
      sourceTool: 'persist_continuity_changes',
      sourceTrace: candidate.sourceTrace,
      continuityCandidateId: candidate.candidateId,
      agentRunId: context.agentRunId,
      persistedAt,
    });
  }

  private buildSkippedUnselected(relationships: ContinuityRelationshipCandidate[], timeline: ContinuityTimelineCandidate[], selectedRelationships: ContinuityRelationshipCandidate[], selectedTimeline: ContinuityTimelineCandidate[]) {
    const selectedRelationshipIds = new Set(selectedRelationships.map((candidate) => candidate.candidateId));
    const selectedTimelineIds = new Set(selectedTimeline.map((candidate) => candidate.candidateId));
    return {
      relationshipCandidates: relationships.filter((candidate) => !selectedRelationshipIds.has(candidate.candidateId)).map((candidate) => ({ candidateId: candidate.candidateId, label: this.relationshipLabel(candidate) })),
      timelineCandidates: timeline.filter((candidate) => !selectedTimelineIds.has(candidate.candidateId)).map((candidate) => ({ candidateId: candidate.candidateId, label: this.timelineLabel(candidate) })),
    };
  }

  private selectedWritePreview(validation: ValidateContinuityChangesOutput, relationships: ContinuityRelationshipCandidate[], timeline: ContinuityTimelineCandidate[]): PersistContinuityChangesOutput['writePreview'] {
    const relationshipIds = new Set(relationships.map((candidate) => candidate.candidateId));
    const timelineIds = new Set(timeline.map((candidate) => candidate.candidateId));
    return {
      relationshipCandidates: validation.writePreview.relationshipCandidates.entries.filter((entry) => relationshipIds.has(entry.candidateId)),
      timelineCandidates: validation.writePreview.timelineCandidates.entries.filter((entry) => timelineIds.has(entry.candidateId)),
    };
  }

  private emptyPersistSection(): ContinuityPersistSectionResult {
    return { createdCount: 0, updatedCount: 0, deletedCount: 0, created: [], updated: [], deleted: [] };
  }

  private countPersistSection(result: ContinuityPersistSectionResult): ContinuityPersistSectionResult {
    return { ...result, createdCount: result.created.length, updatedCount: result.updated.length, deletedCount: result.deleted.length };
  }

  private getRelationshipCandidates(preview?: ContinuityPreviewOutput): ContinuityRelationshipCandidate[] {
    return this.recordArray(this.asRecord(preview)?.relationshipCandidates) as unknown as ContinuityRelationshipCandidate[];
  }

  private getTimelineCandidates(preview?: ContinuityPreviewOutput): ContinuityTimelineCandidate[] {
    return this.recordArray(this.asRecord(preview)?.timelineCandidates) as unknown as ContinuityTimelineCandidate[];
  }
}
