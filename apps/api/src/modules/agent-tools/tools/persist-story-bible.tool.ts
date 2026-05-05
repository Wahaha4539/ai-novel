import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { normalizeLorebookEntryType, STORY_BIBLE_ENTRY_TYPES } from '../../lorebook/lorebook-entry-types';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import type { StoryBiblePreviewCandidate, StoryBiblePreviewOutput } from './generate-story-bible-preview.tool';
import type { ValidateStoryBibleOutput } from './validate-story-bible.tool';

interface PersistStoryBibleInput {
  preview?: StoryBiblePreviewOutput;
  validation?: ValidateStoryBibleOutput;
  selectedCandidateIds?: string[];
  selectedTitles?: string[];
}

export interface PersistStoryBibleOutput {
  createdCount: number;
  updatedCount: number;
  skippedUnselectedCount: number;
  createdEntries: Array<{ id: string; title: string; entryType: string }>;
  updatedEntries: Array<{ id: string; title: string; entryType: string }>;
  skippedUnselectedCandidates: Array<{ candidateId: string; title: string }>;
  perEntryAudit: Array<{
    candidateId: string;
    title: string;
    entryType: string;
    selected: boolean;
    action: 'created' | 'updated' | 'skipped_unselected';
    existingEntryId: string | null;
    reason: string;
    sourceStep: 'persist_story_bible';
  }>;
  approval: { required: true; approved: boolean; mode: string };
  persistedAt: string;
  approvalMessage: string;
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
}

interface PersistDecision {
  candidate: StoryBiblePreviewCandidate;
  entryType: string;
  action: 'create' | 'update';
  existing: ExistingLorebookEntry | null;
}

const STORY_BIBLE_TYPE_VALUES = [...STORY_BIBLE_ENTRY_TYPES];
const STORY_BIBLE_TYPE_SET = new Set<string>(STORY_BIBLE_TYPE_VALUES);

