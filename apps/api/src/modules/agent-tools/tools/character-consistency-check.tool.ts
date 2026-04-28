import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { LlmGatewayService } from '../../llm/llm-gateway.service';

interface CharacterConsistencyCheckInput {
  characterId?: string;
  taskContext?: Record<string, unknown>;
  focusText?: string;
  instruction?: string;
  experimentalLlmEvidenceSummary?: boolean;
}

interface LlmEvidenceSummary {
  status: 'succeeded' | 'fallback';
  summary?: string;
  keyFindings?: string[];
  model?: string;
  error?: string;
  fallbackUsed: boolean;
}

interface CharacterConsistencyCheckOutput {
  character: {
    id?: string;
    name?: string;
    roleType?: string | null;
  };
  baseline: string[];
  currentEvidence: string[];
  deviations: Array<{
    severity: 'info' | 'warning' | 'error';
    dimension: string;
    message: string;
    evidence?: string;
    suggestion?: string;
  }>;
  verdict: {
    status: 'consistent' | 'minor_drift' | 'likely_break';
    summary: string;
    needsRevision: boolean;
  };
  suggestions: string[];
  llmEvidenceSummary?: LlmEvidenceSummary;
}

interface CharacterEvidenceProfile {
  hasCurrentText: boolean;
  hasStateEvidence: boolean;
  hasRelationshipEvidence: boolean;
  hasPlotEvidence: boolean;
  hasPressureSupport: boolean;
}

/**
 * 角色一致性只读检查工具：基于 collect_task_context 的压缩上下文输出人设基线、证据和偏差判断。
 * 默认完全 deterministic；仅在实验开关显式开启时调用 LLM 做只读证据归纳，失败会自动降级且不改变诊断结论。
 */
