import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import {
  assertNoTimelineDuplicateConflicts,
  normalizeTimelinePreviewOutput,
  summarizeTimelineActions,
  validateTimelineCandidateChapterRefs,
} from './timeline-preview.support';
import type { ExistingTimelineEventRef, TimelineChapterRefRow, TimelineResolvedChapterRef } from './timeline-preview.support';
import type {
  GenerateTimelinePreviewOutput,
  TimelineCandidate,
  TimelineCandidateAction,
  TimelineCandidateSourceKind,
  TimelineCandidateWriteFields,
  TimelineValidationIssue,
  TimelineWritePreviewEntry,
  ValidateTimelinePreviewInput,
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

const TIMELINE_SOURCE_KINDS = new Set<TimelineCandidateSourceKind>(['planned_timeline_event', 'chapter_timeline_alignment']);
const TIMELINE_PREVIEW_ORIGIN_BY_SOURCE_KIND: Record<TimelineCandidateSourceKind, 'generate_timeline_preview' | 'align_chapter_timeline_preview'> = {
  planned_timeline_event: 'generate_timeline_preview',
  chapter_timeline_alignment: 'align_chapter_timeline_preview',
};

@Injectable()
export class ValidateTimelinePreviewTool implements BaseTool<ValidateTimelinePreviewInput, ValidateTimelinePreviewOutput> {
  name = 'validate_timeline_preview';
  description = 'Validate TimelineEvent preview candidates and produce accepted/rejected write previews without writing to the database.';
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
    required: ['valid', 'issueCount', 'issues', 'accepted', 'rejected', 'writePreview'],
    additionalProperties: false,
    properties: {
      valid: { type: 'boolean' as const },
      issueCount: { type: 'number' as const },
      issues: { type: 'array' as const },
      accepted: { type: 'array' as const },
      rejected: { type: 'array' as const },
      writePreview: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Validate Timeline Preview',
    description: 'Validate timeline-only candidates, check current-project chapter refs and duplicate TimelineEvents, and return accepted/rejected writePreview entries. This tool is read-only.',
    whenToUse: [
      'After generate_timeline_preview or align_chapter_timeline_preview returns timeline candidates.',
      'Before any persist_timeline_events step.',
      'When the agent needs an auditable accepted/rejected diff for TimelineEvent changes.',
    ],
    whenNotToUse: [
      'The user asks to write TimelineEvent rows immediately; persist_timeline_events must run after approval.',
      'The input is missing a preview output from a timeline-only preview tool.',
      'The task is relationship continuity validation; use validate_continuity_changes for mixed continuity previews.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_timeline_preview or align_chapter_timeline_preview.' },
      taskContext: { source: 'previous_step', description: 'Optional project/chapter context for audit display only; validation still rechecks DB refs by context.projectId.' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'timelineEventId'],
      allowedSources: ['projectId from ToolContext only', 'chapter refs from preview and current-project DB lookup', 'timelineEventId from current-project DB lookup only'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateTimelinePreviewInput, context: ToolContext): Promise<ValidateTimelinePreviewOutput> {
    const sourceKind = this.readWritePlanSourceKind(args.preview);
    const expectedOriginTool = TIMELINE_PREVIEW_ORIGIN_BY_SOURCE_KIND[sourceKind];
    const preview = normalizeTimelinePreviewOutput(args.preview, {
      expectedProjectId: context.projectId,
      expectedSourceKind: sourceKind,
      expectedOriginTool,
      sourceKind,
      minCandidates: 1,
    });
    this.assertWritePlan(args.preview, preview, sourceKind);
    this.assertTraceTrust(preview, context, expectedOriginTool);

    const chapters = await this.loadChapterRefs(context.projectId, preview);
    const resolvedChapterRefs = validateTimelineCandidateChapterRefs(preview.candidates, chapters, context.projectId);
    const existingEvents = await this.loadExistingTimelineEvents(context.projectId);
    assertNoTimelineDuplicateConflicts(preview.candidates, existingEvents, { expectedProjectId: context.projectId, resolvedChapterRefs });

    const existingById = new Map(existingEvents.map((event) => [event.id, event]));
    const resolvedByCandidateId = new Map(resolvedChapterRefs.map((ref) => [ref.candidateId, ref]));
    const issues = this.collectIssues(preview.candidates, existingById);
    const errorsByCandidateId = this.errorsByCandidateId(issues);
    const accepted = [];
    const rejected = [];
    const entries: TimelineWritePreviewEntry[] = [];

    for (const candidate of preview.candidates) {
      const candidateErrors = errorsByCandidateId.get(candidate.candidateId) ?? [];
      const existing = candidate.existingTimelineEventId ? existingById.get(candidate.existingTimelineEventId) ?? null : null;
      const resolved = resolvedByCandidateId.get(candidate.candidateId);
      const before = existing ? this.before(existing) : null;
      const after = candidateErrors.length ? null : this.after(candidate, resolved);
      const label = candidate.title;
      if (candidateErrors.length) {
        rejected.push({
          candidateId: candidate.candidateId,
          action: candidate.action,
          label,
          reason: candidateErrors.join('; '),
          issues: candidateErrors,
        });
      } else {
        accepted.push({
          candidateId: candidate.candidateId,
          action: candidate.action,
          existingTimelineEventId: candidate.existingTimelineEventId ?? null,
          label,
          chapterId: resolved?.chapterId ?? candidate.chapterId ?? null,
          chapterNo: resolved?.chapterNo ?? candidate.chapterNo ?? null,
          sourceTrace: candidate.sourceTrace,
        });
      }
      entries.push({
        candidateId: candidate.candidateId,
        action: candidateErrors.length ? 'reject' : candidate.action,
        existingTimelineEventId: candidate.existingTimelineEventId ?? null,
        label,
        ...(candidateErrors.length ? { reason: candidateErrors.join('; ') } : {}),
        before,
        after,
        fieldDiff: this.fieldDiff(before, after),
        sourceTrace: candidate.sourceTrace,
      });
    }

    const summary = summarizeTimelineActions(preview.candidates);
    summary.rejectCount = rejected.length;
    return {
      valid: issues.every((issue) => issue.severity !== 'error') && accepted.length > 0,
      issueCount: issues.length,
      issues,
      accepted,
      rejected,
      writePreview: {
        projectScope: 'context.projectId',
        target: 'TimelineEvent',
        sourceKind,
        summary,
        entries,
        requiresApprovalBeforePersist: true,
        approvalMessage: 'Persist requires explicit approval in act mode. persist_timeline_events must recheck preview, validation, selected candidates, sourceTrace, and context.projectId before writing.',
      },
    };
  }

  private readWritePlanSourceKind(preview: unknown): TimelineCandidateSourceKind {
    const record = this.requireRecord(preview, 'preview');
    const writePlan = this.requireRecord(record.writePlan, 'preview.writePlan');
    const sourceKind = writePlan.sourceKind;
    if (typeof sourceKind !== 'string' || !TIMELINE_SOURCE_KINDS.has(sourceKind as TimelineCandidateSourceKind)) {
      throw new Error('preview.writePlan.sourceKind is invalid.');
    }
    return sourceKind as TimelineCandidateSourceKind;
  }

  private assertWritePlan(rawPreview: unknown, preview: GenerateTimelinePreviewOutput, sourceKind: TimelineCandidateSourceKind): void {
    const record = this.requireRecord(rawPreview, 'preview');
    const writePlan = this.requireRecord(record.writePlan, 'preview.writePlan');
    if (writePlan.mode !== 'preview_only') throw new Error('preview.writePlan.mode must be preview_only.');
    if (writePlan.target !== 'TimelineEvent') throw new Error('preview.writePlan.target must be TimelineEvent.');
    if (writePlan.sourceKind !== sourceKind) throw new Error('preview.writePlan.sourceKind does not match normalized preview.');
    if (writePlan.requiresValidation !== true) throw new Error('preview.writePlan.requiresValidation must be true.');
    if (writePlan.requiresApprovalBeforePersist !== true) throw new Error('preview.writePlan.requiresApprovalBeforePersist must be true.');
    if (typeof writePlan.candidateCount !== 'number' || writePlan.candidateCount !== preview.candidates.length) {
      throw new Error('preview.writePlan.candidateCount must match candidates.length.');
    }
  }

  private assertTraceTrust(preview: GenerateTimelinePreviewOutput, context: ToolContext, expectedOriginTool: 'generate_timeline_preview' | 'align_chapter_timeline_preview'): void {
    for (const [index, candidate] of preview.candidates.entries()) {
      const path = `timelineCandidates[${index}].sourceTrace`;
      if (candidate.sourceTrace.agentRunId !== context.agentRunId) {
        throw new Error(`${path}.agentRunId must match current agent run.`);
      }
      if (candidate.sourceTrace.toolName !== expectedOriginTool) {
        throw new Error(`${path}.toolName must be ${expectedOriginTool}.`);
      }
      if (!candidate.sourceTrace.evidence) {
        throw new Error(`${path}.evidence is required.`);
      }
      if (candidate.chapterId && candidate.sourceTrace.chapterId !== candidate.chapterId) {
        throw new Error(`${path}.chapterId must match candidate chapterId.`);
      }
      if (candidate.chapterNo !== undefined && candidate.sourceTrace.chapterNo !== candidate.chapterNo) {
        throw new Error(`${path}.chapterNo must match candidate chapterNo.`);
      }
    }
  }

  private collectIssues(candidates: TimelineCandidate[], existingById: Map<string, ExistingTimelineEventRow>): TimelineValidationIssue[] {
    const issues: TimelineValidationIssue[] = [];
    for (const candidate of candidates) {
      const path = `timelineCandidates.${candidate.candidateId}`;
      const existing = candidate.existingTimelineEventId ? existingById.get(candidate.existingTimelineEventId) : undefined;
      if (candidate.action === 'create_planned') {
        if (candidate.existingTimelineEventId) {
          issues.push(this.issue(candidate, 'create_planned must not include existingTimelineEventId.', `${path}.existingTimelineEventId`));
        }
        if (candidate.eventStatus !== 'planned') {
          issues.push(this.issue(candidate, 'create_planned candidates must have eventStatus=planned.', `${path}.eventStatus`));
        }
        if (candidate.sourceType !== 'agent_timeline_plan') {
          issues.push(this.issue(candidate, 'create_planned candidates must have sourceType=agent_timeline_plan.', `${path}.sourceType`));
        }
      } else if (candidate.action === 'create_discovered') {
        if (candidate.existingTimelineEventId) {
          issues.push(this.issue(candidate, 'create_discovered must not include existingTimelineEventId.', `${path}.existingTimelineEventId`));
        }
      } else {
        if (!candidate.existingTimelineEventId) {
          issues.push(this.issue(candidate, `${candidate.action} requires existingTimelineEventId.`, `${path}.existingTimelineEventId`));
        } else if (!existing) {
          issues.push(this.issue(candidate, `existingTimelineEventId does not belong to current project: ${candidate.existingTimelineEventId}.`, `${path}.existingTimelineEventId`));
        }
      }
      if (candidate.action === 'archive_event' && candidate.eventStatus !== 'archived') {
        issues.push(this.issue(candidate, 'archive_event candidates must set eventStatus=archived.', `${path}.eventStatus`));
      }
      if (candidate.action === 'confirm_planned' && candidate.eventStatus !== 'active') {
        issues.push(this.issue(candidate, 'confirm_planned candidates must set eventStatus=active.', `${path}.eventStatus`));
      }
      if (candidate.action === 'create_discovered' && candidate.eventStatus === 'planned') {
        issues.push(this.issue(candidate, 'create_discovered candidates must not remain eventStatus=planned.', `${path}.eventStatus`));
      }
    }
    return issues;
  }

  private errorsByCandidateId(issues: TimelineValidationIssue[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const issue of issues) {
      if (!issue.candidateId || issue.severity !== 'error') continue;
      const errors = result.get(issue.candidateId) ?? [];
      errors.push(issue.message);
      result.set(issue.candidateId, errors);
    }
    return result;
  }

  private issue(candidate: TimelineCandidate, message: string, path?: string): TimelineValidationIssue {
    return {
      severity: 'error',
      candidateId: candidate.candidateId,
      action: candidate.action,
      message,
      ...(path ? { path } : {}),
    };
  }

  private before(existing: ExistingTimelineEventRow): Record<string, unknown> {
    return {
      id: existing.id,
      chapterId: existing.chapterId ?? null,
      chapterNo: existing.chapterNo ?? null,
      title: existing.title,
      eventTime: existing.eventTime ?? null,
      locationName: existing.locationName ?? null,
      participants: this.stringArray(existing.participants),
      cause: existing.cause ?? null,
      result: existing.result ?? null,
      impactScope: existing.impactScope ?? null,
      isPublic: existing.isPublic ?? false,
      knownBy: this.stringArray(existing.knownBy),
      unknownBy: this.stringArray(existing.unknownBy),
      eventStatus: existing.eventStatus ?? '',
      sourceType: existing.sourceType ?? '',
      metadata: existing.metadata ?? {},
    };
  }

  private after(candidate: TimelineCandidate, resolved?: TimelineResolvedChapterRef): TimelineCandidateWriteFields {
    const chapterId = resolved?.chapterId ?? candidate.chapterId;
    const chapterNo = resolved?.chapterNo ?? candidate.chapterNo;
    if (chapterId) {
      return {
        ...candidate.proposedFields,
        chapterId,
        ...(chapterNo !== undefined ? { chapterNo } : {}),
      };
    }
    if (chapterNo !== undefined) {
      return {
        ...candidate.proposedFields,
        chapterNo,
      };
    }
    throw new Error(`Timeline candidate ${candidate.candidateId} must reference a current-project chapter.`);
  }

  private fieldDiff(before: Record<string, unknown> | null, after: TimelineCandidateWriteFields | null): Record<string, boolean> {
    if (!after) return {};
    if (!before) return Object.fromEntries(Object.keys(after).map((key) => [key, true]));
    return Object.fromEntries(Object.keys(after).map((key) => [key, JSON.stringify(before[key] ?? null) !== JSON.stringify((after as unknown as Record<string, unknown>)[key] ?? null)]));
  }

  private async loadChapterRefs(projectId: string, preview: GenerateTimelinePreviewOutput): Promise<TimelineChapterRefRow[]> {
    const chapterIds = [...new Set(preview.candidates.map((candidate) => candidate.chapterId).filter((value): value is string => Boolean(value)))];
    const chapterNos = [...new Set(preview.candidates.map((candidate) => candidate.chapterNo).filter((value): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0))];
    const or: Array<Record<string, unknown>> = [];
    if (chapterIds.length) or.push({ id: { in: chapterIds } });
    if (chapterNos.length) or.push({ chapterNo: { in: chapterNos } });
    if (!or.length) return [];
    const where = or.length === 1 ? { projectId, ...or[0] } : { projectId, OR: or };
    return this.prisma.chapter.findMany({
      where,
      select: { id: true, projectId: true, chapterNo: true },
    });
  }

  private async loadExistingTimelineEvents(projectId: string): Promise<ExistingTimelineEventRow[]> {
    return this.prisma.timelineEvent.findMany({
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

  private requireRecord(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${path} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
  }
}
