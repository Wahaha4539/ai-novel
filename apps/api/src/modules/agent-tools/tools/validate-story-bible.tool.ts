import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeLorebookEntryType, STORY_BIBLE_ENTRY_TYPES } from '../../lorebook/lorebook-entry-types';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { StoryBiblePreviewCandidate, StoryBiblePreviewOutput, StoryBibleSourceTrace } from './generate-story-bible-preview.tool';

interface ValidateStoryBibleInput {
  preview?: StoryBiblePreviewOutput;
  taskContext?: Record<string, unknown>;
}

type StoryBibleIssueSeverity = 'warning' | 'error';
type StoryBibleWriteAction = 'create' | 'update';

interface StoryBibleValidationIssue {
  severity: StoryBibleIssueSeverity;
  message: string;
  candidateId?: string;
  title?: string;
  path?: string;
  suggestion?: string;
}

export interface StoryBibleAcceptedCandidate {
  candidateId: string;
  title: string;
  entryType: string;
  action: StoryBibleWriteAction;
  existingEntryId: string | null;
  sourceTrace?: StoryBibleSourceTrace;
}

export interface StoryBibleRejectedCandidate {
  candidateId: string;
  title: string;
  entryType: string;
  reason: string;
  issues: string[];
}

export interface ValidateStoryBibleOutput {
  valid: boolean;
  issueCount: number;
  issues: StoryBibleValidationIssue[];
  accepted: StoryBibleAcceptedCandidate[];
  rejected: StoryBibleRejectedCandidate[];
  writePreview: {
    target: 'LorebookEntry';
    projectScope: 'context.projectId';
    sourceKind: 'planned_story_bible_asset';
    summary: { createCount: number; updateCount: number; rejectCount: number };
    entries: Array<{
      candidateId: string;
      title: string;
      entryType: string;
      action: StoryBibleWriteAction | 'reject';
      existingEntryId: string | null;
      existingStatus: string | null;
      reason?: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown>;
      fieldDiff: Record<string, boolean>;
      sourceTrace?: StoryBibleSourceTrace;
    }>;
    approvalMessage: string;
  };
}

interface ExistingLorebookEntry {
  id: string;
  title: string;
  entryType: string;
  summary: string | null;
  content: string;
  tags: unknown;
  triggerKeywords: unknown;
  relatedEntityIds: unknown;
  priority: number;
  status: string;
  sourceType: string;
  metadata: unknown;
  updatedAt: Date;
}

const STORY_BIBLE_TYPE_VALUES = [...STORY_BIBLE_ENTRY_TYPES];
const STORY_BIBLE_TYPE_SET = new Set<string>(STORY_BIBLE_TYPE_VALUES);