@Injectable()
export class CharacterConsistencyCheckTool implements BaseTool<CharacterConsistencyCheckInput, CharacterConsistencyCheckOutput> {
  name = 'character_consistency_check';
  description = '基于角色基线、近期状态、章节摘录和校验问题检查角色是否人设偏离。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      characterId: { type: 'string' as const, minLength: 1 },
      taskContext: { type: 'object' as const },
      focusText: { type: 'string' as const },
      instruction: { type: 'string' as const },
      experimentalLlmEvidenceSummary: { type: 'boolean' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['character', 'baseline', 'currentEvidence', 'deviations', 'verdict', 'suggestions'],
    properties: {
      character: { type: 'object' as const },
      baseline: { type: 'array' as const },
      currentEvidence: { type: 'array' as const },
      deviations: { type: 'array' as const },
      verdict: { type: 'object' as const },
      suggestions: { type: 'array' as const },
      llmEvidenceSummary: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '检查角色一致性',
    description: '根据 collect_task_context 收集到的人设基线、近期状态、章节摘录和未关闭校验问题，输出“是否人设崩坏”的只读诊断。',
    whenToUse: ['用户询问“男主/女主/某角色有没有崩”', '需要检查角色动机、说话方式、行为是否符合既有人设', '角色检查任务已经通过 resolve_character 得到真实 characterId'],
    whenNotToUse: ['用户要求直接重写或润色章节时，应使用 polish_chapter 并配合 fact_validation', '缺少真实 characterId 且尚未调用 resolve_character', '需要生成世界观或大纲预览时'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      characterId: { source: 'resolver', resolverTool: 'resolve_character', description: '真实角色 ID；“男主/小林/师姐”等自然语言引用必须先解析。' },
      taskContext: { source: 'previous_step', description: '来自 collect_task_context 的输出，需包含 characters、chapters、constraints 等字段。' },
      focusText: { source: 'context', description: '用户选中的文本片段；若有选区，优先作为当前表现证据。' },
      instruction: { source: 'user_message', description: '保留用户原始检查重点，例如“这里是不是太冲动了”。' },
    },
    examples: [
      {
        user: '男主这里是不是人设崩了？',
        plan: [
          { tool: 'resolve_character', args: { characterRef: '男主', projectId: '{{context.session.currentProjectId}}' } },
          { tool: 'collect_task_context', args: { taskType: 'character_consistency_check', characterId: '{{steps.resolve_character.output.characterId}}', focus: ['character_arc', 'dialogue_style', 'known_facts'] } },
          { tool: 'character_consistency_check', args: { characterId: '{{steps.resolve_character.output.characterId}}', taskContext: '{{steps.collect_task_context.output}}', instruction: '男主这里是不是人设崩了？' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['characterId'], allowedSources: ['resolve_character.output.characterId', 'steps.resolve_character.output.characterId'] },
  };

  constructor(private readonly llm?: LlmGatewayService) {}

  async run(args: CharacterConsistencyCheckInput, _context: ToolContext): Promise<CharacterConsistencyCheckOutput> {
    const taskContext = this.asRecord(args.taskContext);
    const characters = this.asArray(taskContext.characters).map((item) => this.asRecord(item));
    const chapters = this.asArray(taskContext.chapters).map((item) => this.asRecord(item));
    const relationshipGraph = this.asArray(taskContext.relationshipGraph).map((item) => this.asRecord(item));
    const plotEvents = this.asArray(taskContext.plotEvents).map((item) => this.asRecord(item));
    const worldFacts = this.asArray(taskContext.worldFacts).map((item) => this.asRecord(item));
    const lockedFacts = worldFacts.filter((fact) => fact.locked === true || this.text(fact.status) === 'locked');
    const constraints = this.asArray(taskContext.constraints).filter((item): item is string => typeof item === 'string');

    const character = this.pickCharacter(characters, args.characterId);
    const baseline = this.buildBaseline(character);
    const currentEvidence = this.buildCurrentEvidence(character, chapters, relationshipGraph, plotEvents, lockedFacts, args.focusText);
    const evidenceProfile = this.buildEvidenceProfile(character, chapters, relationshipGraph, plotEvents, args.focusText);
    const deviations = this.buildDeviations(character, baseline, currentEvidence, evidenceProfile, constraints, args.instruction);
    const verdict = this.buildVerdict(deviations, character);
    const deterministicOutput = {
      character: { id: this.text(character.id), name: this.text(character.name), roleType: typeof character.roleType === 'string' ? character.roleType : null },
      baseline,
      currentEvidence,
      deviations,
      verdict,
      suggestions: this.buildSuggestions(deviations),
    };
    const llmEvidenceSummary = await this.maybeSummarizeEvidence(args.experimentalLlmEvidenceSummary, deterministicOutput, args.instruction);

    return {
      ...deterministicOutput,
      ...(llmEvidenceSummary ? { llmEvidenceSummary } : {}),
    };
  }

  /**
   * 默认关闭的 LLM 证据归纳实验：只读总结 deterministic 输出。
   * 失败时返回 fallback 元数据并保留原诊断结果，绝不写库、绝不改变 verdict/建议或审批边界。
   */
  private async maybeSummarizeEvidence(enabled: boolean | undefined, output: Omit<CharacterConsistencyCheckOutput, 'llmEvidenceSummary'>, instruction?: string): Promise<LlmEvidenceSummary | undefined> {
    if (!enabled) return undefined;
    if (!this.llm) return { status: 'fallback', fallbackUsed: true, error: 'LLM evidence summary gateway unavailable' };
    try {
      const response = await this.llm.chatJson<{ summary?: string; keyFindings?: string[] }>([
        { role: 'system', content: '你是小说创作质检助手。只基于输入的确定性诊断做证据归纳，输出 JSON，不新增事实、不提出写库动作。' },
        { role: 'user', content: JSON.stringify({ task: 'character_consistency_evidence_summary', instruction, deterministicReport: output }) },
      ], { appStep: 'agent_evidence_summary', temperature: 0.1, maxTokens: 600, timeoutMs: 30_000, retries: 0 });
      return {
        status: 'succeeded',
        fallbackUsed: false,
        summary: this.text(response.data.summary),
        keyFindings: this.asArray(response.data.keyFindings).map((item) => this.text(item)).filter(Boolean).slice(0, 6),
        model: response.result.model,
      };
    } catch (error) {
      return { status: 'fallback', fallbackUsed: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private pickCharacter(characters: Array<Record<string, unknown>>, characterId?: string): Record<string, unknown> {
    return characters.find((item) => this.text(item.id) === characterId) ?? characters[0] ?? {};
  }

  /** 将数据库中的人设字段整理成用户可读基线，供前端报告和后续修稿计划复用。 */
  private buildBaseline(character: Record<string, unknown>): string[] {
    const baseline = [
      this.formatFact('角色定位', character.roleType),
      this.formatFact('性格核心', character.personalityCore),
      this.formatFact('主要动机', character.motivation),
      this.formatFact('说话风格', character.speechStyle),
    ].filter((item): item is string => Boolean(item));
    return baseline.length ? baseline : ['缺少明确人设基线，建议先补充角色定位、性格核心、动机和说话风格。'];
  }

  private buildCurrentEvidence(character: Record<string, unknown>, chapters: Array<Record<string, unknown>>, relationshipGraph: Array<Record<string, unknown>>, plotEvents: Array<Record<string, unknown>>, lockedFacts: Array<Record<string, unknown>>, focusText?: string): string[] {
    const characterName = this.text(character.name);
    const recentStates = this.asArray(character.recentStates).map((item) => this.asRecord(item));
    const stateEvidence = recentStates.map((state) => this.compactText(`第${this.text(state.chapterNo) || '?'}章 ${this.text(state.stateType)}：${this.text(state.stateValue)} ${this.text(state.summary)}`, 180));
    const chapterEvidence = chapters.map((chapter) => this.compactText(`第${this.text(chapter.chapterNo) || '?'}章《${this.text(chapter.title) || '未命名'}》：${this.text(chapter.latestDraftExcerpt) || this.text(chapter.outline)}`, 240));
    const relationshipEvidence = this.relatedRelationshipEdges(relationshipGraph, characterName)
      .map((edge) => this.compactText(`关系证据：${this.text(edge.source)}${edge.target ? ` → ${this.text(edge.target)}` : ''}${this.isConflictEdge(edge) ? '（冲突）' : ''}：${this.text(edge.evidence)}`, 220));
    const plotEvidence = this.relatedPlotEvents(plotEvents, characterName)
      .map((event) => this.compactText(`剧情事件：第${this.text(event.chapterNo) || '?'}章 ${this.text(event.title) || '未命名事件'}：${this.text(event.description)}`, 220));
    const lockedFactEvidence = lockedFacts.map((fact) => this.compactText(`锁定事实边界：${this.text(fact.title) || '未命名'}：${this.text(fact.summary) || this.text(fact.content) || '未记录内容'}`, 200));
    const selected = focusText?.trim() ? [`选中文本：${this.compactText(focusText, 300)}`] : [];
    return [...selected, ...stateEvidence, ...relationshipEvidence, ...plotEvidence, ...chapterEvidence, ...lockedFactEvidence].filter(Boolean).slice(0, 14);
  }

  /** 将当前证据拆成可判断的维度，避免只凭文本片段把强烈行为误判为人设崩坏。 */
  private buildEvidenceProfile(character: Record<string, unknown>, chapters: Array<Record<string, unknown>>, relationshipGraph: Array<Record<string, unknown>>, plotEvents: Array<Record<string, unknown>>, focusText?: string): CharacterEvidenceProfile {
    const characterName = this.text(character.name);
    const recentStates = this.asArray(character.recentStates).map((item) => this.asRecord(item));
    const relatedEdges = this.relatedRelationshipEdges(relationshipGraph, characterName);
    const relatedEvents = this.relatedPlotEvents(plotEvents, characterName);
    const hasPressureState = recentStates.some((state) => /愤怒|压抑|恐惧|受伤|动摇|失控|被迫|压力/.test(`${this.text(state.stateValue)} ${this.text(state.summary)}`));
    const hasConflictEvidence = relatedEdges.some((edge) => this.isConflictEdge(edge)) || relatedEvents.some((event) => /冲突|对峙|背叛|攻击|决裂|反转|转折/.test(`${this.text(event.eventType)} ${this.text(event.title)} ${this.text(event.description)}`));
    return {
      hasCurrentText: Boolean(focusText?.trim()) || chapters.some((chapter) => this.text(chapter.latestDraftExcerpt) || this.text(chapter.latestDraftContent) || this.text(chapter.outline)),
      hasStateEvidence: recentStates.length > 0,
      hasRelationshipEvidence: relatedEdges.length > 0,
      hasPlotEvidence: relatedEvents.length > 0,
      hasPressureSupport: hasPressureState || hasConflictEvidence,
    };
  }

  private buildDeviations(_character: Record<string, unknown>, baseline: string[], evidence: string[], evidenceProfile: CharacterEvidenceProfile, constraints: string[], instruction?: string): CharacterConsistencyCheckOutput['deviations'] {
    const deviations: CharacterConsistencyCheckOutput['deviations'] = [];
    if (baseline[0]?.includes('缺少明确人设基线')) {
      deviations.push({ severity: 'warning', dimension: 'baseline', message: '角色基线信息不足，无法高置信判断是否人设崩坏。', suggestion: '先补充角色性格核心、动机和说话风格，再进行严格一致性检查。' });
    }
    if (!evidenceProfile.hasCurrentText && !evidenceProfile.hasStateEvidence && !evidenceProfile.hasRelationshipEvidence && !evidenceProfile.hasPlotEvidence) {
      deviations.push({ severity: 'warning', dimension: 'evidence', message: '缺少当前章节、近期状态、剧情事件或关系图证据，检查只能基于既有人设给出建议。', suggestion: '请提供当前章节草稿、选中文本，或先运行 collect_task_context 并召回 character_arc、plot_facts、relationship_graph。' });
    }

    const joinedEvidence = evidence.join('\n');
    const baselineText = baseline.join('\n');
    const asksBehaviorCheck = Boolean(instruction && /冲动|莽撞|失控|崩|突兀|转折/.test(instruction));
    const calmBaseline = /克制|冷静|隐忍|谨慎/.test(baselineText);
    const explosiveEvidence = /怒吼|失控|冲上|不顾|暴起|冲动|莽撞/.test(joinedEvidence);
    if (asksBehaviorCheck && calmBaseline && explosiveEvidence) {
      if (evidenceProfile.hasPressureSupport) {
        deviations.push({ severity: 'warning', dimension: 'behavior', message: '当前强烈表现与克制型人设存在轻微张力，但已有近期状态、剧情事件或冲突关系边提供转折支撑。', evidence: this.compactText(joinedEvidence, 240), suggestion: '保留强烈行为时，建议补足过渡，并在正文中显式呈现压抑、被迫、权衡或关系冲突触发点，避免读者感到突兀。' });
      } else {
        deviations.push({ severity: 'warning', dimension: 'behavior', message: '当前表现可能偏离“克制/冷静/隐忍”的既有人设，且缺少关系或状态证据支撑转折。', evidence: this.compactText(joinedEvidence, 220), suggestion: '保留强烈情绪，但增加压抑、停顿、权衡、外部压力或被迫爆发的过渡。' });
      }
    }

    if (instruction && /动机|目标|为什么|突兀|转折/.test(instruction) && !this.hasBaselineFact(baseline, '主要动机')) {
      deviations.push({ severity: 'warning', dimension: 'motivation', message: '缺少角色主要动机基线，无法判断当前选择是否符合长期目标。', suggestion: '先补充角色 motivation，或在当前章节中明确其行动目标与代价。' });
    }
    if (instruction && /关系|对峙|背叛|冲突|转折/.test(instruction) && !evidenceProfile.hasRelationshipEvidence && evidenceProfile.hasPlotEvidence) {
      deviations.push({ severity: 'warning', dimension: 'relationship', message: '存在相关剧情事件，但缺少关系图边或近期状态来解释角色互动变化。', suggestion: '召回 relationship_graph 或补充角色近期状态，确认对峙、背叛或和解是否有铺垫。' });
    }
    if (constraints.some((item) => item.includes('未关闭校验问题'))) {
      deviations.push({ severity: 'info', dimension: 'existing_validation', message: '上下文中已有未关闭校验问题，建议与本次角色检查一起复核。', evidence: constraints.find((item) => item.includes('未关闭校验问题')) });
    }
    if (constraints.some((item) => /locked facts|不得覆盖|锁定/.test(item)) || evidence.some((item) => item.includes('锁定事实边界'))) {
      deviations.push({ severity: 'info', dimension: 'fact_boundary', message: '存在 locked facts 或世界观边界，角色修稿时不得为解释人设转折而覆盖既有事实。', evidence: constraints.find((item) => /locked facts|不得覆盖|锁定/.test(item)) });
    }
    return deviations;
  }

  private relatedRelationshipEdges(relationshipGraph: Array<Record<string, unknown>>, characterName: string): Array<Record<string, unknown>> {
    if (!characterName) return [];
    return relationshipGraph.filter((edge) => this.text(edge.source) === characterName || this.text(edge.target) === characterName).slice(0, 6);
  }

  private relatedPlotEvents(plotEvents: Array<Record<string, unknown>>, characterName: string): Array<Record<string, unknown>> {
    if (!characterName) return [];
    return plotEvents.filter((event) => {
      const participants = this.asArray(event.participants).map((item) => this.text(item) || this.text(this.asRecord(item).name));
      return participants.includes(characterName) || this.text(event.description).includes(characterName) || this.text(event.title).includes(characterName);
    }).slice(0, 6);
  }

  private hasBaselineFact(baseline: string[], label: string): boolean {
    return baseline.some((item) => item.startsWith(`${label}：`) && !item.endsWith('未记录'));
  }

  private isConflictEdge(edge: Record<string, unknown>): boolean {
    return edge.conflict === true || this.text(edge.relationType) === 'conflict' || /冲突|敌对|背叛|对峙|争执|攻击|决裂/.test(this.text(edge.evidence));
  }

  private buildVerdict(deviations: CharacterConsistencyCheckOutput['deviations'], character: Record<string, unknown>): CharacterConsistencyCheckOutput['verdict'] {
    const hasError = deviations.some((item) => item.severity === 'error');
    const hasWarning = deviations.some((item) => item.severity === 'warning');
    if (hasError) return { status: 'likely_break', summary: `${this.text(character.name) || '目标角色'}存在高风险人设偏离，建议先修稿再继续。`, needsRevision: true };
    if (hasWarning) return { status: 'minor_drift', summary: `${this.text(character.name) || '目标角色'}存在轻微或待确认偏差，建议补充过渡或动机解释。`, needsRevision: true };
    return { status: 'consistent', summary: `${this.text(character.name) || '目标角色'}暂未发现明显人设崩坏。`, needsRevision: false };
  }

  private buildSuggestions(deviations: CharacterConsistencyCheckOutput['deviations']): string[] {
    const suggestions = deviations.map((item) => item.suggestion).filter((item): item is string => Boolean(item));
    return suggestions.length ? suggestions : ['保持角色既有动机、说话风格和近期状态；如需增强冲突，优先增加外部压力而非突兀改变性格。'];
  }

  private formatFact(label: string, value: unknown): string | undefined {
    const text = this.text(value);
    return text ? `${label}：${text}` : undefined;
  }

  private compactText(value: unknown, maxLength: number): string {
    const text = this.text(value).replace(/\s+/g, ' ').trim();
    return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }
}