@Injectable()
export class PersistStoryBibleTool implements BaseTool<PersistStoryBibleInput, PersistStoryBibleOutput> {
  name = 'persist_story_bible';
  description = 'Persist approved Story Bible preview candidates into LorebookEntry rows for the current project.';
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
    required: ['createdCount', 'updatedCount', 'skippedUnselectedCount', 'createdEntries', 'updatedEntries', 'skippedUnselectedCandidates', 'perEntryAudit', 'approval', 'persistedAt', 'approvalMessage'],
    properties: {
      createdCount: { type: 'number' as const, minimum: 0 },
      updatedCount: { type: 'number' as const, minimum: 0 },
      skippedUnselectedCount: { type: 'number' as const, minimum: 0 },
      createdEntries: { type: 'array' as const },
      updatedEntries: { type: 'array' as const },
      skippedUnselectedCandidates: { type: 'array' as const },
      perEntryAudit: { type: 'array' as const },
      approval: { type: 'object' as const },
      persistedAt: { type: 'string' as const },
      approvalMessage: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'medium' = 'medium';
  requiresApproval = true;
  sideEffects = ['create_lorebook_entries', 'update_lorebook_entries', 'fact_layer_story_bible_write'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Persist Story Bible',
    description: 'After user approval, creates or updates LorebookEntry rows from validate_story_bible accepted candidates. It revalidates inside act mode and writes only to context.projectId.',
    whenToUse: [
      'validate_story_bible has produced accepted candidates and the user approved writing them.',
      'The selected Story Bible preview candidates should become LorebookEntry records.',
      'An existing same-title LorebookEntry is not locked and should be updated with the approved planned asset.',
    ],
    whenNotToUse: [
      'The run is in plan mode or lacks explicit user approval.',
      'There is no generate_story_bible_preview and validate_story_bible output.',
      'The user supplies natural-language entry IDs or candidate IDs that are not present in the preview.',
      'The matching existing LorebookEntry is locked by status or metadata.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      preview: { source: 'previous_step', description: 'Output from generate_story_bible_preview. Required because it contains the write payload.' },
      validation: { source: 'previous_step', description: 'Output from validate_story_bible. Accepted/rejected lists are used to constrain default selection.' },
      selectedCandidateIds: { source: 'previous_step', description: 'Candidate IDs copied from the previous preview or selected artifact. Unknown IDs are rejected.' },
      selectedTitles: { source: 'previous_step', description: 'Candidate titles copied from the previous preview or selected artifact. Unknown titles are rejected.' },
    },
    preconditions: [
      'context.mode must be act',
      'context.approved must be true',
      'preview.writePlan.requiresApprovalBeforePersist must be true',
      'selectedCandidateIds and selectedTitles must refer to candidates in the preview',
    ],
    postconditions: [
      'Creates new LorebookEntry rows only under context.projectId',
      'Updates only same-project, same-title LorebookEntry rows that are not locked',
      'Invalidates project recall cache when any row is created or updated',
    ],
    failureHints: [
      { code: 'APPROVAL_REQUIRED', meaning: 'persist_story_bible is a write tool and must run only after approval in act mode.', suggestedRepair: 'Ask for user approval and re-run in act mode.' },
      { code: 'UNKNOWN_SELECTION', meaning: 'A selected candidateId or title is not present in the preview.', suggestedRepair: 'Use candidateId or title from generate_story_bible_preview output or the selected artifact.' },
      { code: 'VALIDATION_FAILED', meaning: 'The selected candidates no longer pass the write-time DB validation.', suggestedRepair: 'Run validate_story_bible again and resolve rejected candidates.' },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['entryId', 'candidateId', 'projectId'],
      allowedSources: [
        'projectId from ToolContext only',
        'candidateId from previous step generate_story_bible_preview output',
        'selectedCandidateIds or selectedTitles copied from a previous step or selected artifact',
        'existing entry IDs read by this tool from LorebookEntry rows in context.projectId',
      ],
    },
  };

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  async run(args: PersistStoryBibleInput, context: ToolContext): Promise<PersistStoryBibleOutput> {
    this.assertExecutableInput(args, context);
    const candidates = this.getCandidates(args.preview);
    const selected = this.selectCandidates(args, candidates);
    this.assertSelectedCandidatesAllowedByValidation(args.validation, selected, context);

    const selectedIds = new Set(selected.map((candidate) => this.text(candidate.candidateId, '')));
    const skippedUnselectedCandidates = candidates
      .filter((candidate) => !selectedIds.has(this.text(candidate.candidateId, '')))
      .map((candidate) => ({ candidateId: this.text(candidate.candidateId, ''), title: this.text(candidate.title, '') }));
    const persistedAt = new Date().toISOString();

    const result = await this.prisma.$transaction(async (tx) => {
      const decisions = await this.buildPersistDecisions(tx, selected, context.projectId);
      const createdEntries: PersistStoryBibleOutput['createdEntries'] = [];
      const updatedEntries: PersistStoryBibleOutput['updatedEntries'] = [];
      const perEntryAudit: PersistStoryBibleOutput['perEntryAudit'] = [];

      for (const decision of decisions) {
        if (decision.action === 'create') {
          const created = await tx.lorebookEntry.create({
            data: {
              projectId: context.projectId,
              title: this.text(decision.candidate.title, ''),
              entryType: decision.entryType,
              content: this.text(decision.candidate.content, ''),
              summary: this.text(decision.candidate.summary, ''),
              tags: this.toJsonValue(this.stringArray(decision.candidate.tags)),
              triggerKeywords: this.toJsonValue(this.triggerKeywords(decision.candidate)),
              relatedEntityIds: this.toJsonValue(this.stringArray(decision.candidate.relatedEntityIds)),
              priority: this.priority(decision.candidate.priority),
              sourceType: 'agent_story_bible',
              metadata: this.buildMetadata(decision.candidate, context, persistedAt),
            },
            select: { id: true, title: true, entryType: true },
          });
          createdEntries.push(created);
          perEntryAudit.push({ candidateId: this.text(decision.candidate.candidateId, ''), title: created.title, entryType: created.entryType, selected: true, action: 'created', existingEntryId: null, reason: 'Approved Story Bible candidate created as LorebookEntry.', sourceStep: 'persist_story_bible' });
        } else if (decision.existing) {
          const updated = await tx.lorebookEntry.update({
            where: { id: decision.existing.id },
            data: {
              entryType: decision.entryType,
              content: this.text(decision.candidate.content, ''),
              summary: this.text(decision.candidate.summary, ''),
              tags: this.toJsonValue(this.stringArray(decision.candidate.tags)),
              triggerKeywords: this.toJsonValue(this.triggerKeywords(decision.candidate)),
              relatedEntityIds: this.toJsonValue(this.stringArray(decision.candidate.relatedEntityIds)),
              priority: this.priority(decision.candidate.priority),
              sourceType: 'agent_story_bible',
              metadata: this.buildMetadata(decision.candidate, context, persistedAt, decision.existing.metadata),
            },
            select: { id: true, title: true, entryType: true },
          });
          updatedEntries.push(updated);
          perEntryAudit.push({ candidateId: this.text(decision.candidate.candidateId, ''), title: updated.title, entryType: updated.entryType, selected: true, action: 'updated', existingEntryId: updated.id, reason: 'Approved Story Bible candidate updated the same-project, same-title LorebookEntry.', sourceStep: 'persist_story_bible' });
        }
      }

      skippedUnselectedCandidates.forEach((candidate) => {
        const source = candidates.find((item) => this.text(item.candidateId, '') === candidate.candidateId);
        perEntryAudit.push({
          candidateId: candidate.candidateId,
          title: candidate.title,
          entryType: this.normalizeEntryType(this.text(source?.entryType, 'setting')) || 'setting',
          selected: false,
          action: 'skipped_unselected',
          existingEntryId: null,
          reason: 'Candidate was not selected for this approved persist step.',
          sourceStep: 'persist_story_bible',
        });
      });

      return {
        createdCount: createdEntries.length,
        updatedCount: updatedEntries.length,
        skippedUnselectedCount: skippedUnselectedCandidates.length,
        createdEntries,
        updatedEntries,
        skippedUnselectedCandidates,
        perEntryAudit,
        approval: { required: true as const, approved: context.approved, mode: context.mode },
        persistedAt,
        approvalMessage: 'Story Bible candidates were persisted only after approval, under context.projectId, with write-time validation and locked-entry protection.',
      };
    });

    if (result.createdCount + result.updatedCount > 0) {
      await this.cacheService.deleteProjectRecallResults(context.projectId);
    }

    return result;
  }

  private assertExecutableInput(args: PersistStoryBibleInput, context: ToolContext) {
    if (context.mode !== 'act') throw new BadRequestException('persist_story_bible can only run in Agent act mode.');
    if (!context.approved) throw new BadRequestException('persist_story_bible requires explicit user approval.');
    if (!args.preview) throw new BadRequestException('persist_story_bible requires generate_story_bible_preview output.');
    if (!args.validation) throw new BadRequestException('persist_story_bible requires validate_story_bible output.');
    if (args.validation.valid !== true) throw new BadRequestException('validate_story_bible did not pass; persist_story_bible will not write.');
    if (args.preview.writePlan?.requiresApprovalBeforePersist !== true) throw new BadRequestException('Story Bible preview did not declare approval-before-persist.');
    if (args.preview.writePlan?.sourceKind !== 'planned_story_bible_asset') throw new BadRequestException('Story Bible preview sourceKind must be planned_story_bible_asset.');
    if (!this.getCandidates(args.preview).length) throw new BadRequestException('persist_story_bible requires at least one preview candidate.');
  }

  private selectCandidates(args: PersistStoryBibleInput, candidates: StoryBiblePreviewCandidate[]): StoryBiblePreviewCandidate[] {
    const selectedCandidateIds = this.stringArray(args.selectedCandidateIds);
    const selectedTitles = this.stringArray(args.selectedTitles);
    const candidateIdSet = new Set(candidates.map((candidate) => this.text(candidate.candidateId, '')).filter(Boolean));
    const titleSet = new Set(candidates.map((candidate) => this.text(candidate.title, '')).filter(Boolean));

    const unknownIds = selectedCandidateIds.filter((candidateId) => !candidateIdSet.has(candidateId));
    if (unknownIds.length) throw new BadRequestException(`Unknown Story Bible candidateId selection: ${unknownIds.join(', ')}`);

    const unknownTitles = selectedTitles.filter((title) => !titleSet.has(title));
    if (unknownTitles.length) throw new BadRequestException(`Unknown Story Bible title selection: ${unknownTitles.join(', ')}`);

    let selected: StoryBiblePreviewCandidate[];
    if (selectedCandidateIds.length) {
      const selectedSet = new Set(selectedCandidateIds);
      selected = candidates.filter((candidate) => selectedSet.has(this.text(candidate.candidateId, '')));
    } else if (selectedTitles.length) {
      const selectedSet = new Set(selectedTitles);
      selected = candidates.filter((candidate) => selectedSet.has(this.text(candidate.title, '')));
    } else {
      const acceptedIds = new Set(this.stringArray(args.validation?.accepted?.map((item) => item.candidateId)));
      const acceptedTitles = new Set(this.stringArray(args.validation?.accepted?.map((item) => item.title)));
      const unknownAcceptedIds = [...acceptedIds].filter((candidateId) => !candidateIdSet.has(candidateId));
      const unknownAcceptedTitles = [...acceptedTitles].filter((title) => !titleSet.has(title));
      if (unknownAcceptedIds.length || unknownAcceptedTitles.length) {
        throw new BadRequestException(`validate_story_bible output does not match preview candidates: ${[...unknownAcceptedIds, ...unknownAcceptedTitles].join(', ')}`);
      }
      selected = acceptedIds.size || acceptedTitles.size
        ? candidates.filter((candidate) => acceptedIds.has(this.text(candidate.candidateId, '')) || acceptedTitles.has(this.text(candidate.title, '')))
        : candidates;
    }

    if (!selected.length) throw new BadRequestException('No Story Bible candidates selected for persist.');
    return selected;
  }

  private assertSelectedCandidatesAllowedByValidation(validation: ValidateStoryBibleOutput | undefined, selected: StoryBiblePreviewCandidate[], context: ToolContext) {
    if (!validation) return;
    const acceptedById = new Map<string, Record<string, unknown>>();
    this.arrayOfRecords(validation.accepted).forEach((item) => {
      const candidateId = this.text(item.candidateId, '');
      if (candidateId) acceptedById.set(candidateId, item);
    });
    const writeEntries = this.arrayOfRecords(validation.writePreview?.entries)
      .filter((entry) => this.text(entry.action, '') === 'create' || this.text(entry.action, '') === 'update');
    const writeEntryById = new Map<string, Record<string, unknown>>();
    writeEntries.forEach((entry) => {
      const candidateId = this.text(entry.candidateId, '');
      if (candidateId) writeEntryById.set(candidateId, entry);
    });
    const rejectedIds = new Set(this.stringArray(validation.rejected?.map((item) => item.candidateId)));
    const rejectedTitles = new Set(this.stringArray(validation.rejected?.map((item) => item.title)));
    const rejectedSelection = selected.filter((candidate) => rejectedIds.has(this.text(candidate.candidateId, '')) || rejectedTitles.has(this.text(candidate.title, '')));
    if (rejectedSelection.length) {
      throw new BadRequestException(`Selected Story Bible candidates were rejected by validate_story_bible: ${rejectedSelection.map((candidate) => this.text(candidate.title, this.text(candidate.candidateId, 'unknown'))).join(', ')}`);
    }

    const errors: string[] = [];
    selected.forEach((candidate) => {
      const candidateId = this.text(candidate.candidateId, '');
      const title = this.text(candidate.title, '');
      const entryType = this.normalizeEntryType(candidate.entryType);
      const accepted = acceptedById.get(candidateId);
      const writeEntry = writeEntryById.get(candidateId);
      const sourceTrace = this.asRecord(candidate.sourceTrace);

      if (!accepted) {
        errors.push(`${title || candidateId || '<unknown>'} was not accepted by validate_story_bible`);
        return;
      }
      if (!writeEntry) errors.push(`${title || candidateId} is missing an approved validate_story_bible writePreview entry`);
      if (this.normalizeTitle(this.text(accepted.title, '')) !== this.normalizeTitle(title)) errors.push(`${candidateId} title does not match validate_story_bible accepted output`);
      if (this.normalizeEntryType(accepted.entryType) !== entryType) errors.push(`${candidateId} entryType does not match validate_story_bible accepted output`);
      if (this.text(sourceTrace?.sourceKind, '') !== 'planned_story_bible_asset' || this.text(sourceTrace?.originTool, '') !== 'generate_story_bible_preview' || this.text(sourceTrace?.agentRunId, '') !== context.agentRunId) {
        errors.push(`${title || candidateId} sourceTrace is not from generate_story_bible_preview in the current agent run`);
      }
      if (!this.sameSourceTrace(sourceTrace, this.asRecord(accepted.sourceTrace))) errors.push(`${candidateId} sourceTrace does not match validate_story_bible accepted output`);
      if (writeEntry) {
        if (this.normalizeTitle(this.text(writeEntry.title, '')) !== this.normalizeTitle(title)) errors.push(`${candidateId} title does not match validate_story_bible writePreview`);
        if (this.normalizeEntryType(writeEntry.entryType) !== entryType) errors.push(`${candidateId} entryType does not match validate_story_bible writePreview`);
        if (!this.sameSourceTrace(sourceTrace, this.asRecord(writeEntry.sourceTrace))) errors.push(`${candidateId} sourceTrace does not match validate_story_bible writePreview`);
      }
    });

    if (errors.length) throw new BadRequestException(`validate_story_bible output does not approve selected candidates: ${[...new Set(errors)].join('; ')}`);
  }

  private async buildPersistDecisions(tx: Prisma.TransactionClient, candidates: StoryBiblePreviewCandidate[], projectId: string): Promise<PersistDecision[]> {
    const errors: string[] = [];
    const duplicateTitleKeys = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.normalizeTitle(this.text(candidate.title, '')))));
    const duplicateCandidateIds = new Set(this.findDuplicateStrings(candidates.map((candidate) => this.text(candidate.candidateId, ''))));
    const titleKeys = [...new Set(candidates.map((candidate) => this.normalizeTitle(this.text(candidate.title, ''))).filter(Boolean))];
    const projectReferenceIds = await this.loadProjectReferenceIdSet(tx, projectId, candidates.flatMap((candidate) => this.stringArray(candidate.relatedEntityIds)));
    const existingByTitle = await this.loadExistingEntries(tx, projectId, titleKeys);

    const decisions: PersistDecision[] = [];
    candidates.forEach((candidate) => {
      const candidateId = this.text(candidate.candidateId, '');
      const title = this.text(candidate.title, '');
      const titleKey = this.normalizeTitle(title);
      const entryType = this.normalizeEntryType(candidate.entryType);
      const matches = titleKey ? existingByTitle.get(titleKey) ?? [] : [];
      const existing = matches.length === 1 ? matches[0] : null;
      const relatedEntityIds = this.stringArray(candidate.relatedEntityIds);

      if (!candidateId) errors.push(`Candidate missing candidateId: ${title || '<untitled>'}`);
      if (candidateId && duplicateCandidateIds.has(candidateId)) errors.push(`Duplicate candidateId selected: ${candidateId}`);
      if (!title) errors.push(`Candidate missing title: ${candidateId || '<unknown>'}`);
      if (titleKey && duplicateTitleKeys.has(titleKey)) errors.push(`Duplicate selected title: ${title}`);
      if (!entryType) errors.push(`Invalid Story Bible entryType for ${title || candidateId}: ${this.text(candidate.entryType, '<missing>')}`);
      if (!this.text(candidate.content, '')) errors.push(`Candidate missing content: ${title || candidateId}`);
      if (this.hasLockedMetadata(candidate.metadata)) errors.push(`Candidate tries to set locked metadata: ${title || candidateId}`);
      relatedEntityIds.forEach((id) => {
        if (!this.looksLikeUuid(id)) errors.push(`Candidate has a non-UUID relatedEntityIds value: ${title || candidateId} -> ${id}`);
        else if (!projectReferenceIds.has(id)) errors.push(`Candidate references an ID outside the current project or unsupported resource: ${title || candidateId} -> ${id}`);
      });
      if (matches.length > 1) errors.push(`Ambiguous existing LorebookEntry title in project: ${title}`);
      if (existing && this.isLockedEntry(existing)) errors.push(`Existing LorebookEntry is locked and cannot be updated: ${title}`);

      if (entryType && title && candidateId && matches.length <= 1 && !(existing && this.isLockedEntry(existing)) && !duplicateTitleKeys.has(titleKey) && !duplicateCandidateIds.has(candidateId) && this.text(candidate.content, '') && !this.hasLockedMetadata(candidate.metadata)) {
        decisions.push({ candidate, entryType, action: existing ? 'update' : 'create', existing });
      }
    });

    if (errors.length) throw new BadRequestException(`Story Bible write-time validation failed: ${[...new Set(errors)].join('; ')}`);
    return decisions;
  }

  private async loadProjectReferenceIdSet(tx: Prisma.TransactionClient, projectId: string, ids: string[]): Promise<Set<string>> {
    const uuidIds = [...new Set(ids.filter((id) => this.looksLikeUuid(id)))];
    if (!uuidIds.length) return new Set();
    const [lorebookEntries, characters, chapters, volumes, relationships, timelineEvents] = await Promise.all([
      tx.lorebookEntry.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      tx.character.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      tx.chapter.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      tx.volume.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      tx.relationshipEdge.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
      tx.timelineEvent.findMany({ where: { projectId, id: { in: uuidIds } }, select: { id: true } }),
    ]);
    return new Set([...lorebookEntries, ...characters, ...chapters, ...volumes, ...relationships, ...timelineEvents].map((item) => item.id));
  }

  private async loadExistingEntries(tx: Prisma.TransactionClient, projectId: string, titleKeys: string[]): Promise<Map<string, ExistingLorebookEntry[]>> {
    const wanted = new Set(titleKeys);
    if (!wanted.size) return new Map();
    const rows = await tx.lorebookEntry.findMany({
      where: { projectId },
      select: { id: true, title: true, entryType: true, summary: true, content: true, tags: true, triggerKeywords: true, relatedEntityIds: true, priority: true, status: true, sourceType: true, metadata: true },
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

  private buildMetadata(candidate: StoryBiblePreviewCandidate, context: ToolContext, persistedAt: string, existingMetadata?: unknown): Prisma.InputJsonValue {
    const base = this.asRecord(existingMetadata) ?? {};
    const candidateMetadata = this.safeCandidateMetadata(candidate.metadata);
    return this.toJsonValue({
      ...base,
      ...candidateMetadata,
      sourceKind: 'planned_story_bible_asset',
      sourceType: 'agent_story_bible',
      sourceTool: 'persist_story_bible',
      sourceTrace: candidate.sourceTrace,
      storyBibleCandidateId: this.text(candidate.candidateId, ''),
      agentRunId: context.agentRunId,
      persistedAt,
    });
  }

  private safeCandidateMetadata(metadata: unknown): Record<string, unknown> {
    const record = { ...(this.asRecord(metadata) ?? {}) };
    delete record.locked;
    delete record.isLocked;
    delete record.lockState;
    delete record.status;
    return record;
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

  private triggerKeywords(candidate: StoryBiblePreviewCandidate): string[] {
    const explicit = this.stringArray(candidate.triggerKeywords);
    if (explicit.length) return explicit;
    return [...new Set([this.text(candidate.title, ''), ...this.stringArray(candidate.tags)].filter(Boolean))];
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

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  }

  private arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : [];
  }

  private sameSourceTrace(left?: Record<string, unknown>, right?: Record<string, unknown>): boolean {
    if (!left || !right) return false;
    return this.text(left.sourceKind, '') === this.text(right.sourceKind, '')
      && this.text(left.originTool, '') === this.text(right.originTool, '')
      && this.text(left.agentRunId, '') === this.text(right.agentRunId, '')
      && Number(left.candidateIndex) === Number(right.candidateIndex);
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

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}
