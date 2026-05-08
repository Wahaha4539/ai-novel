import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { recordToolLlmUsage } from './import-preview-llm-usage';
import {
  assertNoTimelineDuplicateConflicts,
  normalizeTimelinePreviewFromLlmCall,
  validateTimelineCandidateChapterRefs,
} from './timeline-preview.support';
import type { ExistingTimelineEventRef, TimelineChapterRefRow } from './timeline-preview.support';
import type { AlignChapterTimelinePreviewInput, GenerateTimelinePreviewOutput, TimelineCandidate, TimelineCandidateAction } from './timeline-preview.types';

const ALIGN_TIMELINE_SOURCE_KIND = 'chapter_timeline_alignment' as const;
const ALIGN_TIMELINE_ORIGIN_TOOL = 'align_chapter_timeline_preview' as const;
const ALIGN_TIMELINE_SOURCE_TYPE = 'agent_timeline_alignment' as const;
const ALIGN_TIMELINE_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const ALIGN_TIMELINE_MAX_CANDIDATES = 20;
const ALIGN_TIMELINE_ACTIONS = new Set<TimelineCandidateAction>(['confirm_planned', 'update_event', 'archive_event', 'create_discovered']);

interface ChapterRefRow extends TimelineChapterRefRow {
  title?: string | null;
}

interface StoryEventRow {
  id: string;
  projectId: string;
  chapterId: string;
  chapterNo: number | null;
  sourceDraftId?: string | null;
  title: string;
  eventType: string;
  description: string;
  participants: unknown;
  timelineSeq?: number | null;
  status: string;
  metadata: unknown;
  updatedAt?: Date | string | null;
}

type TimelineEventRow = ExistingTimelineEventRef & {
  locationName?: string | null;
  participants?: unknown;
  cause?: string | null;
  result?: string | null;
  impactScope?: string | null;
  isPublic?: boolean;
  knownBy?: unknown;
  unknownBy?: unknown;
  eventStatus: string;
  sourceType: string;
  metadata?: unknown;
  updatedAt?: Date | string | null;
};

