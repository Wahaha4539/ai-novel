import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import {
  assertNoTimelineDuplicateConflicts,
  normalizeTimelinePreviewOutput,
  validateTimelineCandidateChapterRefs,
} from './timeline-preview.support';
import type { ExistingTimelineEventRef, TimelineChapterRefRow, TimelineResolvedChapterRef } from './timeline-preview.support';
import type {
  GenerateTimelinePreviewOutput,
  PersistTimelineEventsInput,
  PersistTimelineEventsOutput,
  TimelineAcceptedCandidate,
  TimelineCandidate,
  TimelineCandidateAction,
  TimelineCandidateSourceKind,
  TimelineCandidateWriteFields,
  TimelineWritePreviewEntry,
  ValidateTimelinePreviewOutput,
} from './timeline-preview.types';

type ExistingTimelineEventRow = ExistingTimelineEventRef & {
  locationName?: string | null;
  participants?: unknown;
  cause?: string | null;
  result?: string | null;
  impactScope?: string | null;
  isPublic?: boolean;
  knownBy?: unknown;
  unknownBy?: unknown;
  eventStatus?: string;
  sourceType?: string;
  metadata?: unknown;
};

type PersistDecision = {
  candidate: TimelineCandidate;
  existing: ExistingTimelineEventRow | null;
  resolved: TimelineResolvedChapterRef;
};

const TIMELINE_SOURCE_KINDS = new Set<TimelineCandidateSourceKind>(['planned_timeline_event', 'chapter_timeline_alignment']);
const TIMELINE_ORIGIN_BY_SOURCE_KIND: Record<TimelineCandidateSourceKind, 'generate_timeline_preview' | 'align_chapter_timeline_preview'> = {
  planned_timeline_event: 'generate_timeline_preview',
  chapter_timeline_alignment: 'align_chapter_timeline_preview',
};

