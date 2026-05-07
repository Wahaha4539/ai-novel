import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { normalizeLorebookEntryType, STORY_BIBLE_ENTRY_TYPES } from '../../lorebook/lorebook-entry-types';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface GenerateStoryBiblePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  focus?: string[];
  maxCandidates?: number;
}

const STORY_BIBLE_PREVIEW_LLM_TIMEOUT_MS = DEFAULT_LLM_TIMEOUT_MS;
const STORY_BIBLE_PREVIEW_LLM_RETRIES = 1;
const STORY_BIBLE_PREVIEW_PHASE_TIMEOUT_MS = STORY_BIBLE_PREVIEW_LLM_TIMEOUT_MS * (STORY_BIBLE_PREVIEW_LLM_RETRIES + 1) + 5_000;

export interface StoryBibleSourceTrace {
  sourceKind: 'planned_story_bible_asset';
  originTool: 'generate_story_bible_preview';
  agentRunId: string;
  candidateIndex: number;
  instruction: string;
  focus: string[];
  contextSources: Array<{ sourceType: string; sourceId?: string; title?: string; locked?: boolean }>;
}

export interface StoryBiblePreviewCandidate {
  candidateId: string;
  title: string;
  entryType: string;
  summary: string;
  content: string;
  tags: string[];
  triggerKeywords: string[];
  relatedEntityIds: string[];
  priority: number;
  impactAnalysis: string;
  relatedExistingFacts: string[];
  lockedFactHandling: string;
  sourceTrace: StoryBibleSourceTrace;
  metadata: Record<string, unknown> & { sourceKind: 'planned_story_bible_asset' };
  diffKey: { title: string; entryType: string };
  proposedFields: {
    title: string;
    entryType: string;
    summary: string;
    content: string;
    tags: string[];
    triggerKeywords: string[];
    relatedEntityIds: string[];
    priority: number;
  };
}

export interface StoryBiblePreviewOutput {
  candidates: StoryBiblePreviewCandidate[];
  assumptions: string[];
  risks: string[];
  writePlan: {
    mode: 'preview_only';
    target: 'LorebookEntry';
    sourceKind: 'planned_story_bible_asset';
    requiresValidation: boolean;
    requiresApprovalBeforePersist: boolean;
  };
}

const STORY_BIBLE_TYPE_VALUES = [...STORY_BIBLE_ENTRY_TYPES];
const STORY_BIBLE_TYPE_SET = new Set<string>(STORY_BIBLE_TYPE_VALUES);