@Injectable()
export class AlignChapterTimelinePreviewTool implements BaseTool<AlignChapterTimelinePreviewInput, GenerateTimelinePreviewOutput> {
  name = ALIGN_TIMELINE_ORIGIN_TOOL;
  description = 'Align current chapter StoryEvent evidence with planned/active TimelineEvent rows and return read-only TimelineEvent candidates.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      chapterId: { type: 'string' as const },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
      draftId: { type: 'string' as const },
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      maxCandidates: { type: 'number' as const, minimum: 1, maximum: ALIGN_TIMELINE_MAX_CANDIDATES, integer: true },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['candidates', 'assumptions', 'risks', 'writePlan'],
    additionalProperties: false,
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
  executionTimeoutMs = ALIGN_TIMELINE_LLM_TIMEOUT_MS + 60_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Align Chapter Timeline Preview',
    description: 'Read current chapter StoryEvent evidence and planned/active TimelineEvent rows, then propose timeline confirmation/update/archive/discovery candidates without writing business tables.',
    whenToUse: [
      'After chapter generation or polishing has extracted StoryEvent rows for the current chapter.',
      'When planned TimelineEvent rows need to be confirmed, corrected, archived, or supplemented from chapter evidence.',
      'Before validate_timeline_preview and any approved persist_timeline_events step.',
    ],
    whenNotToUse: [
      'Before StoryEvent extraction has completed for the chapter.',
      'For outline or craftBrief timeline planning; use generate_timeline_preview for planned timeline candidates.',
      'When the user asks to write TimelineEvent rows immediately; validation and approved persist must run later.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterId: { source: 'resolver', description: 'Current chapterId from resolve_chapter or ToolContext. Do not invent it.' },
      chapterNo: { source: 'resolver', description: 'Current chapter number from resolver or DB lookup.' },
      draftId: { source: 'previous_step', description: 'Optional draftId from the generated chapter draft; filters StoryEvent evidence to that draft.' },
      context: { source: 'previous_step', description: 'Optional surrounding generation or fact extraction context for audit only.' },
      instruction: { source: 'user_message', description: 'User constraints for alignment.' },
      maxCandidates: { source: 'literal', description: 'Maximum candidate count. Defaults to 8 and never exceeds 20.' },
    },
    examples: [
      {
        user: 'Align chapter 7 extracted events with the planned timeline.',
        plan: [
          { tool: 'resolve_chapter', args: { chapterRef: 'chapter 7' } },
          { tool: 'align_chapter_timeline_preview', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', chapterNo: 7, draftId: '{{context.latestDraftId}}', instruction: '{{user_message}}' } },
          { tool: 'validate_timeline_preview', args: { preview: '{{steps.align_chapter_timeline_preview.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'timelineEventId', 'storyEventId'],
      allowedSources: ['projectId from ToolContext only', 'chapterId/chapterNo from resolver or DB lookup', 'storyEventId/timelineEventId from current-project DB reads only', 'candidateId is a preview-local ID only'],
    },
  };

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly prisma: PrismaService,
  ) {}

  async run(args: AlignChapterTimelinePreviewInput, context: ToolContext): Promise<GenerateTimelinePreviewOutput> {
    const maxCandidates = this.readMaxCandidates(args.maxCandidates);
    const chapter = await this.resolveChapter(args, context);
    const storyEvents = await this.loadStoryEvents(context.projectId, chapter, args.draftId);
    if (!storyEvents.length) {
      throw new Error('align_chapter_timeline_preview requires current chapter StoryEvent evidence; run fact extraction before timeline alignment.');
    }
    const timelineEvents = await this.loadCurrentTimelineEvents(context.projectId, chapter);

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: 'Aligning chapter story events with timeline events',
      progressCurrent: 0,
      progressTotal: maxCandidates,
      timeoutMs: ALIGN_TIMELINE_LLM_TIMEOUT_MS,
    });

    const preview = await normalizeTimelinePreviewFromLlmCall(
      () => this.callAlignmentLlm(args, context, chapter, storyEvents, timelineEvents, maxCandidates),
      {
        expectedProjectId: context.projectId,
        expectedSourceKind: ALIGN_TIMELINE_SOURCE_KIND,
        expectedOriginTool: ALIGN_TIMELINE_ORIGIN_TOOL,
        sourceKind: ALIGN_TIMELINE_SOURCE_KIND,
        allowedActions: ['confirm_planned', 'update_event', 'archive_event', 'create_discovered'],
        minCandidates: 1,
        maxCandidates,
      },
    );
    this.assertAlignmentCandidates(preview, context, chapter, storyEvents, timelineEvents);
    validateTimelineCandidateChapterRefs(preview.candidates, [chapter], context.projectId);
    assertNoTimelineDuplicateConflicts(preview.candidates, timelineEvents, { expectedProjectId: context.projectId });

    return preview;
  }

  private async callAlignmentLlm(
    args: AlignChapterTimelinePreviewInput,
    context: ToolContext,
    chapter: ChapterRefRow,
    storyEvents: StoryEventRow[],
    timelineEvents: TimelineEventRow[],
    maxCandidates: number,
  ): Promise<{ data: unknown }> {
    const response = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            'You are the AI Novel chapter timeline alignment agent. Return JSON only, no Markdown.',
            'Use StoryEvent rows as chapter evidence and existing planned/active TimelineEvent rows as the current timeline layer.',
            'Return TimelineEvent preview candidates only. Never write to the database and never silently fill missing facts.',
            'Allowed actions are confirm_planned, update_event, archive_event, and create_discovered.',
            'confirm_planned/update_event/archive_event candidates must include existingTimelineEventId from supplied current TimelineEvent rows.',
            'create_discovered candidates must not include existingTimelineEventId and must describe a chapter fact evidenced by StoryEvent rows.',
            'Every candidate must include candidateId, action, chapterId/chapterNo, title, eventTime, participants, cause, result, impactScope, isPublic, knownBy, unknownBy, eventStatus, sourceType="agent_timeline_alignment", impactAnalysis, conflictRisk, and sourceTrace.',
            `Every sourceTrace must include sourceKind="${ALIGN_TIMELINE_SOURCE_KIND}", projectId="${context.projectId}", originTool="${ALIGN_TIMELINE_ORIGIN_TOOL}", agentRunId="${context.agentRunId}", toolName="${ALIGN_TIMELINE_ORIGIN_TOOL}", candidateId, candidateAction, chapterId="${chapter.id}", chapterNo=${chapter.chapterNo}, contextSources, evidence, and generatedAt.`,
            'contextSources must cite at least one story_event sourceId. Candidates targeting an existing timeline event must also cite that timeline_event sourceId.',
            'If evidence is insufficient, return fewer or incomplete candidates rather than fabricating content; the tool will fail and ask the caller to retry with better context.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Instruction: ${args.instruction ?? ''}`,
            `ProjectId: ${context.projectId}`,
            `AgentRunId: ${context.agentRunId}`,
            `Chapter: ${JSON.stringify(chapter)}`,
            `DraftId: ${args.draftId ?? ''}`,
            `Max candidates: ${maxCandidates}`,
            `StoryEvent evidence:\n${JSON.stringify(this.storyEventsForPrompt(storyEvents), null, 2)}`,
            `Current planned/active TimelineEvent rows:\n${JSON.stringify(this.timelineEventsForPrompt(timelineEvents), null, 2)}`,
            `Additional context:\n${JSON.stringify(args.context ?? {}, null, 2).slice(0, 12000)}`,
          ].join('\n\n'),
        },
      ],
      {
        appStep: ALIGN_TIMELINE_ORIGIN_TOOL,
        maxTokens: Math.min(10000, maxCandidates * 900 + 1800),
        timeoutMs: ALIGN_TIMELINE_LLM_TIMEOUT_MS,
        retries: 0,
        jsonMode: true,
      },
    );
    recordToolLlmUsage(context, ALIGN_TIMELINE_ORIGIN_TOOL, response.result);
    return { data: response.data };
  }

  private assertAlignmentCandidates(
    preview: GenerateTimelinePreviewOutput,
    context: ToolContext,
    chapter: ChapterRefRow,
    storyEvents: StoryEventRow[],
    timelineEvents: TimelineEventRow[],
  ): void {
    const storyEventIds = new Set(storyEvents.map((event) => event.id));
    const timelineEventsById = new Map(timelineEvents.map((event) => [event.id, event]));

    preview.candidates.forEach((candidate, index) => {
      const path = `timelineCandidates[${index}]`;
      if (!ALIGN_TIMELINE_ACTIONS.has(candidate.action)) {
        throw new Error(`${path}.action must be one of confirm_planned, update_event, archive_event, create_discovered.`);
      }
      if (candidate.chapterId !== chapter.id) {
        throw new Error(`${path}.chapterId must match current chapter.`);
      }
      if (candidate.chapterNo !== chapter.chapterNo) {
        throw new Error(`${path}.chapterNo must match current chapter.`);
      }
      if (candidate.sourceTrace.agentRunId !== context.agentRunId) {
        throw new Error(`${path}.sourceTrace.agentRunId must match current agent run.`);
      }
      if (candidate.sourceTrace.toolName !== ALIGN_TIMELINE_ORIGIN_TOOL) {
        throw new Error(`${path}.sourceTrace.toolName must be ${ALIGN_TIMELINE_ORIGIN_TOOL}.`);
      }
      if (candidate.sourceTrace.chapterId !== chapter.id || candidate.sourceTrace.chapterNo !== chapter.chapterNo) {
        throw new Error(`${path}.sourceTrace chapter reference must match current chapter.`);
      }
      if (!candidate.sourceTrace.evidence) {
        throw new Error(`${path}.sourceTrace.evidence is required.`);
      }
      if (!candidate.sourceTrace.generatedAt) {
        throw new Error(`${path}.sourceTrace.generatedAt is required.`);
      }
      if (candidate.sourceType !== ALIGN_TIMELINE_SOURCE_TYPE) {
        throw new Error(`${path}.sourceType must be ${ALIGN_TIMELINE_SOURCE_TYPE}.`);
      }
      if (!candidate.sourceTrace.contextSources.some((source) => source.sourceType === 'story_event' && source.sourceId && storyEventIds.has(source.sourceId))) {
        throw new Error(`${path}.sourceTrace.contextSources must cite a current chapter StoryEvent.`);
      }
      this.assertActionSpecificCandidate(candidate, path, timelineEventsById);
    });
  }

  private assertActionSpecificCandidate(candidate: TimelineCandidate, path: string, timelineEventsById: Map<string, TimelineEventRow>): void {
    const existing = candidate.existingTimelineEventId ? timelineEventsById.get(candidate.existingTimelineEventId) : undefined;
    if (candidate.action === 'create_discovered') {
      if (candidate.existingTimelineEventId) {
        throw new Error(`${path}.existingTimelineEventId must not be present for create_discovered.`);
      }
      if (!['active', 'changed'].includes(candidate.eventStatus)) {
        throw new Error(`${path}.eventStatus must be active or changed for create_discovered.`);
      }
      return;
    }

    if (!candidate.existingTimelineEventId || !existing) {
      throw new Error(`${path}.existingTimelineEventId must reference a current chapter planned/active TimelineEvent.`);
    }
    if (!candidate.sourceTrace.contextSources.some((source) => source.sourceType === 'timeline_event' && source.sourceId === candidate.existingTimelineEventId)) {
      throw new Error(`${path}.sourceTrace.contextSources must cite the targeted TimelineEvent.`);
    }
    if (candidate.action === 'confirm_planned') {
      if (existing.eventStatus !== 'planned') throw new Error(`${path}.confirm_planned must target a planned TimelineEvent.`);
      if (candidate.eventStatus !== 'active') throw new Error(`${path}.eventStatus must be active for confirm_planned.`);
    }
    if (candidate.action === 'update_event' && !['active', 'changed'].includes(candidate.eventStatus)) {
      throw new Error(`${path}.eventStatus must be active or changed for update_event.`);
    }
    if (candidate.action === 'archive_event' && candidate.eventStatus !== 'archived') {
      throw new Error(`${path}.eventStatus must be archived for archive_event.`);
    }
  }

  private async resolveChapter(args: AlignChapterTimelinePreviewInput, context: ToolContext): Promise<ChapterRefRow> {
    const chapterId = args.chapterId ?? context.chapterId;
    const chapterNo = args.chapterNo;
    if (!chapterId && chapterNo === undefined) {
      throw new Error('align_chapter_timeline_preview requires chapterId or chapterNo.');
    }
    const chapter = await this.prisma.chapter.findFirst({
      where: {
        projectId: context.projectId,
        ...(chapterId ? { id: chapterId } : {}),
        ...(chapterNo !== undefined ? { chapterNo } : {}),
      },
      select: { id: true, projectId: true, chapterNo: true, title: true },
    });
    if (!chapter) {
      throw new Error('align_chapter_timeline_preview chapter reference does not belong to current project.');
    }
    return chapter;
  }

  private async loadStoryEvents(projectId: string, chapter: ChapterRefRow, draftId?: string): Promise<StoryEventRow[]> {
    const rows = await this.prisma.storyEvent.findMany({
      where: {
        projectId,
        chapterId: chapter.id,
        ...(draftId ? { sourceDraftId: draftId } : {}),
      },
      orderBy: [{ timelineSeq: 'asc' }, { updatedAt: 'asc' }],
      take: 80,
      select: {
        id: true,
        projectId: true,
        chapterId: true,
        chapterNo: true,
        sourceDraftId: true,
        title: true,
        eventType: true,
        description: true,
        participants: true,
        timelineSeq: true,
        status: true,
        metadata: true,
        updatedAt: true,
      },
    });
    return rows.map((row) => this.assertCurrentStoryEvent(row, projectId, chapter));
  }

  private async loadCurrentTimelineEvents(projectId: string, chapter: ChapterRefRow): Promise<TimelineEventRow[]> {
    const rows = await this.prisma.timelineEvent.findMany({
      where: {
        projectId,
        eventStatus: { in: ['planned', 'active'] },
        OR: [{ chapterId: chapter.id }, { chapterNo: chapter.chapterNo }],
      },
      orderBy: [{ eventTime: 'asc' }, { updatedAt: 'asc' }],
      take: 80,
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
        updatedAt: true,
      },
    });
    return rows.map((row) => this.assertCurrentTimelineEvent(row, projectId, chapter));
  }

  private assertCurrentStoryEvent(row: StoryEventRow, projectId: string, chapter: ChapterRefRow): StoryEventRow {
    if (row.projectId !== projectId || row.chapterId !== chapter.id) {
      throw new Error(`StoryEvent ${row.id} does not belong to current project chapter.`);
    }
    if (row.chapterNo !== null && row.chapterNo !== chapter.chapterNo) {
      throw new Error(`StoryEvent ${row.id} chapterNo does not match current chapter.`);
    }
    return row;
  }

  private assertCurrentTimelineEvent(row: TimelineEventRow, projectId: string, chapter: ChapterRefRow): TimelineEventRow {
    if (row.projectId !== projectId) {
      throw new Error(`TimelineEvent ${row.id} does not belong to current project.`);
    }
    if (row.chapterId !== chapter.id && row.chapterNo !== chapter.chapterNo) {
      throw new Error(`TimelineEvent ${row.id} does not belong to current chapter.`);
    }
    if (!['planned', 'active'].includes(row.eventStatus)) {
      throw new Error(`TimelineEvent ${row.id} must be planned or active for chapter alignment.`);
    }
    return row;
  }

  private storyEventsForPrompt(events: StoryEventRow[]): Array<Record<string, unknown>> {
    return events.slice(0, 60).map((event) => ({
      id: event.id,
      chapterId: event.chapterId,
      chapterNo: event.chapterNo,
      sourceDraftId: event.sourceDraftId ?? null,
      title: event.title,
      eventType: event.eventType,
      description: event.description,
      participants: this.stringArray(event.participants),
      timelineSeq: event.timelineSeq ?? null,
      status: event.status,
      metadata: event.metadata ?? {},
    }));
  }

  private timelineEventsForPrompt(events: TimelineEventRow[]): Array<Record<string, unknown>> {
    return events.slice(0, 60).map((event) => ({
      id: event.id,
      chapterId: event.chapterId ?? null,
      chapterNo: event.chapterNo ?? null,
      title: event.title,
      eventTime: event.eventTime ?? null,
      locationName: event.locationName ?? null,
      participants: this.stringArray(event.participants),
      cause: event.cause ?? null,
      result: event.result ?? null,
      impactScope: event.impactScope ?? null,
      isPublic: event.isPublic ?? false,
      knownBy: this.stringArray(event.knownBy),
      unknownBy: this.stringArray(event.unknownBy),
      eventStatus: event.eventStatus,
      sourceType: event.sourceType,
      metadata: event.metadata ?? {},
    }));
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
  }

  private readMaxCandidates(value: unknown): number {
    if (value === undefined || value === null) return 8;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > ALIGN_TIMELINE_MAX_CANDIDATES) {
      throw new Error(`maxCandidates must be an integer between 1 and ${ALIGN_TIMELINE_MAX_CANDIDATES}.`);
    }
    return value;
  }
}
