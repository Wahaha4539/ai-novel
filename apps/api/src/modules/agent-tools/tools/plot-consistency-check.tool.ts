import { Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';
import { LlmGatewayService } from '../../llm/llm-gateway.service';

interface PlotConsistencyCheckInput {
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

interface PlotConsistencyCheckOutput {
  scope: {
    chapterCount: number;
    plotEventCount: number;
    relationshipEdgeCount: number;
  };
  evidence: {
    outlineEvidence: string[];
    eventTimeline: string[];
    foreshadowEvidence: string[];
    motivationEvidence: string[];
    lockedFactEvidence: string[];
  };
  deviations: Array<{
    severity: 'info' | 'warning' | 'error';
    dimension: 'outline' | 'event_order' | 'foreshadowing' | 'motivation' | 'fact_conflict' | 'context';
    message: string;
    evidence?: string;
    suggestion?: string;
  }>;
  verdict: {
    status: 'consistent' | 'needs_review' | 'likely_conflict';
    summary: string;
    needsRevision: boolean;
  };
  suggestions: string[];
  llmEvidenceSummary?: LlmEvidenceSummary;
}

/**
 * 剧情一致性只读检查工具：基于 collect_task_context 的章节、大纲、剧情事件、关系图和约束做确定性诊断。
 * 默认完全 deterministic；仅在实验开关显式开启时调用 LLM 做只读证据归纳，失败会自动降级且不改变诊断结论。
 */
@Injectable()
export class PlotConsistencyCheckTool implements BaseTool<PlotConsistencyCheckInput, PlotConsistencyCheckOutput> {
  name = 'plot_consistency_check';
  description = '只读检查大纲矛盾、事件顺序、伏笔回收和角色动机断裂风险。';
  inputSchema = {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      taskContext: { type: 'object' as const },
      focusText: { type: 'string' as const },
      instruction: { type: 'string' as const },
      experimentalLlmEvidenceSummary: { type: 'boolean' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['scope', 'evidence', 'deviations', 'verdict', 'suggestions'],
    properties: {
      scope: { type: 'object' as const },
      evidence: { type: 'object' as const },
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
    displayName: '检查剧情一致性',
    description: '根据 collect_task_context 收集到的大纲、剧情事件、角色动机、关系图、世界事实和未关闭校验问题，输出只读剧情一致性诊断。',
    whenToUse: ['用户询问“当前大纲有没有矛盾”', '需要检查事件顺序、时间线前后矛盾、伏笔是否回收', '需要判断角色动机是否支撑当前剧情转折'],
    whenNotToUse: ['用户要求直接重写、润色或续写章节时，应使用章节写作/润色链路', '缺少 collect_task_context 输出时，不要只凭空判断剧情矛盾', '需要写入或修改世界观设定时，应使用世界观预览/校验/持久化工具链'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      taskContext: { source: 'previous_step', description: '来自 collect_task_context 的输出，需包含 chapters、plotEvents、characters、relationshipGraph、constraints 等字段。' },
      focusText: { source: 'context', description: '用户选中的大纲/正文片段；若有选区，优先作为当前剧情证据。' },
      instruction: { source: 'user_message', description: '保留用户原始检查重点，例如“当前大纲有没有矛盾”“伏笔是否回收”。' },
      experimentalLlmEvidenceSummary: { source: 'runtime', description: '默认关闭的只读实验开关；Planner 不应主动开启，仅由运行时/评测显式启用。' },
    },
    examples: [
      {
        user: '当前大纲有没有矛盾？',
        plan: [
          { tool: 'collect_task_context', args: { taskType: 'plot_consistency_check', focus: ['plot_facts', 'relationship_graph', 'world_facts', 'memory_chunks'] } },
          { tool: 'plot_consistency_check', args: { taskContext: '{{steps.collect_task_context.output}}', instruction: '当前大纲有没有矛盾？' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: [], allowedSources: ['collect_task_context.output', 'steps.collect_task_context.output', 'context.selectedText'] },
  };

  constructor(private readonly llm?: LlmGatewayService) {}

  async run(args: PlotConsistencyCheckInput, _context: ToolContext): Promise<PlotConsistencyCheckOutput> {
    const taskContext = this.asRecord(args.taskContext);
    const chapters = this.asArray(taskContext.chapters).map((item) => this.asRecord(item));
    const plotEvents = this.asArray(taskContext.plotEvents).map((item) => this.asRecord(item));
    const characters = this.asArray(taskContext.characters).map((item) => this.asRecord(item));
    const relationshipGraph = this.asArray(taskContext.relationshipGraph).map((item) => this.asRecord(item));
    const worldFacts = this.asArray(taskContext.worldFacts).map((item) => this.asRecord(item));
    const lockedFacts = worldFacts.filter((fact) => fact.locked === true || this.text(fact.status) === 'locked');
    const constraints = this.asArray(taskContext.constraints).filter((item): item is string => typeof item === 'string');

    const evidence = {
      outlineEvidence: this.buildOutlineEvidence(chapters, args.focusText),
      eventTimeline: this.buildEventTimeline(plotEvents),
      foreshadowEvidence: this.buildForeshadowEvidence(chapters, constraints),
      motivationEvidence: this.buildMotivationEvidence(characters, relationshipGraph),
      lockedFactEvidence: this.buildLockedFactEvidence(lockedFacts, constraints),
    };
    const deviations = this.buildDeviations(chapters, plotEvents, characters, constraints, relationshipGraph, lockedFacts, evidence, args.instruction, args.focusText);
    const deterministicOutput = {
      scope: { chapterCount: chapters.length, plotEventCount: plotEvents.length, relationshipEdgeCount: relationshipGraph.length },
      evidence,
      deviations,
      verdict: this.buildVerdict(deviations),
      suggestions: this.buildSuggestions(deviations),
    };
    const llmEvidenceSummary = await this.maybeSummarizeEvidence(this.isEvidenceSummaryEnabled(args.experimentalLlmEvidenceSummary), deterministicOutput, args.instruction);

    return {
      ...deterministicOutput,
      ...(llmEvidenceSummary ? { llmEvidenceSummary } : {}),
    };
  }

  /**
   * 默认关闭的 LLM 证据归纳实验：只读压缩剧情证据。
   * LLM 失败或不可用时只返回 fallback 标记，确定性 deviations/verdict/suggestions 保持不变。
   */
  private async maybeSummarizeEvidence(enabled: boolean | undefined, output: Omit<PlotConsistencyCheckOutput, 'llmEvidenceSummary'>, instruction?: string): Promise<LlmEvidenceSummary | undefined> {
    if (!enabled) return undefined;
    if (!this.llm) return { status: 'fallback', fallbackUsed: true, error: 'LLM evidence summary gateway unavailable' };
    try {
      const response = await this.llm.chatJson<{ summary?: string; keyFindings?: string[] }>([
        { role: 'system', content: '你是小说剧情质检助手。只基于输入的确定性诊断做证据归纳，输出 JSON，不新增事实、不提出写库动作。' },
        { role: 'user', content: JSON.stringify({ task: 'plot_consistency_evidence_summary', instruction, deterministicReport: output }) },
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

  /** 实验能力默认关闭；开启后也只追加摘要字段，失败会由 maybeSummarizeEvidence 降级为 deterministic。 */
  private isEvidenceSummaryEnabled(inputFlag?: boolean): boolean {
    return inputFlag === true || process.env.AGENT_EXPERIMENTAL_LLM_EVIDENCE_SUMMARY === 'true';
  }

  /** 汇总章节目标、冲突、梗概和用户选区，作为“大纲是否自洽”的主要证据。 */
  private buildOutlineEvidence(chapters: Array<Record<string, unknown>>, focusText?: string): string[] {
    const selected = focusText?.trim() ? [`选中文本：${this.compactText(focusText, 300)}`] : [];
    const chapterEvidence = chapters.map((chapter) => this.compactText(`第${this.text(chapter.chapterNo) || '?'}章《${this.text(chapter.title) || '未命名'}》：目标=${this.text(chapter.objective) || '未记录'}；冲突=${this.text(chapter.conflict) || '未记录'}；梗概=${this.text(chapter.outline) || '未记录'}`, 260));
    return [...selected, ...chapterEvidence].filter(Boolean).slice(0, 12);
  }

  private buildEventTimeline(plotEvents: Array<Record<string, unknown>>): string[] {
    return plotEvents.map((event) => {
      const participants = this.asArray(event.participants).map((item) => this.text(item) || this.text(this.asRecord(item).name)).filter(Boolean).join('、');
      return this.compactText(`第${this.text(event.chapterNo) || '?'}章 / 序号${this.text(event.timelineSeq) || '?'}：${this.text(event.title) || '未命名事件'}${participants ? `（${participants}）` : ''} — ${this.text(event.description)}`, 260);
    }).slice(0, 15);
  }

  private buildForeshadowEvidence(chapters: Array<Record<string, unknown>>, constraints: string[]): string[] {
    const chapterHints = chapters.flatMap((chapter) => [chapter.foreshadowPlan, chapter.revealPoints, chapter.outline]
      .map((value) => this.text(value))
      .filter((value) => /伏笔|回收|揭示|暗线|埋下/.test(value))
      .map((value) => this.compactText(`第${this.text(chapter.chapterNo) || '?'}章：${value}`, 220)));
    const constraintHints = constraints.filter((item) => /伏笔|回收|暗线/.test(item)).map((item) => this.compactText(item, 220));
    return [...chapterHints, ...constraintHints].slice(0, 10);
  }

  private buildMotivationEvidence(characters: Array<Record<string, unknown>>, relationshipGraph: Array<Record<string, unknown>>): string[] {
    const characterEvidence = characters.map((character) => this.compactText(`${this.text(character.name) || '未命名角色'}：动机=${this.text(character.motivation) || '未记录'}；性格=${this.text(character.personalityCore) || '未记录'}`, 180));
    const relationshipEvidence = relationshipGraph.map((edge) => {
      const relationType = this.text(edge.relationType) || '关系证据';
      const conflictLabel = this.isConflictEdge(edge) ? '冲突关系' : relationType;
      return this.compactText(`${this.text(edge.source)}${edge.target ? ` → ${this.text(edge.target)}` : ''}（${conflictLabel}）：${this.text(edge.evidence)}`, 200);
    });
    return [...characterEvidence, ...relationshipEvidence].filter(Boolean).slice(0, 12);
  }

  /** 汇总 locked facts 和相关约束，供事实冲突判断和 Artifact 报告解释使用。 */
  private buildLockedFactEvidence(lockedFacts: Array<Record<string, unknown>>, constraints: string[]): string[] {
    const facts = lockedFacts.map((fact) => this.compactText(`${this.text(fact.title) || '未命名锁定事实'}：${this.text(fact.summary) || this.text(fact.content) || '未记录内容'}`, 220));
    const constraintHints = constraints.filter((item) => /locked facts|不得覆盖|锁定|已确认剧情事实/.test(item)).map((item) => this.compactText(item, 220));
    return [...facts, ...constraintHints].filter(Boolean).slice(0, 10);
  }

  private buildDeviations(chapters: Array<Record<string, unknown>>, plotEvents: Array<Record<string, unknown>>, characters: Array<Record<string, unknown>>, constraints: string[], relationshipGraph: Array<Record<string, unknown>>, lockedFacts: Array<Record<string, unknown>>, evidence: PlotConsistencyCheckOutput['evidence'], instruction?: string, focusText?: string): PlotConsistencyCheckOutput['deviations'] {
    const deviations: PlotConsistencyCheckOutput['deviations'] = [];
    if (!chapters.length) {
      deviations.push({ severity: 'warning', dimension: 'context', message: '缺少章节/大纲上下文，无法高置信判断大纲矛盾。', suggestion: '先运行 collect_task_context，并确保章节范围覆盖待检查的大纲。' });
    }
    if (!plotEvents.length) {
      deviations.push({ severity: 'warning', dimension: 'context', message: '缺少剧情事件证据，事件顺序与因果链只能基于章节梗概粗略判断。', suggestion: '先抽取或召回 StoryEvent，再进行严格剧情一致性检查。' });
    }

    const timelineBreak = this.findTimelineBreak(plotEvents);
    if (timelineBreak) {
      deviations.push({ severity: 'error', dimension: 'event_order', message: '发现剧情事件时间线或章节顺序倒置风险。', evidence: timelineBreak, suggestion: '复核相关事件的 chapterNo/timelineSeq，并调整事件顺序或补充倒叙说明。' });
    }

    const knownChapterNos = new Set(chapters.map((chapter) => Number(chapter.chapterNo)).filter((value) => Number.isFinite(value)));
    const orphanEvent = plotEvents.find((event) => Number.isFinite(Number(event.chapterNo)) && knownChapterNos.size > 0 && !knownChapterNos.has(Number(event.chapterNo)));
    if (orphanEvent) {
      deviations.push({ severity: 'warning', dimension: 'event_order', message: '剧情事件指向的章节未出现在本次召回范围内，可能导致前后因果缺口。', evidence: this.compactText(`${this.text(orphanEvent.title)} / chapterNo=${this.text(orphanEvent.chapterNo)}`, 160), suggestion: '扩大章节范围或确认事件所属章节是否正确。' });
    }

    const incompleteOutline = chapters.find((chapter) => !this.text(chapter.outline) && !this.text(chapter.objective) && !this.text(chapter.conflict));
    if (incompleteOutline) {
      deviations.push({ severity: 'warning', dimension: 'outline', message: '部分章节缺少目标、冲突或梗概，难以判断大纲自洽性。', evidence: `第${this.text(incompleteOutline.chapterNo) || '?'}章《${this.text(incompleteOutline.title) || '未命名'}》`, suggestion: '先补齐章节目标/冲突/梗概，再检查跨章矛盾。' });
    }

    if (instruction && /伏笔|回收|暗线/.test(instruction) && !evidence.foreshadowEvidence.length) {
      deviations.push({ severity: 'warning', dimension: 'foreshadowing', message: '本次上下文没有明确伏笔/回收证据，无法确认伏笔是否闭环。', suggestion: '补充 foreshadowPlan、revealPoints 或 ForeshadowTrack 召回后再复核。' });
    }
    const foreshadowStatus = this.assessForeshadowStatus(evidence.foreshadowEvidence);
    if (instruction && /伏笔|回收|暗线/.test(instruction) && foreshadowStatus.hasSetup && !foreshadowStatus.hasPayoff) {
      deviations.push({ severity: 'warning', dimension: 'foreshadowing', message: '发现伏笔铺设证据，但缺少明确回收/揭示证据。', evidence: evidence.foreshadowEvidence[0], suggestion: '补充回收章节、揭示点或说明该伏笔仍处于待回收状态。' });
    }

    const motivationRisk = this.assessMotivationRisk(characters, plotEvents, relationshipGraph, instruction);
    if (motivationRisk) {
      deviations.push(motivationRisk);
    }

    const lockedFactConflict = this.findLockedFactConflict(lockedFacts, chapters, plotEvents, focusText);
    if (lockedFactConflict) {
      deviations.push({ severity: 'error', dimension: 'fact_conflict', message: '发现疑似推翻或覆盖 locked fact 的剧情表达。', evidence: lockedFactConflict, suggestion: '保留 locked fact 不变，改为增量解释、误会、局部例外或角色认知偏差。' });
    }

    if (constraints.some((item) => item.includes('未关闭校验问题'))) {
      deviations.push({ severity: 'info', dimension: 'fact_conflict', message: '上下文中已有未关闭校验问题，建议与剧情一致性检查一起复核。', evidence: constraints.find((item) => item.includes('未关闭校验问题')) });
    }
    if (evidence.lockedFactEvidence.length || constraints.some((item) => /locked facts|不得覆盖|锁定/.test(item))) {
      deviations.push({ severity: 'info', dimension: 'fact_conflict', message: '存在 locked facts 或世界观边界约束，剧情调整时不得覆盖既有事实。', evidence: constraints.find((item) => /locked facts|不得覆盖|锁定/.test(item)) });
    }
    return deviations;
  }

  /** 将“铺设”和“回收”拆开判断，避免有伏笔关键词就误判为已闭环。 */
  private assessForeshadowStatus(foreshadowEvidence: string[]): { hasSetup: boolean; hasPayoff: boolean } {
    const combined = foreshadowEvidence.join('\n');
    return {
      hasSetup: /伏笔|埋下|暗线|铺垫/.test(combined),
      hasPayoff: /回收|揭示|揭露|兑现|解释|真相/.test(combined),
    };
  }

  /** 基于角色动机、冲突剧情事件和关系边判断“证据不足”，有冲突关系边时视为已有较强支撑。 */
  private assessMotivationRisk(characters: Array<Record<string, unknown>>, plotEvents: Array<Record<string, unknown>>, relationshipGraph: Array<Record<string, unknown>>, instruction?: string): PlotConsistencyCheckOutput['deviations'][number] | undefined {
    const asksMotivation = Boolean(instruction && /动机|人设|断裂|突兀|转折/.test(instruction));
    const hasTurnEvent = plotEvents.some((event) => /冲突|背叛|反转|转折|对峙|攻击|决裂/.test(`${this.text(event.eventType)} ${this.text(event.title)} ${this.text(event.description)}`));
    if (!asksMotivation && !hasTurnEvent) return undefined;

    const hasCharacterMotivation = characters.some((character) => this.text(character.motivation) && this.text(character.motivation) !== '未记录');
    const hasRelationshipSupport = relationshipGraph.some((edge) => this.text(edge.evidence) && (Boolean(edge.target) || this.isConflictEdge(edge)));
    if (!hasCharacterMotivation) {
      return { severity: 'warning', dimension: 'motivation', message: '角色动机基线不足，无法确认剧情转折是否符合人物目标。', suggestion: '补充角色 motivation、近期状态或转折前铺垫后再复核。' };
    }
    if (hasTurnEvent && !hasRelationshipSupport) {
      return { severity: 'warning', dimension: 'motivation', message: '存在冲突/转折事件，但缺少可支撑动机变化的关系边或近期状态证据。', evidence: plotEvents.find((event) => /冲突|背叛|反转|转折|对峙|攻击|决裂/.test(`${this.text(event.eventType)} ${this.text(event.title)} ${this.text(event.description)}`))?.title as string | undefined, suggestion: '召回关系图、角色近期状态或在转折前增加可见铺垫。' };
    }
    return undefined;
  }

  /** locked fact 只有在被明确提及且伴随覆盖/推翻类意图时才升为 error，降低普通引用的误报率。 */
  private findLockedFactConflict(lockedFacts: Array<Record<string, unknown>>, chapters: Array<Record<string, unknown>>, plotEvents: Array<Record<string, unknown>>, focusText?: string): string | undefined {
    if (!lockedFacts.length) return undefined;
    const storyTexts = [
      focusText,
      ...chapters.flatMap((chapter) => [chapter.title, chapter.objective, chapter.conflict, chapter.outline, chapter.latestDraftExcerpt, chapter.latestDraftContent]),
      ...plotEvents.flatMap((event) => [event.title, event.description]),
    ].map((item) => this.text(item)).filter(Boolean);

    for (const fact of lockedFacts) {
      const title = this.text(fact.title);
      if (!title) continue;
      const matchedText = storyTexts.find((text) => text.includes(title) && /覆盖|推翻|改写|替换|废除|不再成立|解除|无效/.test(text));
      if (matchedText) return this.compactText(`${title}：${matchedText}`, 240);
    }
    return undefined;
  }

  private isConflictEdge(edge: Record<string, unknown>): boolean {
    return edge.conflict === true || this.text(edge.relationType) === 'conflict' || /冲突|敌对|背叛|对峙|争执|攻击|决裂/.test(this.text(edge.evidence));
  }

  /** 仅在相邻事件都具备数值型顺序信息时判断倒置，避免把缺失字段误报为矛盾。 */
  private findTimelineBreak(plotEvents: Array<Record<string, unknown>>): string | undefined {
    let previous: { order: number; label: string } | undefined;
    for (const event of plotEvents) {
      const order = this.numericOrder(event);
      if (order === undefined) continue;
      const label = `${this.text(event.title) || '未命名事件'}(chapterNo=${this.text(event.chapterNo) || '?'}, timelineSeq=${this.text(event.timelineSeq) || '?'})`;
      if (previous && order < previous.order) return `${previous.label} → ${label}`;
      previous = { order, label };
    }
    return undefined;
  }

  private numericOrder(event: Record<string, unknown>): number | undefined {
    const timelineSeq = Number(event.timelineSeq);
    if (Number.isFinite(timelineSeq)) return timelineSeq;
    const chapterNo = Number(event.chapterNo);
    return Number.isFinite(chapterNo) ? chapterNo : undefined;
  }

  private buildVerdict(deviations: PlotConsistencyCheckOutput['deviations']): PlotConsistencyCheckOutput['verdict'] {
    const hasError = deviations.some((item) => item.severity === 'error');
    const hasWarning = deviations.some((item) => item.severity === 'warning');
    if (hasError) return { status: 'likely_conflict', summary: '剧情存在较高风险矛盾，建议先修正时间线或因果链再继续创作。', needsRevision: true };
    if (hasWarning) return { status: 'needs_review', summary: '剧情暂未发现硬冲突，但存在证据不足或需复核的连续性风险。', needsRevision: true };
    return { status: 'consistent', summary: '基于当前召回上下文，暂未发现明显大纲矛盾、事件倒置或动机断裂。', needsRevision: false };
  }

  private buildSuggestions(deviations: PlotConsistencyCheckOutput['deviations']): string[] {
    const suggestions = deviations.map((item) => item.suggestion).filter((item): item is string => Boolean(item));
    return suggestions.length ? suggestions : ['保持章节目标、事件顺序、伏笔回收和角色动机一致；如要制造反转，应增加明确铺垫或倒叙标记。'];
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