@Injectable()
export class GenerateStoryBiblePreviewTool implements BaseTool<GenerateStoryBiblePreviewInput, StoryBiblePreviewOutput> {
  name = 'generate_story_bible_preview';
  description = 'Generate planned Story Bible LorebookEntry candidates without writing to the database.';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      context: { type: 'object' as const },
      instruction: { type: 'string' as const },
      focus: { type: 'array' as const, items: { type: 'string' as const } },
      maxCandidates: { type: 'number' as const, minimum: 1, maximum: 20, integer: true },
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
    displayName: 'Generate Story Bible Preview',
    description: 'Create planned Story Bible candidates for LorebookEntry storage. This tool only previews candidates and never writes business tables.',
    whenToUse: [
      'The user asks to plan or extend Story Bible assets such as rules, factions, locations, power systems, history, economy, technology, or forbidden rules.',
      'A later validate_story_bible step must inspect conflicts and produce a write preview.',
      'The agent needs diff-friendly planned assets before any approved persist step.',
    ],
    whenNotToUse: [
      'The user asks to write or polish chapter prose.',
      'The user wants an immediate database write; validate_story_bible and persist_story_bible must run later.',
      'The requested change would rewrite locked facts or claim planned assets already happened in chapter text.',
    ],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      context: { source: 'previous_step', description: 'Project context from inspect_project_context or collect_task_context.' },
      instruction: { source: 'user_message', description: 'The user request and constraints for the Story Bible assets.' },
      focus: { source: 'literal', description: 'Optional focus areas such as power_system, faction, location, locked_world_facts.' },
      maxCandidates: { source: 'literal', description: 'Maximum number of candidates to preview. Defaults to 5.' },
    },
    examples: [
      {
        user: 'Plan the power system and two factions, but do not overwrite existing locked facts.',
        plan: [
          { tool: 'collect_task_context', args: { taskType: 'worldbuilding_expand', focus: ['locked_world_facts', 'lorebook'] } },
          { tool: 'generate_story_bible_preview', args: { context: '{{steps.collect_task_context.output}}', instruction: '{{user_message}}', focus: ['power_system', 'faction'] } },
          { tool: 'validate_story_bible', args: { preview: '{{steps.generate_story_bible_preview.output}}', taskContext: '{{steps.collect_task_context.output}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: {
      forbiddenToInvent: ['entryId', 'projectId', 'chapterId'],
      allowedSources: ['candidateId generated by generate_story_bible_preview normalization', 'projectId from ToolContext only'],
    },
  };

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateStoryBiblePreviewInput, context: ToolContext): Promise<StoryBiblePreviewOutput> {
    const maxCandidates = Math.min(20, Math.max(1, Number(args.maxCandidates) || 5));
    const focus = this.stringArray(args.focus);
    const instruction = this.text(args.instruction, 'Plan Story Bible assets.');
    await context.updateProgress?.({
      phase: 'calling_llm',
      phaseMessage: '正在生成 Story Bible 预览',
      progressCurrent: 0,
      progressTotal: maxCandidates,
      timeoutMs: STORY_BIBLE_PREVIEW_PHASE_TIMEOUT_MS,
    });

    const { data } = await this.llm.chatJson<Partial<StoryBiblePreviewOutput> & { entries?: unknown }>(
      [
        {
          role: 'system',
          content:
            'You are the AI Novel Story Bible planning agent. Return JSON only, no Markdown. Generate planned Story Bible assets for LorebookEntry storage, not chapter prose. Do not state that a planned asset already happened in chapter text unless supplied context explicitly says it happened. Each candidate must include title, entryType, summary, content, tags, triggerKeywords, priority, impactAnalysis, relatedExistingFacts, lockedFactHandling, and metadata.sourceKind="planned_story_bible_asset". Allowed entryType values: world_rule, power_system, faction, faction_relation, location, item, history_event, religion, economy, technology, forbidden_rule, setting.',
        },
        {
          role: 'user',
          content: `Instruction: ${instruction}
Focus: ${focus.join(', ') || 'general_story_bible'}
Max candidates: ${maxCandidates}
Project context:
${JSON.stringify(args.context ?? {}, null, 2).slice(0, 24000)}`,
        },
      ],
      { appStep: 'planner', maxTokens: Math.min(8000, maxCandidates * 800 + 1400), timeoutMs: STORY_BIBLE_PREVIEW_LLM_TIMEOUT_MS, retries: STORY_BIBLE_PREVIEW_LLM_RETRIES },
    );
    await context.updateProgress?.({ phase: 'validating', phaseMessage: '正在校验 Story Bible 预览', progressCurrent: maxCandidates, progressTotal: maxCandidates });

    return this.normalize(data, args, context, maxCandidates);
  }

  private normalize(data: Partial<StoryBiblePreviewOutput> & { entries?: unknown }, args: GenerateStoryBiblePreviewInput, context: ToolContext, maxCandidates: number): StoryBiblePreviewOutput {
    const rawCandidates = Array.isArray(data.candidates)
      ? data.candidates
      : Array.isArray(data.entries)
        ? data.entries
        : [];
    const focus = this.stringArray(args.focus);
    const instruction = this.text(args.instruction, 'Plan Story Bible assets.');
    const contextSources = this.extractContextSources(args.context).slice(0, 12);

    const candidates = rawCandidates
      .slice(0, maxCandidates)
      .map((raw, index) => this.normalizeCandidate(raw, index, instruction, focus, contextSources, context));

    return {
      candidates,
      assumptions: this.stringArray(data.assumptions),
      risks: this.stringArray(data.risks),
      writePlan: {
        mode: 'preview_only',
        target: 'LorebookEntry',
        sourceKind: 'planned_story_bible_asset',
        requiresValidation: true,
        requiresApprovalBeforePersist: true,
      },
    };
  }

  private normalizeCandidate(raw: unknown, index: number, instruction: string, focus: string[], contextSources: StoryBibleSourceTrace['contextSources'], context: ToolContext): StoryBiblePreviewCandidate {
    const record = this.asRecord(raw) ?? {};
    const title = this.text(record.title, `Story Bible Candidate ${index + 1}`);
    const entryType = this.normalizeEntryType(record.entryType);
    const summary = this.text(record.summary, '');
    const content = this.text(record.content, summary || `Planned Story Bible asset: ${title}`);
    const tags = this.stringArray(record.tags);
    const triggerKeywords = this.stringArray(record.triggerKeywords).length
      ? this.stringArray(record.triggerKeywords)
      : [...new Set([title, ...tags].filter(Boolean))];
    const relatedEntityIds = this.stringArray(record.relatedEntityIds);
    const priority = Math.min(100, Math.max(0, Number(record.priority) || 50));
    const candidateId = this.buildCandidateId(title, entryType, index);
    const sourceTrace: StoryBibleSourceTrace = {
      sourceKind: 'planned_story_bible_asset',
      originTool: 'generate_story_bible_preview',
      agentRunId: context.agentRunId,
      candidateIndex: index,
      instruction: this.compactText(instruction, 500),
      focus,
      contextSources,
    };
    const metadata = {
      ...(this.asRecord(record.metadata) ?? {}),
      sourceKind: 'planned_story_bible_asset' as const,
      lifecycle: 'planned',
      sourceTool: 'generate_story_bible_preview',
      sourceTrace,
    };

    return {
      candidateId,
      title,
      entryType,
      summary,
      content,
      tags,
      triggerKeywords,
      relatedEntityIds,
      priority,
      impactAnalysis: this.text(record.impactAnalysis, 'Planned asset only; validate before persist and do not overwrite existing locked facts.'),
      relatedExistingFacts: this.stringArray(record.relatedExistingFacts),
      lockedFactHandling: this.text(record.lockedFactHandling, 'Do not modify locked facts; only add compatible planned Story Bible material.'),
      sourceTrace,
      metadata,
      diffKey: { title, entryType },
      proposedFields: { title, entryType, summary, content, tags, triggerKeywords, relatedEntityIds, priority },
    };
  }

  private normalizeEntryType(value: unknown): string {
    const normalized = normalizeLorebookEntryType(this.text(value, 'setting'));
    return STORY_BIBLE_TYPE_SET.has(normalized) ? normalized : 'setting';
  }

  private buildCandidateId(title: string, entryType: string, index: number): string {
    const seed = `${index}:${entryType}:${title}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `sbc_${index + 1}_${(hash >>> 0).toString(36)}`;
  }

  private extractContextSources(context?: Record<string, unknown>): StoryBibleSourceTrace['contextSources'] {
    if (!context) return [];
    return [
      ...this.sourceRefs(context.worldFacts, 'lorebook'),
      ...this.sourceRefs(context.lorebookEntries, 'lorebook'),
      ...this.sourceRefs(context.plotEvents, 'story_event'),
      ...this.sourceRefs(context.memoryChunks, 'memory'),
      ...this.sourceRefs(context.chapters, 'chapter'),
    ];
  }

  private sourceRefs(value: unknown, sourceType: string): StoryBibleSourceTrace['contextSources'] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => Boolean(item))
      .map((item) => ({
        sourceType,
        sourceId: this.text(item.id, '') || undefined,
        title: this.text(item.title, '') || this.text(item.summary, '') || undefined,
        locked: item.locked === true || this.text(item.status, '') === 'locked',
      }));
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
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }

  private stringArray(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))] : [];
  }
}