@Injectable()
export class PersistTimelineEventsTool implements BaseTool<PersistTimelineEventsInput, PersistTimelineEventsOutput> {
  name = 'persist_timeline_events';
  description = 'Persist approved TimelineEvent candidates after timeline preview validation.';
  inputSchema = {
    type: 'object' as const,
    required: ['preview', 'validation'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      validation: { type: 'object' as const },
      selectedCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      dryRun: { type: 'boolean' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['createdCount', 'confirmedCount', 'updatedCount', 'archivedCount', 'skippedUnselectedCount', 'events'],
    additionalProperties: false,
    properties: {
      createdCount: { type: 'number' as const },
      confirmedCount: { type: 'number' as const },
      updatedCount: { type: 'number' as const },
      archivedCount: { type: 'number' as const },
      skippedUnselectedCount: { type: 'number' as const },
      events: { type: 'array' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['Writes TimelineEvent rows after validation and approval.'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Persist Timeline Events',
    description: 'Write selected TimelineEvent candidates only after validate_timeline_preview passes and the user approves the Act run.',
    whenToUse: [
      'After generate_timeline_preview/align_chapter_timeline_preview and validate_timeline_preview have produced accepted writePreview entries.',
      'When the user approved writing selected planned or aligned timeline candidates.',
    ],
    whenNotToUse: [
      'In Plan mode or before explicit user approval.',
      'When validate_timeline_preview is missing, invalid, stale, or rejected the selected candidates.',
      'When the preview or validation object was not produced by previous tool steps in the current run.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Exact previous generate_timeline_preview or align_chapter_timeline_preview output.' },
      validation: { source: 'previous_step', description: 'Exact previous validate_timeline_preview output for the same preview.' },
      selectedCandidateIds: { source: 'user_message', description: 'Optional explicit approved subset. Defaults to validation.accepted.' },
      dryRun: { source: 'literal', description: 'Optional approved dry run; revalidates but does not write business tables.' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'timelineEventId', 'candidateId'],
      allowedSources: ['projectId from ToolContext only', 'candidateId/sourceTrace from previous preview and validation outputs', 'timelineEventId from current-project DB lookup only'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: PersistTimelineEventsInput, context: ToolContext): Promise<PersistTimelineEventsOutput> {
    this.assertExecutableInput(args, context);
    const sourceKind = this.readSourceKind(args.preview);
    const originTool = TIMELINE_ORIGIN_BY_SOURCE_KIND[sourceKind];
    const preview = normalizeTimelinePreviewOutput(args.preview, {
      expectedProjectId: context.projectId,
      expectedSourceKind: sourceKind,
      expectedOriginTool: originTool,
      sourceKind,
      minCandidates: 1,
    });
    const validation = args.validation as ValidateTimelinePreviewOutput;
    const selected = this.selectCandidates(args, preview, validation);
    this.assertSelectedAllowed(preview, validation, selected, context);
    const skippedUnselectedCount = preview.candidates.filter((candidate) => !selected.some((item) => item.candidateId === candidate.candidateId)).length;

    if (args.dryRun === true) {
      return {
        createdCount: 0,
        confirmedCount: 0,
        updatedCount: 0,
        archivedCount: 0,
        skippedUnselectedCount,
        events: [],
      };
    }

    const persistedAt = new Date().toISOString();
    return this.prisma.$transaction(async (tx) => {
      const decisions = await this.buildPersistDecisions(tx, selected, context.projectId);
      const events: PersistTimelineEventsOutput['events'] = [];
      let createdCount = 0;
      let confirmedCount = 0;
      let updatedCount = 0;
      let archivedCount = 0;

      for (const decision of decisions) {
        const action = decision.candidate.action;
        if (action === 'create_planned' || action === 'create_discovered') {
          const created = await tx.timelineEvent.create({
            data: this.buildCreateData(decision.candidate, decision.resolved, context, persistedAt),
            select: { id: true, eventStatus: true },
          });
          createdCount += 1;
          events.push({ candidateId: decision.candidate.candidateId, action, timelineEventId: created.id, eventStatus: created.eventStatus });
        } else {
          if (!decision.existing) throw new BadRequestException(`Timeline candidate ${decision.candidate.candidateId} targets a missing current-project TimelineEvent.`);
          const updated = await tx.timelineEvent.updateMany({
            where: { id: decision.existing.id, projectId: context.projectId },
            data: this.buildUpdateData(decision.candidate, decision.resolved, context, persistedAt, decision.existing.metadata),
          });
          if (updated.count !== 1) {
            throw new BadRequestException(`TimelineEvent update failed project-scoped write check for ${decision.existing.id}.`);
          }
          if (action === 'confirm_planned') confirmedCount += 1;
          else if (action === 'archive_event') archivedCount += 1;
          else updatedCount += 1;
          events.push({ candidateId: decision.candidate.candidateId, action, timelineEventId: decision.existing.id, eventStatus: decision.candidate.eventStatus });
        }
      }

      return {
        createdCount,
        confirmedCount,
        updatedCount,
        archivedCount,
        skippedUnselectedCount,
        events,
      };
    });
  }

  private assertExecutableInput(args: PersistTimelineEventsInput, context: ToolContext): void {
    if (context.mode !== 'act') throw new BadRequestException('persist_timeline_events can only run in Agent act mode.');
    if (!context.approved) throw new BadRequestException('persist_timeline_events requires explicit user approval.');
    if (!args.preview) throw new BadRequestException('persist_timeline_events requires timeline preview output.');
    if (!args.validation) throw new BadRequestException('persist_timeline_events requires validate_timeline_preview output.');
    if (args.validation.valid !== true) throw new BadRequestException('validate_timeline_preview did not pass; persist_timeline_events will not write.');
    if (args.preview.writePlan?.target !== 'TimelineEvent' || args.preview.writePlan?.requiresApprovalBeforePersist !== true) {
      throw new BadRequestException('Timeline preview has an invalid writePlan.');
    }
    if (args.validation.writePreview?.target !== 'TimelineEvent' || args.validation.writePreview?.requiresApprovalBeforePersist !== true) {
      throw new BadRequestException('Timeline validation has an invalid writePreview.');
    }
    this.assertPreviousToolOutput(args.preview, context, TIMELINE_ORIGIN_BY_SOURCE_KIND[this.readSourceKind(args.preview)], 'preview');
    this.assertPreviousToolOutput(args.validation, context, 'validate_timeline_preview', 'validation');
  }

  private assertPreviousToolOutput(value: unknown, context: ToolContext, expectedTool: string, field: 'preview' | 'validation'): void {
    const match = Object.entries(context.outputs ?? {}).find(([stepNo, output]) => output === value && context.stepTools?.[Number(stepNo)] === expectedTool);
    if (!match) {
      throw new BadRequestException(`persist_timeline_events ${field} must reference previous ${expectedTool} output via {{steps.N.output}}.`);
    }
  }

  private readSourceKind(preview: unknown): TimelineCandidateSourceKind {
    const record = this.requireRecord(preview, 'preview');
    const writePlan = this.requireRecord(record.writePlan, 'preview.writePlan');
    const sourceKind = writePlan.sourceKind;
    if (typeof sourceKind !== 'string' || !TIMELINE_SOURCE_KINDS.has(sourceKind as TimelineCandidateSourceKind)) {
      throw new BadRequestException('preview.writePlan.sourceKind is invalid.');
    }
    return sourceKind as TimelineCandidateSourceKind;
  }

  private selectCandidates(args: PersistTimelineEventsInput, preview: GenerateTimelinePreviewOutput, validation: ValidateTimelinePreviewOutput): TimelineCandidate[] {
    const explicitIds = this.stringArray(args.selectedCandidateIds);
    const previewIds = new Set(preview.candidates.map((candidate) => candidate.candidateId));
    const unknown = explicitIds.filter((candidateId) => !previewIds.has(candidateId));
    if (unknown.length) throw new BadRequestException(`Unknown timeline candidate selection: ${unknown.join(', ')}`);

    const selectedIds = explicitIds.length
      ? new Set(explicitIds)
      : new Set(this.stringArray(validation.accepted.map((candidate) => candidate.candidateId)));
    const selected = preview.candidates.filter((candidate) => selectedIds.has(candidate.candidateId));
    if (!selected.length) throw new BadRequestException('No accepted timeline candidates selected for persist.');
    return selected;
  }

  private assertSelectedAllowed(preview: GenerateTimelinePreviewOutput, validation: ValidateTimelinePreviewOutput, selected: TimelineCandidate[], context: ToolContext): void {
    const acceptedById = new Map(validation.accepted.map((candidate) => [candidate.candidateId, candidate]));
    const rejectedById = new Set(validation.rejected.map((candidate) => candidate.candidateId));
    const writeById = new Map(validation.writePreview.entries.filter((entry) => entry.action !== 'reject').map((entry) => [entry.candidateId, entry]));
    const previewById = new Map(preview.candidates.map((candidate) => [candidate.candidateId, candidate]));
    const errors: string[] = [];

    for (const candidate of selected) {
      const accepted = acceptedById.get(candidate.candidateId);
      const writeEntry = writeById.get(candidate.candidateId);
      if (!previewById.has(candidate.candidateId)) errors.push(`${candidate.candidateId} is not present in preview.`);
      if (rejectedById.has(candidate.candidateId)) errors.push(`${candidate.candidateId} was rejected by validate_timeline_preview.`);
      if (!accepted) errors.push(`${candidate.candidateId} was not accepted by validate_timeline_preview.`);
      if (!writeEntry) errors.push(`${candidate.candidateId} is missing an accepted writePreview entry.`);
      if (candidate.sourceTrace.agentRunId !== context.agentRunId) errors.push(`${candidate.candidateId} sourceTrace.agentRunId does not match current agent run.`);
      if (accepted) this.assertAcceptedMatches(candidate, accepted, errors);
      if (writeEntry) this.assertWriteEntryMatches(candidate, writeEntry, errors);
    }
    if (errors.length) throw new BadRequestException(`validate_timeline_preview output does not approve selected candidates: ${[...new Set(errors)].join('; ')}`);
  }

  private assertAcceptedMatches(candidate: TimelineCandidate, accepted: TimelineAcceptedCandidate, errors: string[]): void {
    if (accepted.action !== candidate.action) errors.push(`${candidate.candidateId} action does not match validation.accepted.`);
    if ((accepted.existingTimelineEventId ?? null) !== (candidate.existingTimelineEventId ?? null)) errors.push(`${candidate.candidateId} existingTimelineEventId does not match validation.accepted.`);
    if (!this.sameSourceTrace(candidate.sourceTrace, accepted.sourceTrace)) errors.push(`${candidate.candidateId} sourceTrace does not match validation.accepted.`);
  }

  private assertWriteEntryMatches(candidate: TimelineCandidate, entry: TimelineWritePreviewEntry, errors: string[]): void {
    if (entry.action !== candidate.action) errors.push(`${candidate.candidateId} action does not match validation.writePreview.`);
    if ((entry.existingTimelineEventId ?? null) !== (candidate.existingTimelineEventId ?? null)) errors.push(`${candidate.candidateId} existingTimelineEventId does not match validation.writePreview.`);
    if (!entry.after) errors.push(`${candidate.candidateId} validation.writePreview is missing after fields.`);
    if (!this.sameSourceTrace(candidate.sourceTrace, entry.sourceTrace)) errors.push(`${candidate.candidateId} sourceTrace does not match validation.writePreview.`);
    if (entry.after && JSON.stringify(entry.after.metadata.sourceTrace) !== JSON.stringify(candidate.sourceTrace)) errors.push(`${candidate.candidateId} writePreview.after sourceTrace does not match preview candidate.`);
  }

  private async buildPersistDecisions(tx: Prisma.TransactionClient, selected: TimelineCandidate[], projectId: string): Promise<PersistDecision[]> {
    const chapters = await this.loadChapterRefs(tx, projectId, selected);
    const resolved = validateTimelineCandidateChapterRefs(selected, chapters, projectId);
    const resolvedById = new Map(resolved.map((item) => [item.candidateId, item]));
    const existingEvents = await this.loadExistingTimelineEvents(tx, projectId);
    assertNoTimelineDuplicateConflicts(selected, existingEvents, { expectedProjectId: projectId, resolvedChapterRefs: resolved });
    const existingById = new Map(existingEvents.map((event) => [event.id, event]));
    const errors: string[] = [];
    const decisions = selected.map((candidate) => {
      const existing = candidate.existingTimelineEventId ? existingById.get(candidate.existingTimelineEventId) ?? null : null;
      if ((candidate.action === 'create_planned' || candidate.action === 'create_discovered') && candidate.existingTimelineEventId) {
        errors.push(`${candidate.candidateId} create action must not include existingTimelineEventId.`);
      }
      if (candidate.action !== 'create_planned' && candidate.action !== 'create_discovered' && !existing) {
        errors.push(`${candidate.candidateId} targets a missing or cross-project TimelineEvent.`);
      }
      const resolvedRef = resolvedById.get(candidate.candidateId);
      if (!resolvedRef) errors.push(`${candidate.candidateId} does not have a resolved current-project chapter reference.`);
      return { candidate, existing, resolved: resolvedRef as TimelineResolvedChapterRef };
    });
    if (errors.length) throw new BadRequestException(`TimelineEvent write-time validation failed: ${[...new Set(errors)].join('; ')}`);
    return decisions;
  }

  private buildCreateData(candidate: TimelineCandidate, resolved: TimelineResolvedChapterRef, context: ToolContext, persistedAt: string): Prisma.TimelineEventCreateInput {
    const fields = this.withResolvedChapter(candidate.proposedFields, resolved);
    return {
      project: { connect: { id: context.projectId } },
      chapter: { connect: { id: resolved.chapterId } },
      chapterNo: resolved.chapterNo,
      title: fields.title,
      eventTime: fields.eventTime,
      locationName: fields.locationName ?? null,
      participants: this.toJsonValue(fields.participants),
      cause: fields.cause,
      result: fields.result,
      impactScope: fields.impactScope,
      isPublic: fields.isPublic,
      knownBy: this.toJsonValue(fields.knownBy),
      unknownBy: this.toJsonValue(fields.unknownBy),
      eventStatus: fields.eventStatus,
      sourceType: fields.sourceType,
      metadata: this.buildMetadata(candidate, context, persistedAt),
    };
  }

  private buildUpdateData(candidate: TimelineCandidate, resolved: TimelineResolvedChapterRef, context: ToolContext, persistedAt: string, existingMetadata: unknown): Prisma.TimelineEventUncheckedUpdateManyInput {
    const fields = this.withResolvedChapter(candidate.proposedFields, resolved);
    return {
      chapterId: resolved.chapterId,
      chapterNo: resolved.chapterNo,
      title: fields.title,
      eventTime: fields.eventTime,
      locationName: fields.locationName ?? null,
      participants: this.toJsonValue(fields.participants),
      cause: fields.cause,
      result: fields.result,
      impactScope: fields.impactScope,
      isPublic: fields.isPublic,
      knownBy: this.toJsonValue(fields.knownBy),
      unknownBy: this.toJsonValue(fields.unknownBy),
      eventStatus: fields.eventStatus,
      sourceType: fields.sourceType,
      metadata: this.buildMetadata(candidate, context, persistedAt, existingMetadata),
    };
  }

  private withResolvedChapter(fields: TimelineCandidateWriteFields, resolved: TimelineResolvedChapterRef): TimelineCandidateWriteFields {
    return { ...fields, chapterId: resolved.chapterId, chapterNo: resolved.chapterNo };
  }

  private buildMetadata(candidate: TimelineCandidate, context: ToolContext, persistedAt: string, existingMetadata?: unknown): Prisma.InputJsonValue {
    const base = this.isRecord(existingMetadata) ? existingMetadata : {};
    return this.toJsonValue({
      ...base,
      ...candidate.metadata,
      sourceKind: candidate.sourceTrace.sourceKind,
      sourceTrace: candidate.sourceTrace,
      candidateId: candidate.candidateId,
      candidateAction: candidate.action,
      ...(candidate.existingTimelineEventId ? { previousTimelineEventId: candidate.existingTimelineEventId } : {}),
      persistedBy: context.agentRunId,
      persistedAt,
    });
  }

  private async loadChapterRefs(tx: Prisma.TransactionClient, projectId: string, candidates: TimelineCandidate[]): Promise<TimelineChapterRefRow[]> {
    const chapterIds = [...new Set(candidates.map((candidate) => candidate.chapterId).filter((value): value is string => Boolean(value)))];
    const chapterNos = [...new Set(candidates.map((candidate) => candidate.chapterNo).filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0))];
    const or: Array<Record<string, unknown>> = [];
    if (chapterIds.length) or.push({ id: { in: chapterIds } });
    if (chapterNos.length) or.push({ chapterNo: { in: chapterNos } });
    if (!or.length) return [];
    const where = or.length === 1 ? { projectId, ...or[0] } : { projectId, OR: or };
    return tx.chapter.findMany({ where, select: { id: true, projectId: true, chapterNo: true } });
  }

  private async loadExistingTimelineEvents(tx: Prisma.TransactionClient, projectId: string): Promise<ExistingTimelineEventRow[]> {
    return tx.timelineEvent.findMany({
      where: { projectId },
      select: {
        id: true,
        projectId: true,
        chapterId: true,
        chapterNo: true,
        title: true,
        eventTime: true,
        locationName: true,
        participants: true,
        cause: true,
        result: true,
        impactScope: true,
        isPublic: true,
        knownBy: true,
        unknownBy: true,
        eventStatus: true,
        sourceType: true,
        metadata: true,
      },
    });
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
  }

  private sameSourceTrace(left: unknown, right: unknown): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!this.isRecord(value)) {
      throw new BadRequestException(`${path} must be a JSON object.`);
    }
    return value;
  }
}