@Injectable()
export class ValidateStoryBibleTool implements BaseTool<ValidateStoryBibleInput, ValidateStoryBibleOutput> {
  name = 'validate_story_bible';
  description = 'Validate Story Bible preview candidates and produce a read-only LorebookEntry write preview.';
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
    required: ['valid', 'issues', 'accepted', 'rejected', 'writePreview'],
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
    displayName: 'Validate Story Bible',
    description: 'Read-only validation for generate_story_bible_preview output. Checks missing fields, duplicate titles, same-project existing titles, and locked LorebookEntry metadata conflicts.',
    whenToUse: [
      'After generate_story_bible_preview and before persist_story_bible.',
      'When the user needs an approval-ready diff of Story Bible create/update candidates.',
      'When selected Story Bible assets must be checked against existing LorebookEntry records in the current project.',
    ],
    whenNotToUse: [
      'There is no Story Bible preview output.',
      'The user only wants chapter prose or style polishing.',
      'This must not be used as the approved write step; persist_story_bible performs the write after approval.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_story_bible_preview.' },
      taskContext: { source: 'previous_step', description: 'Optional task context retained for traceability; database validation uses context.projectId.' },
    },
    failureHints: [
      { code: 'VALIDATION_FAILED', meaning: 'The preview has missing fields, duplicate titles, invalid entry types, ambiguous existing titles, or locked metadata conflicts.', suggestedRepair: 'Revise the preview or select only accepted candidates before requesting approval.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['entryId', 'candidateId', 'projectId'],
      allowedSources: ['candidateId from previous step generate_story_bible_preview', 'existingEntryId read from LorebookEntry rows in context.projectId'],
    },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ValidateStoryBibleInput, context: ToolContext): Promise<ValidateStoryBibleOutput> {
    const candidates = this.getCandidates(args.preview);
    const issues: StoryBibleValidationIssue[] = [];

    if (!args.preview) {
      issues.push({ severity: 'error', message: 'Missing Story Bible preview. Run generate_story_bible_preview first.', suggestion: 'Call generate_story_bible_preview before validate_story_bible.' });
      return this.buildOutput(issues, [], [], []);
    }

    if (!candidates.length) {
      issues.push({ severity: 'error', message: 'Story Bible preview contains no candidates.', suggestion: 'Generate at least one candidate before validation.' });
      return this.buildOutput(issues, [], [], []);
    }

    const duplicateTitleKeys = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.normalizeTitle(this.text(candidate.title, '')))));
    const duplicateCandidateIds = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.text(candidate.candidateId, ''))));
    const titleKeys = [...new Set(candidates.map((candidate) => this.normalizeTitle(this.text(candidate.title, ''))).filter(Boolean))];
    const existingByTitle = await this.loadExistingEntries(context.projectId, titleKeys);
    const projectReferenceIds = await this.loadProjectReferenceIdSet(context.projectId, candidates.flatMap((candidate) => this.stringArray(candidate.relatedEntityIds)));
    const accepted: StoryBibleAcceptedCandidate[] = [];
    const rejected: StoryBibleRejectedCandidate[] = [];
    const writeEntries: ValidateStoryBibleOutput['writePreview']['entries'] = [];

    candidates.forEach((candidate, index) => {
      const candidateIssues: StoryBibleValidationIssue[] = [];
      const candidateId = this.text(candidate.candidateId, `candidate_${index + 1}`);
      const title = this.text(candidate.title, '');
      const titleKey = this.normalizeTitle(title);
      const normalizedType = this.normalizeEntryType(candidate.entryType);
      const entryType = normalizedType || this.text(candidate.entryType, '');
      const matches = titleKey ? existingByTitle.get(titleKey) ?? [] : [];
      const existing = matches.length === 1 ? matches[0] : undefined;
      const relatedEntityIds = this.stringArray(candidate.relatedEntityIds);

      if (!title) candidateIssues.push({ severity: 'error', message: 'Candidate is missing title.', candidateId, path: `candidates[${index}].title` });
      if (!this.text(candidate.candidateId, '')) candidateIssues.push({ severity: 'error', message: 'Candidate is missing candidateId from preview.', title, path: `candidates[${index}].candidateId` });
      if (candidateId && duplicateCandidateIds.has(candidateId)) candidateIssues.push({ severity: 'error', message: `Duplicate candidateId in preview: ${candidateId}.`, candidateId, title, path: `candidates[${index}].candidateId` });
      if (titleKey && duplicateTitleKeys.has(titleKey)) candidateIssues.push({ severity: 'error', message: `Duplicate Story Bible title in preview: ${title}.`, candidateId, title, path: `candidates[${index}].title`, suggestion: 'Merge or rename duplicate candidates before persist.' });
      if (!normalizedType) candidateIssues.push({ severity: 'error', message: `Invalid Story Bible entryType: ${this.text(candidate.entryType, '') || '<missing>'}.`, candidateId, title, path: `candidates[${index}].entryType`, suggestion: `Use one of: ${STORY_BIBLE_TYPE_VALUES.join(', ')}.` });
      if (!this.text(candidate.summary, '')) candidateIssues.push({ severity: 'warning', message: `${title || candidateId} is missing summary.`, candidateId, title, path: `candidates[${index}].summary` });
      if (!this.text(candidate.content, '')) candidateIssues.push({ severity: 'error', message: `${title || candidateId} is missing content.`, candidateId, title, path: `candidates[${index}].content` });
      if (this.hasLockedMetadata(candidate.metadata)) candidateIssues.push({ severity: 'error', message: `${title || candidateId} tries to set locked metadata from a preview.`, candidateId, title, path: `candidates[${index}].metadata`, suggestion: 'Preview candidates must remain planned assets; locking requires a separate explicit workflow.' });
      relatedEntityIds.forEach((id, refIndex) => {
        if (!this.looksLikeUuid(id)) {
          candidateIssues.push({ severity: 'error', message: `${title || candidateId} has a non-UUID relatedEntityIds value: ${id}.`, candidateId, title, path: `candidates[${index}].relatedEntityIds[${refIndex}]`, suggestion: 'Use resolver/context output IDs only; do not invent natural-language IDs.' });
        } else if (!projectReferenceIds.has(id)) {
          candidateIssues.push({ severity: 'error', message: `${title || candidateId} references an ID outside the current project or an unsupported resource: ${id}.`, candidateId, title, path: `candidates[${index}].relatedEntityIds[${refIndex}]`, suggestion: 'Remove the reference or resolve an ID that belongs to the current project.' });
        }
      });

      if (matches.length > 1) {
        candidateIssues.push({ severity: 'error', message: `Multiple existing LorebookEntry rows in this project share title: ${title}.`, candidateId, title, suggestion: 'Resolve duplicate existing Story Bible entries before automated update.' });
      } else if (existing && this.isLockedEntry(existing)) {
        candidateIssues.push({ severity: 'error', message: `Existing LorebookEntry is locked and cannot be overwritten: ${title}.`, candidateId, title, suggestion: 'Create a different title or unlock manually outside this tool.' });
      } else if (existing) {
        candidateIssues.push({ severity: 'warning', message: `Existing LorebookEntry with the same title will be updated after approval: ${title}.`, candidateId, title });
      }

      issues.push(...candidateIssues);
      const errorMessages = candidateIssues.filter((issue) => issue.severity === 'error').map((issue) => issue.message);
      const action: StoryBibleWriteAction = existing ? 'update' : 'create';
      const writeEntry = {
        candidateId,
        title,
        entryType,
        action: errorMessages.length ? 'reject' as const : action,
        existingEntryId: existing?.id ?? null,
        existingStatus: existing?.status ?? null,
        ...(errorMessages.length ? { reason: errorMessages.join('; ') } : {}),
        before: existing ? this.buildBefore(existing) : null,
        after: this.buildAfter(candidate, entryType),
        fieldDiff: existing ? this.buildFieldDiff(existing, candidate, entryType) : this.createFieldDiff(),
        sourceTrace: candidate.sourceTrace,
      };
      writeEntries.push(writeEntry);

      if (errorMessages.length) {
        rejected.push({ candidateId, title, entryType, reason: errorMessages.join('; '), issues: errorMessages });
      } else {
        accepted.push({ candidateId, title, entryType, action, existingEntryId: existing?.id ?? null, sourceTrace: candidate.sourceTrace });
      }
    });

    return this.buildOutput(issues, accepted, rejected, writeEntries);
  }

  private async loadExistingEntries(projectId: string, titleKeys: string[]): Promise<Map<string, ExistingLorebookEntry[]>> {
    const wanted = new Set(titleKeys);
    if (!wanted.size) return new Map();
    const rows = await this.prisma.lorebookEntry.findMany({
      where: { projectId },
      select: { id: true, title: true, entryType: true, summary: true, content: true, tags: true, triggerKeywords: true, relatedEntityIds: true, priority: true, status: true, sourceType: true, metadata: true, updatedAt: true },
    });
    const byTitle = new Map<string, ExistingLorebookEntry[]>();
    rows.forEach((row) => {
      const titleKey = this.normalizeTitle(row.title);
      if (!wanted.has(titleKey)) return;
      const group = byTitle.get(titleKey) ?? [];
      group.push(row);
      byTitle.set(titleKey, group);
    });
    return byTitle;
  }

  private async loadProjectReferenceIdSet(projectId: string, ids: string[]): Promise<Set<string>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Set();
    const [lorebookEntries, characters, chapters, volumes, relationships, timelineEvents] = await Promise.all([
      this.prisma.lorebookEntry.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      this.prisma.character.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      this.prisma.chapter.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      this.prisma.volume.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      this.prisma.relationshipEdge.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      this.prisma.timelineEvent.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
    ]);
    return new Set([...lorebookEntries, ...characters, ...chapters, ...volumes, ...relationships, ...timelineEvents].map((item) => item.id));
  }

  private buildOutput(issues: StoryBibleValidationIssue[], accepted: StoryBibleAcceptedCandidate[], rejected: StoryBibleRejectedCandidate[], entries: ValidateStoryBibleOutput['writePreview']['entries']): ValidateStoryBibleOutput {
    return {
      valid: accepted.length > 0 && rejected.length === 0 && !issues.some((issue) => issue.severity === 'error'),
      issueCount: issues.length,
      issues,
      accepted,
      rejected,
      writePreview: {
        target: 'LorebookEntry',
        projectScope: 'context.projectId',
        sourceKind: 'planned_story_bible_asset',
        summary: {
          createCount: accepted.filter((item) => item.action === 'create').length,
          updateCount: accepted.filter((item) => item.action === 'update').length,
          rejectCount: rejected.length,
        },
        entries,
        approvalMessage: 'Persist requires explicit user approval in act mode. Only accepted candidates are eligible, and persist_story_bible will revalidate against context.projectId before writing.',
      },
    };
  }

  private buildBefore(entry: ExistingLorebookEntry): Record<string, unknown> {
    return {
      id: entry.id,
      title: entry.title,
      entryType: entry.entryType,
      summary: entry.summary,
      contentExcerpt: this.compactText(entry.content, 500),
      tags: entry.tags,
      triggerKeywords: entry.triggerKeywords,
      relatedEntityIds: entry.relatedEntityIds,
      priority: entry.priority,
      status: entry.status,
      sourceType: entry.sourceType,
      locked: this.isLockedEntry(entry),
      updatedAt: entry.updatedAt.toISOString(),
    };
  }

  private buildAfter(candidate: StoryBiblePreviewCandidate, entryType: string): Record<string, unknown> {
    return {
      title: this.text(candidate.title, ''),
      entryType,
      summary: this.text(candidate.summary, ''),
      contentExcerpt: this.compactText(this.text(candidate.content, ''), 500),
      tags: this.stringArray(candidate.tags),
      triggerKeywords: this.stringArray(candidate.triggerKeywords),
      relatedEntityIds: this.stringArray(candidate.relatedEntityIds),
      priority: this.priority(candidate.priority),
      metadata: { sourceKind: 'planned_story_bible_asset', sourceTrace: candidate.sourceTrace },
    };
  }

  private buildFieldDiff(existing: ExistingLorebookEntry, candidate: StoryBiblePreviewCandidate, entryType: string): Record<string, boolean> {
    return {
      entryType: existing.entryType !== entryType,
      summary: (existing.summary ?? '') !== this.text(candidate.summary, ''),
      content: existing.content !== this.text(candidate.content, ''),
      tags: JSON.stringify(existing.tags ?? []) !== JSON.stringify(this.stringArray(candidate.tags)),
      triggerKeywords: JSON.stringify(existing.triggerKeywords ?? []) !== JSON.stringify(this.stringArray(candidate.triggerKeywords)),
      relatedEntityIds: JSON.stringify(existing.relatedEntityIds ?? []) !== JSON.stringify(this.stringArray(candidate.relatedEntityIds)),
      priority: existing.priority !== this.priority(candidate.priority),
    };
  }

  private createFieldDiff(): Record<string, boolean> {
    return { entryType: true, summary: true, content: true, tags: true, triggerKeywords: true, relatedEntityIds: true, priority: true };
  }

  private getCandidates(preview?: StoryBiblePreviewOutput): StoryBiblePreviewCandidate[] {
    if (!preview) return [];
    const raw = Array.isArray(preview.candidates)
      ? preview.candidates
      : Array.isArray((preview as unknown as { entries?: unknown[] }).entries)
        ? (preview as unknown as { entries: unknown[] }).entries
        : [];
    return raw.filter((item): item is StoryBiblePreviewCandidate => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
  }

  private normalizeEntryType(value: unknown): string {
    const text = this.text(value, '');
    if (!text) return '';
    const normalized = normalizeLorebookEntryType(text);
    return STORY_BIBLE_TYPE_SET.has(normalized) ? normalized : '';
  }

  private hasLockedMetadata(metadata: unknown): boolean {
    const record = this.asRecord(metadata);
    if (!record) return false;
    return record.locked === true || record.isLocked === true || this.text(record.lockState, '') === 'locked' || this.text(record.status, '') === 'locked';
  }

  private isLockedEntry(entry: ExistingLorebookEntry): boolean {
    return entry.status === 'locked' || this.hasLockedMetadata(entry.metadata);
  }

  private findDuplicateStrings(values: string[]): string[] {
    const seen = new Set<string>();
    const duplicated = new Set<string>();
    values.filter(Boolean).forEach((value) => {
      if (seen.has(value)) duplicated.add(value);
      seen.add(value);
    });
    return [...duplicated].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  private normalizeTitle(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  }

  private priority(value: unknown): number {
    return Math.min(100, Math.max(0, Number(value) || 50));
  }

  private compactText(value: string, maxLength: number): string {
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return fallback;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [];
  }

  private looksLikeUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
