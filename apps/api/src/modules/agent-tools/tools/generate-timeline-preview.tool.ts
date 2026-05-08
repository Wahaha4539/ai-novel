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
import type { GenerateTimelinePreviewInput, GenerateTimelinePreviewOutput } from './timeline-preview.types';

const TIMELINE_PREVIEW_SOURCE_KIND = 'planned_timeline_event' as const;
const TIMELINE_PREVIEW_ORIGIN_TOOL = 'generate_timeline_preview' as const;
const TIMELINE_PREVIEW_SOURCE_TYPE = 'agent_timeline_plan' as const;
const TIMELINE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const TIMELINE_PREVIEW_MAX_CANDIDATES = 20;

@Injectable()
export class GenerateTimelinePreviewTool implements BaseTool<GenerateTimelinePreviewInput, GenerateTimelinePreviewOutput> {
  name = TIMELINE_PREVIEW_ORIGIN_TOOL;
  description = 'Generate planned TimelineEvent candidates without writing to the database.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      sourceType: { type: 'string' as const },
      chapterId: { type: 'string' as const },
      chapterNo: { type: 'number' as const, minimum: 1, integer: true },
      draftId: { type: 'string' as const },
      minCandidates: { type: 'number' as const, minimum: 1, maximum: TIMELINE_PREVIEW_MAX_CANDIDATES, integer: true },
      maxCandidates: { type: 'number' as const, minimum: 1, maximum: TIMELINE_PREVIEW_MAX_CANDIDATES, integer: true },
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
  executionTimeoutMs = TIMELINE_PREVIEW_LLM_TIMEOUT_MS + 60_000;
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Generate Timeline Preview',
    description: 'Create planned TimelineEvent candidates from outlines, craftBriefs, or supplied planning context. This tool is read-only and never writes TimelineEvent rows.',
    whenToUse: [
      'The user asks to generate planned timeline facts from a book outline, volume outline, chapter outline, Chapter.craftBrief, or planning context.',
      'The agent needs timeline-only candidates before validate_timeline_preview and any approved persist step.',
      'The output must remain planned and must not claim the events are confirmed chapter facts.',
    ],
    whenNotToUse: [
      'The user asks to persist timeline events immediately; validation and approved persist must run later.',
      'The task is chapter prose generation or polishing.',
      'The task is post-chapter StoryEvent alignment; use align_chapter_timeline_preview later for that flow.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'Planning context from outline/craftBrief/collect_task_context. Include source IDs and chapter refs when available.' },
      instruction: { source: 'user_message', description: 'User request and constraints for planned timeline candidates.' },
      sourceType: { source: 'literal', description: 'Planning source label such as book_outline, volume_outline, chapter_outline, or craft_brief.' },
      chapterId: { source: 'resolver', description: 'Optional real chapterId for a chapter-scoped timeline preview; do not invent it.' },
      chapterNo: { source: 'user_message', description: 'Optional real chapter number for a chapter-scoped timeline preview.' },
      draftId: { source: 'previous_step', description: 'Optional draftId when the planning context is tied to a draft.' },
      minCandidates: { source: 'literal', description: 'Minimum candidate count. The tool fails if the LLM returns fewer.' },
      maxCandidates: { source: 'literal', description: 'Maximum candidate count. Defaults to 5 and never exceeds 20.' },
    },
    examples: [
      {
        user: 'Generate planned timeline events from chapter 7 craftBrief.',
        plan: [
          { tool: 'resolve_chapter', args: { chapterRef: 'chapter 7' } },
          { tool: 'collect_task_context', args: { taskType: 'timeline_plan', chapterId: '{{steps.resolve_chapter.output.chapterId}}' } },
          { tool: 'generate_timeline_preview', args: { chapterId: '{{steps.resolve_chapter.output.chapterId}}', chapterNo: 7, sourceType: 'craft_brief', context: '{{steps.collect_task_context.output}}', instruction: '{{user_message}}' } },
          { tool: 'validate_timeline_preview', args: { preview: '{{steps.generate_timeline_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['projectId', 'chapterId', 'timelineEventId'],
      allowedSources: ['projectId from ToolContext only', 'chapterId/chapterNo from resolver, DB lookup, or supplied planning context', 'candidateId is a preview-local ID only'],
    },
  };

  constructor(
    private readonly llm: LlmGatewayService,
    private readonly prisma: PrismaService,
  ) {}

  async run(args: GenerateTimelinePreviewInput, context: ToolContext): Promise<GenerateTimelinePreviewOutput> {
    const minCandidates = this.readLimit(args.minCandidates, 1, 'minCandidates');
    const maxCandidates = this.readLimit(args.maxCandidates, Math.max(5, minCandidates), 'maxCandidates');
    if (minCandidates > maxCandidates) {
      throw new Error(`minCandidates ${minCandidates} cannot exceed maxCandidates ${maxCandidates}.`);
    }

    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: 'Generating planned timeline preview',
      progressCurrent: 0,
      progressTotal: maxCandidates,
      timeoutMs: TIMELINE_PREVIEW_LLM_TIMEOUT_MS,
    });

    const preview = await normalizeTimelinePreviewFromLlmCall(
      () => this.callTimelineLlm(args, context, maxCandidates),
      {
        expectedProjectId: context.projectId,
        expectedSourceKind: TIMELINE_PREVIEW_SOURCE_KIND,
        expectedOriginTool: TIMELINE_PREVIEW_ORIGIN_TOOL,
        sourceKind: TIMELINE_PREVIEW_SOURCE_KIND,
        allowedActions: ['create_planned'],
        minCandidates,
        maxCandidates,
      },
    );
    this.assertPlannedCandidates(preview, context);

    await context.updateProgress?.({
      phase: 'validating',
      phaseMessage: 'Validating planned timeline preview',
      progressCurrent: maxCandidates,
      progressTotal: maxCandidates,
    });
    const chapters = await this.loadChapterRefs(context.projectId, preview);
    const resolvedChapterRefs = validateTimelineCandidateChapterRefs(preview.candidates, chapters, context.projectId);
    const existingEvents = await this.loadExistingTimelineEvents(context.projectId);
    assertNoTimelineDuplicateConflicts(preview.candidates, existingEvents, { expectedProjectId: context.projectId, resolvedChapterRefs });

    return preview;
  }

  private async callTimelineLlm(args: GenerateTimelinePreviewInput, context: ToolContext, maxCandidates: number): Promise<{ data: unknown }> {
    const response = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            'You are the AI Novel timeline planning agent. Return JSON only, no Markdown.',
            'Generate timeline-only planned facts for TimelineEvent preview. Do not write prose. Do not confirm events as already happened.',
            'The top-level JSON object must contain candidates, assumptions, and risks.',
            'Every candidate must include candidateId, action="create_planned", chapterId or chapterNo, title, eventTime, participants, cause, result, impactScope, isPublic, knownBy, unknownBy, eventStatus="planned", sourceType="agent_timeline_plan", impactAnalysis, conflictRisk, and sourceTrace.',
            `Every sourceTrace must include sourceKind="${TIMELINE_PREVIEW_SOURCE_KIND}", projectId="${context.projectId}", originTool="${TIMELINE_PREVIEW_ORIGIN_TOOL}", agentRunId="${context.agentRunId}", toolName="${TIMELINE_PREVIEW_ORIGIN_TOOL}", candidateId, candidateAction, matching chapterId/chapterNo, contextSources, evidence, and generatedAt.`,
            'Do not use placeholders, empty strings, "none", or invented database IDs. If context is insufficient, return an incomplete/empty preview rather than fabricating facts; the tool will fail and ask for better context.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Instruction: ${args.instruction ?? ''}`,
            `Planning sourceType: ${args.sourceType ?? 'planning_context'}`,
            `ProjectId: ${context.projectId}`,
            `AgentRunId: ${context.agentRunId}`,
            `Requested chapterId: ${args.chapterId ?? ''}`,
            `Requested chapterNo: ${args.chapterNo ?? ''}`,
            `DraftId: ${args.draftId ?? ''}`,
            `Max candidates: ${maxCandidates}`,
            `Planning context:\n${JSON.stringify(args.context ?? {}, null, 2).slice(0, 24000)}`,
          ].join('\n\n'),
        },
      ],
      {
        appStep: TIMELINE_PREVIEW_ORIGIN_TOOL,
        maxTokens: Math.min(10000, maxCandidates * 900 + 1800),
        timeoutMs: TIMELINE_PREVIEW_LLM_TIMEOUT_MS,
        retries: 0,
        jsonMode: true,
      },
    );
    recordToolLlmUsage(context, TIMELINE_PREVIEW_ORIGIN_TOOL, response.result);
    return { data: response.data };
  }

  private assertPlannedCandidates(preview: GenerateTimelinePreviewOutput, context: ToolContext): void {
    preview.candidates.forEach((candidate, index) => {
      const path = `timelineCandidates[${index}]`;
      if (candidate.action !== 'create_planned') {
        throw new Error(`${path}.action must be create_planned for generate_timeline_preview.`);
      }
      if (candidate.existingTimelineEventId) {
        throw new Error(`${path}.existingTimelineEventId must not be present for planned timeline preview candidates.`);
      }
      if (candidate.eventStatus !== 'planned') {
        throw new Error(`${path}.eventStatus must be planned for generate_timeline_preview.`);
      }
      if (candidate.sourceType !== TIMELINE_PREVIEW_SOURCE_TYPE) {
        throw new Error(`${path}.sourceType must be ${TIMELINE_PREVIEW_SOURCE_TYPE}.`);
      }
      if (candidate.sourceTrace.agentRunId !== context.agentRunId) {
        throw new Error(`${path}.sourceTrace.agentRunId must match current agent run.`);
      }
      if (candidate.sourceTrace.toolName !== TIMELINE_PREVIEW_ORIGIN_TOOL) {
        throw new Error(`${path}.sourceTrace.toolName must be ${TIMELINE_PREVIEW_ORIGIN_TOOL}.`);
      }
      if (!candidate.sourceTrace.evidence) {
        throw new Error(`${path}.sourceTrace.evidence is required.`);
      }
      if (!candidate.sourceTrace.generatedAt) {
        throw new Error(`${path}.sourceTrace.generatedAt is required.`);
      }
      if (candidate.chapterId && candidate.sourceTrace.chapterId !== candidate.chapterId) {
        throw new Error(`${path}.sourceTrace.chapterId must match candidate chapterId.`);
      }
      if (candidate.chapterNo !== undefined && candidate.sourceTrace.chapterNo !== candidate.chapterNo) {
        throw new Error(`${path}.sourceTrace.chapterNo must match candidate chapterNo.`);
      }
    });
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

  private async loadExistingTimelineEvents(projectId: string): Promise<ExistingTimelineEventRef[]> {
    return this.prisma.timelineEvent.findMany({
      where: { projectId },
      select: { id: true, projectId: true, chapterId: true, chapterNo: true, title: true, eventTime: true },
    });
  }

  private readLimit(value: unknown, fallback: number, label: string): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > TIMELINE_PREVIEW_MAX_CANDIDATES) {
      throw new Error(`${label} must be an integer between 1 and ${TIMELINE_PREVIEW_MAX_CANDIDATES}.`);
    }
    return value;
  }
}
