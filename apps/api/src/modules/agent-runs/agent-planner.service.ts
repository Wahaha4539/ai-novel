import { Injectable, Optional } from '@nestjs/common';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { SkillRegistryService } from '../agent-skills/skill-registry.service';
import { ImportAssetType, IMPORT_ASSET_TYPES } from '../agent-tools/tools/import-preview.types';
import type { ToolJsonSchema } from '../agent-tools/base-tool';
import type { ToolManifestExample, ToolManifestForPlanner, ToolParameterHint } from '../agent-tools/tool-manifest.types';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../llm/llm-timeout.constants';
import { AgentContextV2 } from './agent-context-builder.service';
import type { ImportPreviewModeDto } from './dto/create-agent-plan.dto';
import { AgentPlannerGraphService } from './planner-graph/agent-planner-graph.service';
import { classifyIntentNode, createSelectToolBundleNode } from './planner-graph/nodes';
import { PlanValidatorService } from './planner-graph/plan-validator.service';
import {
  appendPlannerGraphNode,
  createAgentPlannerGraphInitialState,
  type AgentPlannerGraphState,
  type RouteDecision,
  type SelectedToolBundle,
} from './planner-graph/planner-graph.state';
import { ToolBundleRegistry } from './planner-graph/tool-bundles';

export interface AgentPlanStepSpec {
  id?: string;
  stepNo: number;
  name: string;
  purpose?: string;
  tool: string;
  mode: 'act';
  requiresApproval: boolean;
  args: Record<string, unknown>;
  dependsOn?: string[];
  produces?: string[];
  runIf?: AgentStepCondition;
  onFailure?: { strategy: 'replan' | 'ask_user' | 'fail_fast' | 'skip'; reason: string };
}

export interface AgentStepCondition {
  ref: string;
  operator: 'exists' | 'not_exists' | 'truthy' | 'falsy' | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte';
  value?: unknown;
}

export interface AgentPlanSpec {
  schemaVersion?: 2;
  understanding?: string;
  userGoal?: string;
  taskType: string;
  confidence?: number;
  summary: string;
  assumptions: string[];
  missingInfo?: Array<{ field: string; reason: string; canResolveByTool: boolean; resolverTool?: string }>;
  requiredContext?: Array<{ name: string; reason: string; source: 'agent_context' | 'resolver' | 'tool' | 'user' }>;
  risks: string[];
  steps: AgentPlanStepSpec[];
  requiredApprovals: Record<string, unknown>[];
  riskReview?: { riskLevel: 'low' | 'medium' | 'high'; reasons: string[]; requiresApproval: boolean; approvalMessage: string };
  userVisiblePlan?: { summary: string; bullets: string[]; hiddenTechnicalSteps?: boolean };
  plannerDiagnostics?: Record<string, unknown>;
}

interface PlannerLlmBudget {
  used: number;
  max: number;
  failures: Array<{ stage: string; message: string }>;
}

interface PlannerOutputDefaults {
  taskType: string;
  summary: string;
  assumptions: string[];
  risks: string[];
}

const AGENT_PLANNER_MAX_TOKENS = 12000;

export interface AgentPlanWithToolsInput {
  goal: string;
  context?: AgentContextV2;
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
  selectedTools: ToolManifestForPlanner[];
}

interface PlannerToolScope {
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
  selectedTools?: ToolManifestForPlanner[];
}

type AgentContextPromptPayload = Omit<AgentContextV2, 'availableTools'>;

interface PlannerPromptToolManifest extends Omit<ToolManifestForPlanner, 'inputSchema' | 'outputSchema' | 'parameterHints' | 'examples'> {
  inputSchema?: ToolJsonSchema;
  outputFields?: string[];
  parameterHints?: Record<string, ToolParameterHint>;
  examples?: ToolManifestExample[];
}

const IMPORT_TARGET_TOOL_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: 'generate_import_project_profile_preview',
  outline: 'generate_import_outline_preview',
  characters: 'generate_import_characters_preview',
  worldbuilding: 'generate_import_worldbuilding_preview',
  writingRules: 'generate_import_writing_rules_preview',
};

const IMPORT_TARGET_ASSET_BY_TOOL = new Map<string, ImportAssetType>(
  Object.entries(IMPORT_TARGET_TOOL_BY_ASSET_TYPE).map(([assetType, tool]) => [tool, assetType as ImportAssetType]),
);

const BUILD_IMPORT_BRIEF_TOOL = 'build_import_brief';
const CROSS_TARGET_CONSISTENCY_CHECK_TOOL = 'cross_target_consistency_check';
const GENERATE_OUTLINE_PREVIEW_TOOL = 'generate_outline_preview';
const GENERATE_VOLUME_OUTLINE_PREVIEW_TOOL = 'generate_volume_outline_preview';
const GENERATE_STORY_UNITS_PREVIEW_TOOL = 'generate_story_units_preview';
const GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL = 'generate_chapter_outline_preview';
const MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL = 'merge_chapter_outline_previews';
const SEGMENT_CHAPTER_OUTLINE_BATCHES_TOOL = 'segment_chapter_outline_batches';
const GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL = 'generate_chapter_outline_batch_preview';
const MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL = 'merge_chapter_outline_batch_previews';
const PERSIST_VOLUME_OUTLINE_TOOL = 'persist_volume_outline';
const PERSIST_STORY_UNITS_TOOL = 'persist_story_units';
const PERSIST_VOLUME_CHARACTER_CANDIDATES_TOOL = 'persist_volume_character_candidates';
const GENERATE_TIMELINE_PREVIEW_TOOL = 'generate_timeline_preview';
const ALIGN_CHAPTER_TIMELINE_PREVIEW_TOOL = 'align_chapter_timeline_preview';
const VALIDATE_TIMELINE_PREVIEW_TOOL = 'validate_timeline_preview';
const GENERATE_CHAPTER_CRAFT_BRIEF_PREVIEW_TOOL = 'generate_chapter_craft_brief_preview';
const VALIDATE_CHAPTER_CRAFT_BRIEF_TOOL = 'validate_chapter_craft_brief';
const AGENT_PLANNER_GRAPH_ENABLED = 'AGENT_PLANNER_GRAPH_ENABLED';
const MERGE_PREVIEW_ARG_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: 'projectProfilePreview',
  outline: 'outlinePreview',
  characters: 'charactersPreview',
  worldbuilding: 'worldbuildingPreview',
  writingRules: 'writingRulesPreview',
};

const IMPORT_TARGET_STEP_NAME_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: '生成项目资料导入预览',
  outline: '生成剧情大纲导入预览',
  characters: '生成角色导入预览',
  worldbuilding: '生成世界设定导入预览',
  writingRules: '生成写作规则导入预览',
};

export class AgentPlannerFailedError extends Error {
  constructor(message: string, readonly diagnostics: Record<string, unknown>) {
    super(message);
    this.name = 'AgentPlannerFailedError';
  }
}

/**
 * Agent Planner 负责把用户自然语言目标转换为受控 JSON Plan。
 * taskType 和步骤编排由 LLM 根据用户目标与 Tool Schema 决定；后端只校验工具白名单、审批和引用边界。
 */
@Injectable()
export class AgentPlannerService {
  constructor(
    private readonly skills: SkillRegistryService,
    private readonly tools: ToolRegistryService,
    private readonly rules: RuleEngineService,
    private readonly llm: LlmGatewayService,
    @Optional() private readonly plannerGraph?: AgentPlannerGraphService,
    @Optional() private readonly planValidator?: PlanValidatorService,
  ) {}

  async createPlan(goal: string, context?: AgentContextV2): Promise<AgentPlanSpec> {
    const defaults = this.createOutputDefaults(goal);
    const llmBudget: PlannerLlmBudget = { used: 0, max: this.rules.getPolicy().limits.maxLlmCalls, failures: [] };
    try {
      if (this.isGraphPlannerEnabled()) return await this.createGraphWrappedPlan(goal, defaults, llmBudget, context);
      return await this.createLlmPlan(goal, defaults, llmBudget, context);
    } catch (error) {
      if (error instanceof AgentPlannerFailedError) throw error;
      const failures = [...llmBudget.failures, this.failureDetail('planner_failed', error)];
      const diagnostics = { llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, failures };
      throw new AgentPlannerFailedError(`Agent Planner 生成高质量计划失败：${JSON.stringify(diagnostics)}`, diagnostics);
    }
  }

  /** 只提供非语义字段的默认展示文案，不参与 taskType 判定，也不会作为可执行计划回退。 */
  private createOutputDefaults(goal: string): PlannerOutputDefaults {
    return {
      taskType: 'general',
      summary: `处理目标：${goal}`,
      assumptions: ['Plan 阶段只生成可审批计划和只读预览。'],
      risks: this.rules.listHardRules(),
    };
  }

  async createPlanWithTools(input: AgentPlanWithToolsInput): Promise<AgentPlanSpec> {
    const defaults = this.createOutputDefaults(input.goal);
    const llmBudget: PlannerLlmBudget = { used: 0, max: this.rules.getPolicy().limits.maxLlmCalls, failures: [] };
    try {
      return await this.createLlmPlan(input.goal, defaults, llmBudget, input.context, {
        route: input.route,
        selectedBundle: input.selectedBundle,
        selectedTools: input.selectedTools,
      });
    } catch (error) {
      const failures = [...llmBudget.failures, this.failureDetail('planner_failed', error)];
      const diagnostics = { llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, failures, ...this.plannerScopeDiagnostics(input) };
      throw new AgentPlannerFailedError(`Agent Planner 生成高质量计划失败：${JSON.stringify(diagnostics)}`, diagnostics);
    }
  }

  private isGraphPlannerEnabled(): boolean {
    const rawValue = process.env[AGENT_PLANNER_GRAPH_ENABLED];
    const value = rawValue?.trim().toLowerCase();
    if (value) return value === '1' || value === 'true' || value === 'yes' || value === 'on';
    if (rawValue !== undefined) return false;
    return process.env.NODE_ENV?.trim().toLowerCase() !== 'production';
  }

  private async createGraphWrappedPlan(goal: string, defaults: PlannerOutputDefaults, llmBudget: PlannerLlmBudget, context?: AgentContextV2): Promise<AgentPlanSpec> {
    let graphState = createAgentPlannerGraphInitialState({ goal, context, defaults });
    graphState = this.mergeGraphState(graphState, await classifyIntentNode(graphState));
    this.requireGraphRoute(graphState);

    const registry = new ToolBundleRegistry(this.tools);
    graphState = this.mergeGraphState(graphState, await createSelectToolBundleNode(registry)(graphState));
    const selectedRoute = this.requireGraphRoute(graphState);
    if (!graphState.selectedBundle || !graphState.selectedTools?.length) {
      throw new Error(`Agent Planner Graph selected no tools for route ${selectedRoute.domain}:${selectedRoute.intent}`);
    }

    const plan = await this.createLlmPlan(goal, defaults, llmBudget, context, {
      route: graphState.route,
      selectedBundle: graphState.selectedBundle,
      selectedTools: graphState.selectedTools,
    });
    graphState = this.mergeGraphState(graphState, {
      plan,
      diagnostics: appendPlannerGraphNode(graphState.diagnostics, {
        name: 'domainPlanner',
        status: 'ok',
        detail: `${graphState.selectedBundle.bundleName} plan=${plan.taskType}`,
      }),
    });
    return this.withGraphDiagnostics(plan, graphState);
  }

  private mergeGraphState(state: AgentPlannerGraphState, update: Partial<AgentPlannerGraphState>): AgentPlannerGraphState {
    return { ...state, ...update, diagnostics: update.diagnostics ?? state.diagnostics };
  }

  private requireGraphRoute(state: AgentPlannerGraphState): RouteDecision {
    if (!state.route) throw new Error('Agent Planner Graph did not classify a route');
    if (state.route.ambiguity?.needsClarification || state.route.confidence < 0.5) {
      const questions = state.route.ambiguity?.questions?.join('; ') || 'Please clarify the creative task type.';
      throw new Error(`Agent Planner Graph route needs clarification for ${state.route.domain}:${state.route.intent}: ${questions}`);
    }
    return state.route;
  }

  private withGraphDiagnostics(plan: AgentPlanSpec, graphState: AgentPlannerGraphState): AgentPlanSpec {
    const legacyDiagnostics = plan.plannerDiagnostics ?? {};
    const scopeDiagnostics = this.plannerScopeDiagnostics({
      route: graphState.route,
      selectedBundle: graphState.selectedBundle,
      selectedTools: graphState.selectedTools,
    });
    const graphPromptBudget = this.removeUndefinedArgs({
      selectedToolsChars: graphState.diagnostics.selectedToolsChars,
      allToolsChars: graphState.diagnostics.allToolsChars,
    });
    const promptBudget = this.mergeDiagnosticsObjects(
      this.asOptionalRecord(legacyDiagnostics.promptBudget),
      this.asOptionalRecord(scopeDiagnostics.promptBudget),
      Object.keys(graphPromptBudget).length ? graphPromptBudget : undefined,
    );
    return {
      ...plan,
      plannerDiagnostics: {
        ...legacyDiagnostics,
        ...scopeDiagnostics,
        source: 'langgraph_supervisor',
        legacySource: legacyDiagnostics.source,
        graphVersion: graphState.diagnostics.graphVersion,
        graphNodes: graphState.diagnostics.nodes,
        ...(promptBudget ? { promptBudget } : {}),
      },
    };
  }

  private async createLlmPlan(goal: string, defaults: PlannerOutputDefaults, llmBudget: PlannerLlmBudget, context?: AgentContextV2, toolScope?: PlannerToolScope): Promise<AgentPlanSpec> {
    const tools = toolScope?.selectedTools?.length
      ? toolScope.selectedTools.map((tool) => this.compactToolManifestForPrompt(tool))
      : this.toolManifestsForPrompt();
    const promptContext = this.contextForPrompt(context, { lightweight: Boolean(toolScope?.route) });
    const availableTaskTypes = this.listTaskTypes();
    const skills = this.skills.list();
    const hardRules = this.rules.listHardRules();

    const messages = [
      {
        role: 'system' as const,
        content: [
          '你是 CreativeAgent Planner。你只能输出严格 JSON，不要 Markdown。',
          '当前用户选择的是 Agent 工作台 Plan 模式：只生成可审批计划和只读预览，不执行写入。',
          'taskType 必须由你根据 userGoal 语义判断，并且只能从 availableTaskTypes 中选择；不要依赖后端关键词分类。',
          '你不能编造工具，steps[].tool 必须来自 Available Tools。',
          '不要编造 projectId、volumeId、chapterId、characterId、draftId、lorebookEntryId、memoryChunkId。',
          '如果用户说“第十二章”“下一章”“当前章”“男主”等自然语言引用，必须先调用合适 resolver，除非 AgentContext.session 已有明确无歧义 ID。',
          '注意：outputContract.steps[].mode 是后端计划步骤字段，固定填 act；它不代表当前 UI 的 Plan/Act 开关。',
          'Plan 阶段不写正式业务表；运行时会用 mode=plan 只执行无副作用预览步骤，所有真实副作用必须等用户切到 Act 并审批后才允许。',
          '你需要根据 Available Tools 的 whenToUse/whenNotToUse/parameterHints/idPolicy 自主编排步骤和 args。',
          '导入类任务不是固定全量流程。用户指定目标产物时，build_import_preview.args.requestedAssetTypes 必须只包含用户明确要求的资产：projectProfile、outline、characters、worldbuilding、writingRules；例如只要故事大纲就只传 ["outline"]。',
          '导入类任务如果 agentContext.session.requestedAssetTypes 存在，它是最高优先级的结构化目标产物范围；只能为这些目标产物生成预览，不能因为有上传文档就扩成全套导入。',
          '导入预览模式由 agentContext.session.importPreviewMode 控制：quick 优先 build_import_preview；deep 优先分目标 generate_import_*_preview；auto 在单目标/双目标时走 deep，多目标时走 quick。',
          '导入分目标优先链路：read_source_document -> analyze_source_text -> build_import_brief（若可用） -> 按 requestedAssetTypes 调用已注册的 generate_import_*_preview 专用工具 -> merge_import_previews -> cross_target_consistency_check（若可用） -> validate_imported_assets -> persist_project_assets。',
          '如果某个 generate_import_*_preview 专用工具未出现在 Available Tools，允许 fallback 到 build_import_preview；fallback 的 requestedAssetTypes 仍必须等于用户选择的目标范围。',
          '只要导入预览未来可写入，计划中必须包含 persist_project_assets，且它必须是需要审批的写入步骤；validate_imported_assets 必须读取 merge_import_previews 或 build_import_preview 的统一预览输出。',
          '可引用上下文：{{context.session.currentProjectId}}、{{context.session.currentChapterId}}、{{context.project.defaultWordCount}}、{{context.attachments.0}}、{{context.attachments.0.url}}、{{context.session.guided.currentStep}}、{{context.session.guided.currentStepData}}。',
          '如果 agentContext.session.guided.currentStep 存在，说明用户正在创作引导页；当前步骤问答优先选择 guided_step_consultation，当前步骤生成优先选择 guided_step_generate，确认保存/写入优先选择 guided_step_finalize，不要误判成普通章节正文写作。',
          '用户只要求“卷大纲 / 第 N 卷的大纲 / 重写某卷大纲”，且没有明确说单元故事、章节细纲、拆成 N 章、章节规划或 Chapter.craftBrief 时，选择 outline_design，但只编排 inspect_project_context -> generate_volume_outline_preview -> persist_volume_outline；若 generate_volume_outline_preview 产生 newCharacterCandidates 且工具可用，还必须追加 persist_volume_character_candidates；不要生成章节细纲。',
          '用户要求“单元故事 / 支线故事 / 人物登场 / 人物情感 / 背景故事 / 丰富单元分类”时选择 outline_design，并编排 inspect_project_context -> generate_story_units_preview -> persist_story_units；只有用户明确要求同时重写/更新卷大纲时，才额外加入 persist_volume_outline 和 persist_volume_character_candidates。',
          '用户要求“章节细纲 / 第 N 卷章节细纲 / 章节规划”，且没有明确说重写卷纲、重新拆成 N 章、改变章数或从头规划时，选择 outline_design，并优先承接 inspect_project_context 中已有 Volume.narrativePlan/storyUnitPlan；chapterCount > 12 时走 segmented batch 链路，短范围才使用 generate_chapter_outline_preview（每章一个步骤）-> merge_chapter_outline_previews -> persist_outline；不要追加末尾 validate_outline，不要重新生成卷大纲或单元故事。',
          '用户要求“卷细纲 / 60 章细纲 / 等长细纲 / 拆成 N 章 / 重写章节规划 / 改变章节数”时选择 outline_design，并先重建 generate_volume_outline_preview -> generate_story_units_preview；chapterCount > 12 时走 segmented batch 链路，短范围才使用 generate_chapter_outline_preview（每章一个步骤）-> merge_chapter_outline_previews -> persist_outline；若完整 outline_preview 中含 newCharacterCandidates 且工具可用，还必须在 persist_outline 后追加 persist_volume_character_candidates；不要追加末尾 validate_outline，不要误判为 write_chapter。',
          '凡是规划 split_volume_to_chapters 且能确定 chapterCount=N，必须显式返回 N 个 generate_chapter_outline_preview 步骤，chapterNo 从 1 到 N 连续；merge_chapter_outline_previews.args.previews 必须按顺序包含这 N 个步骤的输出引用。不要省略为“批量生成”或等待后端展开。',
          'UPDATED chapter-outline batching rule overrides older single-chapter wording: for split_volume_to_chapters with chapterCount > 12, prefer inspect_project_context -> segment_chapter_outline_batches -> visible generate_chapter_outline_batch_preview steps with static chapterRange values covering 1..N -> merge_chapter_outline_batch_previews -> approval-gated persist_outline. Do not append terminal validate_outline; chapter-count/range/reference problems must be caught by PlanValidator before execution, and each batch plus merge validates generated structure. Keep every chapter number visible through the batch ranges; do not collapse the whole volume into one vague batch step.',
          'If target chapterCount=N differs from the target volume chapterCount in inspect_project_context, first rebuild upstream planning: generate_volume_outline_preview(chapterCount=N) -> generate_story_units_preview(volumeOutline={{steps.X.output.volume}}, chapterCount=N), then pass that same volumeOutline and storyUnitPlan into segment_chapter_outline_batches, every generate_chapter_outline_batch_preview, and merge_chapter_outline_batch_previews. This is a deterministic plan consistency requirement, not a creative-content judgment.',
          'For batch chapter outlines, each generate_chapter_outline_batch_preview args.chapterRange must be a concrete continuous range, normally 3-5 chapters, and all ranges must cover 1..chapterCount with no gaps, overlaps, duplicates, or out-of-range chapters. merge_chapter_outline_batch_previews.args.batchPreviews must reference every batch preview output in order.',
          'If the target agentContext.volumes entry contains chapterOutlineBatchHints, the visible generate_chapter_outline_batch_preview steps must copy those hint ranges exactly, in order. Do not replace story-unit-aware hints with uniform 4-chapter ranges.',
          '章节细纲目标章数只能来自结构化计划字段或 agentContext.volumes[].chapterCount：普通请求默认使用已审批 Volume.chapterCount 和 Volume.narrativePlan.storyUnitPlan；只有用户明确要求重拆/改成 N 章/重新规划章数时，才在结构化 args.chapterCount=N 中表达，并先重建卷纲和 storyUnitPlan。routeDecision.routeHints.contextChapterCount 只是上下文提示，不是压过计划的权威值。',
          '用户要求从全书大纲、卷大纲、章节细纲、Chapter.craftBrief 或创作引导产物生成计划时间线时选择 timeline_plan，并使用 generate_timeline_preview -> validate_timeline_preview；除非用户明确要求审批后写入，不要加入 persist_timeline_events。',
          '用户明确说“写正文 / 生成正文 / 续写正文”才选择 chapter_write 或 multi_chapter_write；用户说“拆成场景 / 场景卡 / SceneCard”时选择 scene_card_planning。',
          '用户明确说“重写章节 / 重新生成章节 / 从头写 / 推倒重来 / 不沿用旧稿”时必须使用 rewrite_chapter；不要使用 polish_chapter。',
          '可引用前序步骤：{{steps.N.output.field}} 或 {{steps.step_id.output.field}}；不要引用当前或未来步骤。',
          '章节写作或修改必须保留用户给出的风格、氛围、字数、禁改项和剧情约束，例如“别改结局”。',
        ].join('\n'),
      },
      {
        role: 'user' as const,
        content: JSON.stringify(
          {
            userGoal: goal,
            agentContext: promptContext,
            ...this.plannerScopePromptPayload(toolScope),
            currentAgentMode: 'plan',
            stepModeContract: 'steps[].mode 固定为 act；Plan/Act 运行时模式由后端 AgentRuntimeService 注入，不由 LLM 决定。',
            availableTaskTypes,
            taskTypeGuidance: {
              chapter_write: '写某一章正文、章节内容、目标字数、续写正文；若明确要求重写旧章节，应使用 rewrite_chapter。',
              multi_chapter_write: '连续生成多章正文，例如接下来三章、第 1-5 章、多个指定章节；应优先使用 write_chapter_series，不要展开多个 write_chapter。默认设置 qualityPipeline=full，除非用户明确要求只要草稿。',
              chapter_polish: '润色、局部修改、改稿、优化文风、去 AI 味；不用于从头重写章节。',
              outline_design: '设计大纲。若用户只说卷大纲/第N卷的大纲/重写某卷大纲，且未要求单元故事、章节细纲、拆成N章、章节规划或 Chapter.craftBrief，只使用 generate_volume_outline_preview，审批写入使用 persist_volume_outline，不要生成章节细纲；如果卷纲 characterPlan.newCharacterCandidates 产生候选人物且 persist_volume_character_candidates 可用，审批写入链路还要追加 persist_volume_character_candidates。若用户要求单元故事、支线故事、人物登场、人物情感、背景故事或丰富单元分类，应使用 generate_story_units_preview，审批写入只使用 persist_story_units；generate_volume_outline_preview 若只是给单元故事提供上游卷纲参考，不要写入 persist_volume_outline，除非用户明确要求同时更新卷大纲。若用户只要求章节细纲/第N卷章节细纲/章节规划，且没有明确要求重写卷纲、重新拆成N章、改变章数或从头规划，应承接 inspect_project_context 中已有 Volume.narrativePlan/storyUnitPlan，直接使用 generate_chapter_outline_preview 为每一章生成可见 Tool 调用，再 merge_chapter_outline_previews；不要重新生成卷大纲或单元故事。若用户要求卷细纲、60章细纲、等长细纲、拆卷、把某卷拆成多章、重写章节规划或改变章节数，应先使用 generate_volume_outline_preview 生成卷大纲，再用 generate_story_units_preview 生成单元故事计划，然后逐章生成；审批写入使用 persist_outline，若完整预览含 newCharacterCandidates 且工具可用，在 persist_outline 后追加 persist_volume_character_candidates；不要误判为写正文。',
              outline_chapter_batching: 'For long chapter-outline work (chapterCount > 12, especially 60 chapters), use the segmented batch chain instead of 60 single LLM calls: inspect_project_context -> segment_chapter_outline_batches -> generate_chapter_outline_batch_preview for each concrete range -> merge_chapter_outline_batch_previews -> persist_outline. Do not append terminal validate_outline. Every batch step must expose a static chapterRange so the user can see all target chapters, and the ranges must cover 1..chapterCount exactly. For ordinary chapter-outline requests, default to the target agentContext.volumes[].chapterCount and storyUnitPlan. If the user explicitly changes chapterCount so it differs from agentContext.volumes[].chapterCount, rebuild volumeOutline and storyUnitPlan first, then pass volumeOutline and storyUnitPlan through segment, every batch preview, and merge. If agentContext.volumes[].chapterOutlineBatchHints exists for the target volume, copy those hint ranges exactly instead of inventing uniform ranges.',
              project_import_preview: '拆解导入文案，并按用户指定目标产物生成预览。只要大纲时不要生成角色/世界观/写作规则；要求全套时才生成项目资料、剧情大纲、角色、世界观和写作规则。',
              chapter_revision: '修改当前章或已有章节草稿、增强节奏/压迫感、保留结局等禁改约束；若用户要求重写或不沿用旧稿，使用 rewrite_chapter。',
              character_consistency_check: '检查人设是否崩、角色动机/对话是否符合设定。',
              worldbuilding_expand: '扩展世界观、宗门、城市、能力体系，且不覆盖已确认剧情。',
              story_bible_expand: '批量扩展 Story Bible 设定资产；必须先 generate_story_bible_preview，再 validate_story_bible，写入步骤 persist_story_bible 必须等待审批。',
              timeline_plan: 'Generate planned TimelineEvent candidates from book outline, volume outline, chapter outline, Chapter.craftBrief, or guided planning artifacts. Use generate_timeline_preview -> validate_timeline_preview only for preview/validation; keep candidates eventStatus=planned and sourceType=agent_timeline_plan. Do not call persist_timeline_events unless the user explicitly asks to save timeline events after approval.',
              chapter_craft_brief: 'Create or fill chapter-level Chapter.craftBrief progress/execution cards. Trigger phrases include 章节推进卡, 推进卡, 执行卡, craftBrief, 行动链, 本章执行卡, 补齐章节细纲, 细化当前章, 细化第 N 章, 补线索, 潜台词, 不可逆后果. Use resolve_chapter -> collect_chapter_context or collect_task_context -> generate_chapter_craft_brief_preview -> validate_chapter_craft_brief, and only after approval persist_chapter_craft_brief. If the user asks to write prose, use chapter_write. If the user asks to split into scenes/SceneCard, use scene_card_planning.',
              chapter_progress_card: 'Alias for chapter_craft_brief when the user says 章节推进卡 or progress card. Use the same generate_chapter_craft_brief_preview -> validate_chapter_craft_brief -> approved persist_chapter_craft_brief chain.',
              scene_card_planning: 'Plan or update SceneCard assets for chapters; new cards should use list_scene_cards/collect_task_context as needed, then generate_scene_cards_preview, validate_scene_cards, and approved persist_scene_cards. Direct edits to existing cards should list_scene_cards first, then approved update_scene_card. Use this for 拆成场景, 场景卡, or SceneCard, not for Chapter.craftBrief progress cards.',
              plot_consistency_check: '检查剧情、大纲、事实是否冲突。',
              continuity_check: '检查 Story Bible、角色关系、时间线、写作约束之间的连续性问题；关系/时间线写入必须先 collect_task_context，再 generate_continuity_preview、validate_continuity_changes，persist_continuity_changes 只能作为需审批写入步骤。',
              ai_quality_review: '对章节草稿做 AI 审稿并写入 QualityReport，输出剧情推进、人设、文风、节奏、伏笔、世界观/时间线/规则等维度评分；必须审批后执行。',
              memory_review: '复核或整理记忆、事实沉淀质量。',
              guided_step_consultation: '创作引导页当前步骤的只读问答/填写建议；必须读取 context.session.guided，不写库，不要当作 chapter_write。',
              guided_step_generate: '创作引导页要求生成当前步骤结构化预览；必须围绕 context.session.guided.currentStep 和 currentStepData 生成 Plan 阶段预览，不写业务表。',
              guided_step_finalize: '创作引导页确认保存当前步骤结构化数据；必须要求审批，后续接入 validate_guided_step_preview 和 persist_guided_step_result 后再执行写入。',
              general: '无法归入以上创作任务时才使用。',
            },
            guidedSceneGuidance: context?.session.guided
              ? {
                  sourcePage: context.session.sourcePage,
                  currentStep: context.session.guided.currentStep,
                  currentStepLabel: context.session.guided.currentStepLabel,
                  completedSteps: context.session.guided.completedSteps ?? [],
                  rules: [
                    '围绕当前 guided step 解释、生成预览或准备审批写入。',
                    'Plan 阶段不得调用写业务表的工具。',
                    '如果缺少当前 stepData 或必要上游信息，写入 missingInfo，而不是改写成章节正文任务。',
                  ],
                }
              : undefined,
            skills,
            hardRules,
            toolManifestContract: {
              inputSchema: 'Callable args schema. Use it to build steps[].args.',
              outputFields: 'Top-level fields that may be referenced as {{steps.N.output.field}}. Use {{steps.N.output}} when passing the whole output object.',
              runtimeParams: 'Runtime-sourced params are omitted from inputSchema and injected by backend code; do not invent them in steps[].args.',
            },
            availableTools: tools,
            outputContract: {
              schemaVersion: 2,
              understanding: 'string：你对用户真实创作意图的理解',
              userGoal: 'string',
              taskType: 'one_of_availableTaskTypes',
              confidence: 'number between 0 and 1',
              summary: 'string',
              assumptions: ['string'],
              missingInfo: [{ field: 'string', reason: 'string', canResolveByTool: true, resolverTool: 'optional_tool_name' }],
              requiredContext: [{ name: 'string', reason: 'string', source: 'agent_context|resolver|tool|user' }],
              risks: ['string'],
              steps: [{ id: 'stable_snake_case_id', stepNo: 1, name: 'string', purpose: 'string', tool: 'registered_tool_name', mode: 'act', requiresApproval: true, args: {}, produces: ['optionalName'], onFailure: { strategy: 'replan', reason: 'string' } }],
              requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [1], tools: ['tool_name'] } }],
              riskReview: { riskLevel: 'low|medium|high', reasons: ['string'], requiresApproval: true, approvalMessage: 'string' },
              userVisiblePlan: { summary: 'string', bullets: ['string'], hiddenTechnicalSteps: true },
            },
          },
          null,
          2,
        ),
      },
    ];

    this.consumeLlmCall(llmBudget, 'initial_plan');
    const { data, result } = await this.llm.chatJson<unknown>(
      messages,
      { appStep: 'agent_planner', maxTokens: AGENT_PLANNER_MAX_TOKENS, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 1, temperature: 0.1 },
    );

    try {
      return { ...this.validateAndNormalizeScopedPlan(data, defaults, context, toolScope), plannerDiagnostics: { source: 'llm', model: result.model, usage: result.usage, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 2, ...this.plannerScopeDiagnostics(toolScope) } };
    } catch (error) {
      llmBudget.failures.push(this.failureDetail(this.validationFailureStage(toolScope), error));
      return this.repairLlmPlan(goal, defaults, data, error instanceof Error ? error.message : String(error), llmBudget, context, toolScope);
    }
  }

  private async repairLlmPlan(goal: string, defaults: PlannerOutputDefaults, invalidPlan: unknown, validationError: string, llmBudget: PlannerLlmBudget, context?: AgentContextV2, toolScope?: PlannerToolScope): Promise<AgentPlanSpec> {
    const registeredTools = toolScope?.selectedTools?.length
      ? toolScope.selectedTools.map((tool) => this.compactToolManifestForPrompt(tool))
      : this.toolManifestsForPrompt();
    const promptContext = this.contextForPrompt(context, { lightweight: Boolean(toolScope?.route) });
    const availableTaskTypes = this.listTaskTypes();
    this.consumeLlmCall(llmBudget, 'repair_plan');
    const { data, result } = await this.llm.chatJson<unknown>(
      [
        {
          role: 'system',
          content: [
            '你是 CreativeAgent Planner 修复器。你只能输出严格 JSON，不要 Markdown。',
            '当前用户选择的是 Agent 工作台 Plan 模式：只修复可审批计划，不执行写入。',
            '必须修复 invalidPlan，使 taskType 来自 availableTaskTypes，steps[].tool 全部来自 registeredTools。',
            'taskType 由 userGoal 语义决定；不要依赖后端关键词分类。',
            '修复导入计划时必须保留用户指定的目标产物范围；build_import_preview.args.requestedAssetTypes 只能包含用户明确要求的资产，不能因为有上传文档就扩成全套导入。',
            '修复导入计划时必须保留 agentContext.session.importPreviewMode：quick 使用 build_import_preview，deep 使用分目标工具，auto 由目标数量决定。',
            '修复导入分目标计划时，优先使用 build_import_brief（若可用）和已注册的 generate_import_*_preview 专用工具；目标专用预览后必须调用 merge_import_previews、cross_target_consistency_check（若可用），再把合并结果传给 validate_imported_assets。',
            '如果专用目标工具未注册，使用 build_import_preview fallback，但 requestedAssetTypes 仍必须等于用户选择的目标范围；persist_project_assets 必须作为需审批写入步骤保留。',
            '如果 agentContext.session.guided.currentStep 存在，修复后的 taskType 仍应优先使用 guided_step_consultation、guided_step_generate 或 guided_step_finalize，不要修成 chapter_write。',
            '修复卷大纲计划时，如果用户没有明确要求单元故事、章节细纲、拆成 N 章、章节规划或 Chapter.craftBrief，taskType 应为 outline_design，并使用 generate_volume_outline_preview -> persist_volume_outline；若有卷级候选人物且工具可用，追加 persist_volume_character_candidates；不要生成章节细纲。',
            '修复单元故事计划时，taskType 应为 outline_design，并使用 generate_story_units_preview，审批写入只使用 persist_story_units；除非用户明确要求同时更新卷大纲，不要加入 persist_volume_outline。',
            '修复章节细纲计划时，如果用户没有明确要求重写卷纲、重新拆成 N 章、改变章数或从头规划，应承接 inspect_project_context 中已有 Volume.narrativePlan/storyUnitPlan，直接用 generate_chapter_outline_preview 为每章生成独立步骤，再用 merge_chapter_outline_previews 合并；不要重新生成卷大纲或单元故事。',
            '修复卷细纲、60 章细纲、等长细纲、重写章节规划或拆成 N 章计划时，taskType 应为 outline_design，并使用 generate_volume_outline_preview 生成卷大纲，再用 generate_story_units_preview 生成单元故事计划，再用 generate_chapter_outline_preview 为每章生成独立步骤，最后用 merge_chapter_outline_previews 合并；审批写入后若完整预览含候选人物且工具可用，追加 persist_volume_character_candidates；只有写正文/生成正文才使用 chapter_write，明确重写/不沿用旧稿时使用 rewrite_chapter，拆成场景/SceneCard 才使用 scene_card_planning。',
            '如果 validationError 指出 outline.chapter 计划不完整，按 chapterCount=N 修复：输出 N 个 generate_chapter_outline_preview，chapterNo 必须是 1..N 连续，每步 chapterCount 都等于 N；第 2 章起 previousChapter 引用上一章步骤的 output.chapter；merge_chapter_outline_previews.args.previews 按顺序包含全部 N 个章节步骤输出。不得依赖后端补齐。',
            'UPDATED repair rule: if chapterCount > 12, prefer repairing to the segmented batch shape: segment_chapter_outline_batches, concrete generate_chapter_outline_batch_preview ranges covering 1..N, merge_chapter_outline_batch_previews.batchPreviews, and approval-gated persist_outline. Do not append terminal validate_outline, and do not repair long whole-volume outlines back to 60 single-chapter LLM calls unless the validation error specifically requires the legacy single-chapter shape.',
            'If validationError says target chapterCount differs from context volume chapterCount, repair by inserting generate_volume_outline_preview(chapterCount=N), generate_story_units_preview(volumeOutline={{steps.X.output.volume}}, chapterCount=N), and by passing volumeOutline/storyUnitPlan to segment_chapter_outline_batches, each generate_chapter_outline_batch_preview, and merge_chapter_outline_batch_previews.',
            'If the target agentContext.volumes entry contains chapterOutlineBatchHints, repair batch preview steps to match those hint ranges exactly, in order. Do not replace story-unit-aware hints with uniform 4-chapter ranges.',
            '修复章节细纲计划时，普通请求使用 agentContext.volumes[].chapterCount 作为默认目标章数；routeDecision.routeHints.contextChapterCount 只能作为提示。用户明确改章数时，必须由结构化 args.chapterCount=N 表达，并插入匹配的 generate_volume_outline_preview 与 generate_story_units_preview。',
            '修复计划时间线任务时，taskType 应为 timeline_plan，并使用 generate_timeline_preview -> validate_timeline_preview 从规划产物生成 eventStatus=planned 的只读候选；除非用户明确要求审批后写入，不要加入 persist_timeline_events。',
            'steps[].mode 是后端计划步骤字段，固定填 act；Plan/Act 运行时模式由后端注入，不由 LLM 决定。',
            '引用前序步骤输出时，完整对象用 {{steps.N.output}}，对象字段用 {{steps.N.output.field}}；不要把对象序列化成字符串。',
            '连续生成多章正文时必须使用 write_chapter_series；不要把多个 write_chapter 展开为多套步骤。',
            '如果无法安全修复，仍必须输出符合 outputContract 的最小安全计划。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify(
            {
              userGoal: goal,
              agentContext: promptContext,
              ...this.plannerScopePromptPayload(toolScope),
              currentAgentMode: 'plan',
              stepModeContract: 'steps[].mode 固定为 act；Plan/Act 运行时模式由后端 AgentRuntimeService 注入，不由 LLM 决定。',
              availableTaskTypes,
              guidedSceneGuidance: context?.session.guided
                ? {
                    currentStep: context.session.guided.currentStep,
                    currentStepLabel: context.session.guided.currentStepLabel,
                    preferredTaskTypes: ['guided_step_consultation', 'guided_step_generate', 'guided_step_finalize'],
                  }
                : undefined,
              invalidPlan,
              validationError,
              registeredTools,
              toolManifestContract: {
                inputSchema: 'Callable args schema. Use it to build steps[].args.',
                outputFields: 'Top-level fields that may be referenced as {{steps.N.output.field}}. Use {{steps.N.output}} when passing the whole output object.',
                runtimeParams: 'Runtime-sourced params are omitted from inputSchema and injected by backend code; do not invent them in steps[].args.',
              },
              outputDefaults: defaults,
              outputContract: {
                taskType: 'one_of_availableTaskTypes',
                summary: 'string',
                assumptions: ['string'],
                risks: ['string'],
                steps: [{ id: 'stable_snake_case_id', stepNo: 1, name: 'string', purpose: 'string', tool: 'registered_tool_name', mode: 'act', requiresApproval: true, args: {} }],
                requiredApprovals: [{ approvalType: 'plan', target: { stepNos: [1], tools: ['tool_name'] } }],
                riskReview: { riskLevel: 'low|medium|high', reasons: ['string'], requiresApproval: true, approvalMessage: 'string' },
                userVisiblePlan: { summary: 'string', bullets: ['string'], hiddenTechnicalSteps: true },
              },
            },
            null,
            2,
          ),
        },
      ],
      { appStep: 'agent_planner', maxTokens: AGENT_PLANNER_MAX_TOKENS, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 1, temperature: 0.1 },
    );

    try {
      return { ...this.validateAndNormalizeScopedPlan(data, defaults, context, toolScope), plannerDiagnostics: { source: 'llm_repair', model: result.model, usage: result.usage, repairedFromError: validationError, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 2, ...this.plannerScopeDiagnostics(toolScope) } };
    } catch (error) {
      llmBudget.failures.push(this.failureDetail(`repair_${this.validationFailureStage(toolScope)}`, error));
      throw error;
    }
  }

  private validateAndNormalizeScopedPlan(data: unknown, defaults: PlannerOutputDefaults, context?: AgentContextV2, toolScope?: PlannerToolScope): AgentPlanSpec {
    const validator = toolScope?.selectedBundle || toolScope?.route ? this.planValidator ?? new PlanValidatorService() : undefined;
    validator?.validateRaw({ data, context, route: toolScope?.route, selectedBundle: toolScope?.selectedBundle });
    const selectedToolNames = toolScope?.selectedTools?.length
      ? new Set(toolScope.selectedTools.map((tool) => tool.name))
      : undefined;
    const plan = this.validateAndNormalizeLlmPlan(data, defaults, context, selectedToolNames);
    validator?.validate({ plan, context, route: toolScope?.route, selectedBundle: toolScope?.selectedBundle });
    return plan;
  }

  private contextForPrompt(context?: AgentContextV2, options: { lightweight?: boolean } = {}): AgentContextPromptPayload | undefined {
    if (!context) return undefined;
    const { availableTools: _availableTools, ...promptContext } = context;
    if (options.lightweight) {
      const constraints = promptContext.constraints ?? { hardRules: [], styleRules: [], approvalRules: [], idPolicy: [] };
      return {
        schemaVersion: promptContext.schemaVersion,
        userMessage: promptContext.userMessage,
        runtime: promptContext.runtime,
        session: promptContext.session,
        project: promptContext.project
          ? {
              id: promptContext.project.id,
              title: promptContext.project.title,
              genre: promptContext.project.genre,
              style: promptContext.project.style,
              defaultWordCount: promptContext.project.defaultWordCount,
              status: promptContext.project.status,
            }
          : undefined,
        volumes: (promptContext.volumes ?? []).map((volume) => ({
          id: volume.id,
          volumeNo: volume.volumeNo,
          title: volume.title,
          objective: volume.objective,
          chapterCount: volume.chapterCount,
          status: volume.status,
          hasNarrativePlan: volume.hasNarrativePlan,
          hasStoryUnitPlan: volume.hasStoryUnitPlan,
          hasLegacyStoryUnits: volume.hasLegacyStoryUnits,
          chapterOutlineBatchHints: volume.chapterOutlineBatchHints,
        })),
        currentChapter: promptContext.currentChapter
          ? {
              id: promptContext.currentChapter.id,
              title: promptContext.currentChapter.title,
              index: promptContext.currentChapter.index,
              status: promptContext.currentChapter.status,
              draftId: promptContext.currentChapter.draftId,
              draftVersion: promptContext.currentChapter.draftVersion,
            }
          : undefined,
        recentChapters: [],
        knownCharacters: [],
        worldFacts: [],
        memoryHints: [],
        attachments: promptContext.attachments ?? [],
        constraints: {
          hardRules: constraints.hardRules ?? [],
          approvalRules: constraints.approvalRules ?? [],
          idPolicy: constraints.idPolicy ?? [],
          styleRules: promptContext.project?.style ? [`项目默认语气/风格：${promptContext.project.style}`] : (constraints.styleRules ?? []),
        },
      };
    }
    return promptContext;
  }

  private plannerScopePromptPayload(scope?: PlannerToolScope): Record<string, unknown> {
    return this.removeUndefinedArgs({
      routeDecision: scope?.route,
      toolBundle: scope?.selectedBundle
        ? {
            name: scope.selectedBundle.bundleName,
            selectedToolNames: scope.selectedBundle.strictToolNames,
            optionalToolNames: scope.selectedBundle.optionalToolNames,
            deniedToolNames: scope.selectedBundle.deniedToolNames,
          }
        : undefined,
    });
  }

  private plannerScopeDiagnostics(scope?: PlannerToolScope): Record<string, unknown> {
    const selectedTools = scope?.selectedTools ?? [];
    const selectedToolNames = selectedTools.map((tool) => tool.name);
    const allowedToolNames = scope?.selectedBundle
      ? [...new Set([...scope.selectedBundle.strictToolNames, ...scope.selectedBundle.optionalToolNames])]
      : selectedToolNames;
    const allTools = scope?.selectedBundle || selectedTools.length ? this.tools.listManifestsForPlanner() : undefined;
    const selectedToolsChars = selectedTools.length ? this.manifestChars(selectedTools) : undefined;
    const allToolsChars = allTools ? this.manifestChars(allTools) : undefined;
    const promptBudget = this.removeUndefinedArgs({
      selectedToolsChars,
      allToolsChars,
      promptReductionRate: allToolsChars && selectedToolsChars !== undefined
        ? Number(((allToolsChars - selectedToolsChars) / allToolsChars).toFixed(4))
        : undefined,
    });
    return this.removeUndefinedArgs({
      route: scope?.route
        ? this.removeUndefinedArgs({
            domain: scope.route.domain,
            intent: scope.route.intent,
            confidence: scope.route.confidence,
            volumeNo: scope.route.volumeNo,
            chapterNo: scope.route.chapterNo,
            chapterCountSource: scope.route.chapterCountSource,
            routeHints: scope.route.routeHints,
            needsApproval: scope.route.needsApproval,
            needsPersistence: scope.route.needsPersistence,
            ambiguity: scope.route.ambiguity,
          })
        : undefined,
      toolBundle: scope?.selectedBundle
        ? this.removeUndefinedArgs({
            name: scope.selectedBundle.bundleName,
            selectedToolCount: selectedTools.length || scope.selectedBundle.strictToolNames.length,
            strictToolCount: scope.selectedBundle.strictToolNames.length,
            optionalToolCount: scope.selectedBundle.optionalToolNames.length,
            deniedToolCount: scope.selectedBundle.deniedToolNames?.length,
            allToolCount: allTools?.length,
          })
        : undefined,
      selectedToolNames: selectedToolNames.length ? selectedToolNames : undefined,
      allowedToolNames: allowedToolNames.length ? allowedToolNames : undefined,
      promptBudget: Object.keys(promptBudget).length ? promptBudget : undefined,
    });
  }

  private validationFailureStage(scope?: PlannerToolScope): string {
    return scope?.selectedBundle || scope?.route ? 'validator' : 'schema_validation';
  }

  private manifestChars(manifests: ToolManifestForPlanner[]): number {
    return JSON.stringify(manifests).length;
  }

  private asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
    const record = this.asRecord(value);
    return Object.keys(record).length ? record : undefined;
  }

  private mergeDiagnosticsObjects(...records: Array<Record<string, unknown> | undefined>): Record<string, unknown> | undefined {
    const merged = Object.assign({}, ...records.filter(Boolean));
    return Object.keys(merged).length ? merged : undefined;
  }

  private toolManifestsForPrompt(toolNames?: string[]): PlannerPromptToolManifest[] {
    return this.tools.listManifestsForPlanner(toolNames).map((tool) => this.compactToolManifestForPrompt(tool));
  }

  private compactToolManifestForPrompt(tool: ToolManifestForPlanner): PlannerPromptToolManifest {
    const runtimeParams = this.runtimeParameterNames(tool.parameterHints);
    return this.removeUndefinedArgs({
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      whenToUse: tool.whenToUse,
      whenNotToUse: tool.whenNotToUse,
      inputSchema: this.inputSchemaForPrompt(tool.inputSchema, runtimeParams),
      outputFields: this.outputFieldsForPrompt(tool.outputSchema),
      parameterHints: this.parameterHintsForPrompt(tool.parameterHints),
      examples: this.examplesForPrompt(tool.examples, runtimeParams),
      failureHints: tool.failureHints,
      allowedModes: tool.allowedModes,
      riskLevel: tool.riskLevel,
      requiresApproval: tool.requiresApproval,
      sideEffects: tool.sideEffects,
      idPolicy: tool.idPolicy,
    }) as unknown as PlannerPromptToolManifest;
  }

  private runtimeParameterNames(parameterHints?: Record<string, ToolParameterHint>): Set<string> {
    return new Set(
      Object.entries(parameterHints ?? {})
        .filter(([, hint]) => hint.source === 'runtime')
        .map(([name]) => name),
    );
  }

  private inputSchemaForPrompt(schema: ToolJsonSchema | undefined, runtimeParams: Set<string>): ToolJsonSchema | undefined {
    if (!schema?.properties || !runtimeParams.size) return schema;
    const properties = Object.fromEntries(Object.entries(schema.properties).filter(([name]) => !runtimeParams.has(name)));
    const required = schema.required?.filter((name) => !runtimeParams.has(name));
    return this.removeUndefinedArgs({
      ...schema,
      properties,
      required: required?.length ? required : undefined,
    }) as ToolJsonSchema;
  }

  private outputFieldsForPrompt(schema: ToolJsonSchema | undefined): string[] | undefined {
    const propertyNames = Object.keys(schema?.properties ?? {});
    if (!propertyNames.length) return undefined;
    return [...new Set([...(schema?.required ?? []), ...propertyNames])];
  }

  private parameterHintsForPrompt(parameterHints?: Record<string, ToolParameterHint>): Record<string, ToolParameterHint> | undefined {
    const entries = Object.entries(parameterHints ?? {}).filter(([, hint]) => hint.source !== 'runtime');
    return entries.length ? Object.fromEntries(entries) : undefined;
  }

  private examplesForPrompt(examples: ToolManifestExample[] | undefined, runtimeParams: Set<string>): ToolManifestExample[] | undefined {
    if (!examples?.length) return undefined;
    return examples.slice(0, 1).map((example) => ({
      ...example,
      plan: example.plan.map((step) => ({ ...step, args: this.omitRuntimeArgs(step.args, runtimeParams) })),
    }));
  }

  private omitRuntimeArgs(args: Record<string, unknown>, runtimeParams: Set<string>): Record<string, unknown> {
    if (!runtimeParams.size) return args;
    return Object.fromEntries(Object.entries(args).filter(([name]) => !runtimeParams.has(name)));
  }

  private validateAndNormalizeLlmPlan(data: unknown, defaults: PlannerOutputDefaults, context?: AgentContextV2, allowedToolNames?: Set<string>): AgentPlanSpec {
    const record = this.asRecord(data);
    const availableTaskTypes = new Set(this.listTaskTypes());
    const allTools = this.tools.list();
    const registeredTools = allowedToolNames ?? new Set(allTools.map((tool) => tool.name));
    const toolRequiresApproval = new Map(allTools.map((tool) => [tool.name, tool.requiresApproval]));
    const rawSteps = Array.isArray(record.steps) ? record.steps : [];
    const maxSteps = this.rules.getPolicy().limits.maxSteps;
    if (typeof record.taskType !== 'string') throw new Error('LLM Plan taskType 必须由模型明确给出');
    if (!rawSteps.length || rawSteps.length > maxSteps) throw new Error(`LLM Plan steps 数量非法，最多 ${maxSteps} 步`);
    if (typeof record.taskType === 'string' && !availableTaskTypes.has(record.taskType)) throw new Error(`LLM Plan taskType 不在允许范围：${record.taskType}`);

    const previousStepIds = new Set<string>();
    const steps = rawSteps.map((item, index): AgentPlanStepSpec => {
      const step = this.asRecord(item);
      if (!Object.keys(step).length) throw new Error(`LLM Plan 第 ${index + 1} 步不是对象`);
      if (step.stepNo !== undefined && typeof step.stepNo !== 'number') throw new Error(`LLM Plan 第 ${index + 1} 步 stepNo 非数字`);
      const tool = typeof step.tool === 'string' ? step.tool : '';
      if (!registeredTools.has(tool)) throw new Error(`LLM Plan 使用未注册工具：${tool}`);
      const args = this.asRecord(step.args);
      this.assertArgsOnlyReferencePreviousSteps(args, index + 1, previousStepIds);
      const runIf = this.normalizeRunIf(step.runIf, index + 1);
      const id = this.normalizeStepId(step.id, tool, index + 1, previousStepIds);
      previousStepIds.add(id);
      const normalized: AgentPlanStepSpec = {
        id,
        stepNo: index + 1,
        name: typeof step.name === 'string' && step.name.trim() ? step.name.trim() : `执行 ${tool}`,
        purpose: typeof step.purpose === 'string' && step.purpose.trim() ? step.purpose.trim() : undefined,
        tool,
        mode: 'act',
        // 审批需求以后端 Tool 元数据为准，避免模型把写入类工具降级为无需审批。
        requiresApproval: toolRequiresApproval.get(tool) ?? Boolean(step.requiresApproval),
        args,
        dependsOn: this.stringArray(step.dependsOn, []),
        produces: this.stringArray(step.produces, []),
        ...(runIf ? { runIf } : {}),
      };
      const onFailure = this.normalizeOnFailure(step.onFailure);
      return onFailure ? { ...normalized, onFailure } : normalized;
    });

    const normalizedBaseSteps = this.enforceProjectImportPipeline(
      record.taskType,
      this.enforceChapterWriteQualityPipeline(steps, (tool) => toolRequiresApproval.get(tool) ?? false),
      registeredTools,
      (tool) => toolRequiresApproval.get(tool) ?? false,
      this.explicitImportAssetTypes(context?.session.requestedAssetTypes),
      context?.session.importPreviewMode,
    );
    const normalizedSteps = record.taskType === 'outline_design'
      ? this.renumberSteps(normalizedBaseSteps)
      : this.enforcePlanningTimelinePreviewPipeline(
        record.taskType,
        normalizedBaseSteps,
        registeredTools,
        (tool) => toolRequiresApproval.get(tool) ?? false,
      );
    if (normalizedSteps.length > maxSteps) throw new Error(`规范化后的 Agent Plan steps 数量非法，最多 ${maxSteps} 步`);
    const missingTool = normalizedSteps.find((step) => !registeredTools.has(step.tool));
    if (missingTool) throw new Error(`规范化后的 Agent Plan 使用未注册工具：${missingTool.tool}`);
    const approvalSteps = normalizedSteps.filter((step) => step.requiresApproval);
    return {
      schemaVersion: 2,
      understanding: typeof record.understanding === 'string' && record.understanding.trim() ? record.understanding.trim() : defaults.summary,
      userGoal: typeof record.userGoal === 'string' && record.userGoal.trim() ? record.userGoal.trim() : undefined,
      taskType: record.taskType,
      confidence: typeof record.confidence === 'number' ? Math.max(0, Math.min(1, record.confidence)) : undefined,
      summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : defaults.summary,
      assumptions: this.stringArray(record.assumptions, defaults.assumptions),
      missingInfo: this.normalizeMissingInfo(record.missingInfo),
      requiredContext: this.normalizeRequiredContext(record.requiredContext),
      risks: this.stringArray(record.risks, defaults.risks),
      steps: normalizedSteps,
      requiredApprovals: approvalSteps.length
        ? [{ approvalType: 'plan', target: { stepNos: approvalSteps.map((step) => step.stepNo), tools: approvalSteps.map((step) => step.tool) } }]
        : [],
      riskReview: this.normalizeRiskReview(record.riskReview, approvalSteps.length > 0, defaults.risks),
      userVisiblePlan: this.normalizeUserVisiblePlan(record.userVisiblePlan, defaults.summary, normalizedSteps),
    };
  }

  /**
   * 章节写作必须走固定质量门禁：写稿后润色、事实校验、最多二轮修复，再沉淀事实和记忆。
   * 这里覆盖 LLM 在 write_chapter/rewrite_chapter 之后给出的自由编排，避免漏掉后置校验或产生无限修复循环。
   */
  private enforceChapterWriteQualityPipeline(steps: AgentPlanStepSpec[], requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    const writeIndex = steps.findIndex((step) => step.tool === 'write_chapter' || step.tool === 'rewrite_chapter');
    if (writeIndex < 0) return steps;

    const baseSteps = steps.slice(0, writeIndex + 1);
    const chapterId = '{{runtime.currentChapterId}}';
    const draftId = '{{runtime.currentDraftId}}';
    const firstValidationStepNo = baseSteps.length + 2;
    const secondValidationRunIf: AgentStepCondition = { ref: `{{steps.${firstValidationStepNo}.output.createdCount}}`, operator: 'gt', value: 0 };

    const followups: AgentPlanStepSpec[] = [
      this.createPlannedStep('初次润色章节草稿', 'polish_chapter', { chapterId, draftId, instruction: '在不改变剧情事实的前提下润色章节正文，统一文风；重点减少过度修辞、漂亮空镜、感官堆叠和戏剧化短句，并保留章节目标和关键事件。' }, requiresApproval),
      this.createPlannedStep('初次事实一致性校验', 'fact_validation', { chapterId }, requiresApproval),
      this.createPlannedStep('按初次校验结果自动修复', 'auto_repair_chapter', { chapterId, draftId, issues: `{{steps.${firstValidationStepNo}.output.issues}}`, instruction: '根据事实校验问题做最小必要修复，不新增重大剧情、角色或设定。', maxRounds: 1 }, requiresApproval),
      this.createPlannedStep('二次润色修复后草稿', 'polish_chapter', { chapterId, draftId, instruction: '仅在初次校验发现问题后，对修复后的章节做第二轮轻量润色；不要新增画面感，优先删减多余修辞和模板化表达，保持剧情事实不变。' }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('二次事实一致性校验', 'fact_validation', { chapterId }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('按二次校验结果自动修复', 'auto_repair_chapter', { chapterId, draftId, issues: `{{steps.${firstValidationStepNo + 3}.output.issues}}`, instruction: '根据二次事实校验问题做最后一轮有界修复；若无可修复问题则跳过。', maxRounds: 1 }, requiresApproval, secondValidationRunIf),
      this.createPlannedStep('抽取章节事实', 'extract_chapter_facts', { chapterId, draftId }, requiresApproval),
      this.createPlannedStep('重建章节记忆', 'rebuild_memory', { chapterId, draftId }, requiresApproval),
      this.createPlannedStep('复核章节记忆', 'review_memory', { chapterId }, requiresApproval),
    ];

    return [...baseSteps, ...followups].map((step, index) => ({ ...step, stepNo: index + 1 }));
  }

  private createPlannedStep(name: string, tool: string, args: Record<string, unknown>, requiresApproval: (tool: string) => boolean, runIf?: AgentStepCondition): AgentPlanStepSpec {
    return { id: tool, stepNo: 0, name, purpose: name, tool, mode: 'act', requiresApproval: requiresApproval(tool), args, ...(runIf ? { runIf } : {}) };
  }

  private enforcePlanningTimelinePreviewPipeline(taskType: unknown, steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    const taskTypeText = typeof taskType === 'string' ? taskType : '';
    if (!['timeline_plan', 'chapter_craft_brief', 'chapter_progress_card'].includes(taskTypeText)) return steps;
    if (!registeredTools.has(GENERATE_TIMELINE_PREVIEW_TOOL) || !registeredTools.has(VALIDATE_TIMELINE_PREVIEW_TOOL)) return steps;

    let normalized = this.renumberSteps(steps);
    const existingPreview = this.latestStepByTools(normalized, [GENERATE_TIMELINE_PREVIEW_TOOL, ALIGN_CHAPTER_TIMELINE_PREVIEW_TOOL]);
    if (existingPreview) {
      return this.ensureTimelineValidationStep(normalized, existingPreview, requiresApproval);
    }

    const source = this.timelinePlanningSource(normalized, taskTypeText);
    if (!source) return normalized;
    normalized = this.insertStepAfter(
      normalized,
      source.afterStepNo,
      this.createPlannedStep(
        '生成计划时间线候选',
        GENERATE_TIMELINE_PREVIEW_TOOL,
        {
          context: source.contextArg,
          instruction: '{{context.userMessage}}',
          sourceType: source.sourceType,
        },
        requiresApproval,
      ),
    );
    const previewStep = this.latestStepByTools(normalized, [GENERATE_TIMELINE_PREVIEW_TOOL]);
    return previewStep ? this.ensureTimelineValidationStep(normalized, previewStep, requiresApproval) : normalized;
  }

  private timelinePlanningSource(steps: AgentPlanStepSpec[], taskType: string): { afterStepNo: number; sourceType: string; contextArg: unknown } | undefined {
    if (taskType === 'chapter_craft_brief' || taskType === 'chapter_progress_card') {
      const previewStep = this.latestStepByTools(steps, [GENERATE_CHAPTER_CRAFT_BRIEF_PREVIEW_TOOL]);
      if (!previewStep) return undefined;
      const validationStep = this.latestStepByTools(steps, [VALIDATE_CHAPTER_CRAFT_BRIEF_TOOL]);
      return {
        afterStepNo: validationStep?.stepNo ?? previewStep.stepNo,
        sourceType: 'craft_brief',
        contextArg: validationStep
          ? { craftBriefPreview: `{{steps.${previewStep.stepNo}.output}}`, craftBriefValidation: `{{steps.${validationStep.stepNo}.output}}` }
          : `{{steps.${previewStep.stepNo}.output}}`,
      };
    }

    const previewStep = this.latestStepByTools(steps, [
      GENERATE_CHAPTER_CRAFT_BRIEF_PREVIEW_TOOL,
      MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL,
      GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL,
      MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL,
      GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL,
      GENERATE_STORY_UNITS_PREVIEW_TOOL,
      GENERATE_VOLUME_OUTLINE_PREVIEW_TOOL,
      GENERATE_OUTLINE_PREVIEW_TOOL,
      'generate_guided_step_preview',
      'collect_task_context',
      'collect_chapter_context',
      'inspect_project_context',
    ]);
    if (!previewStep) return undefined;
    return {
      afterStepNo: previewStep.stepNo,
      sourceType: this.timelineSourceTypeForTool(previewStep.tool),
      contextArg: `{{steps.${previewStep.stepNo}.output}}`,
    };
  }

  private ensureTimelineValidationStep(steps: AgentPlanStepSpec[], previewStep: AgentPlanStepSpec, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    const previewRef = `{{steps.${previewStep.stepNo}.output}}`;
    const existingValidation = this.latestStepByTools(steps, [VALIDATE_TIMELINE_PREVIEW_TOOL]);
    if (existingValidation) {
      return steps.map((step) => step.tool === VALIDATE_TIMELINE_PREVIEW_TOOL
        ? {
            ...step,
            requiresApproval: requiresApproval(VALIDATE_TIMELINE_PREVIEW_TOOL),
            args: this.removeUndefinedArgs({
              ...step.args,
              preview: step.args.preview ?? previewRef,
              taskContext: step.args.taskContext ?? previewStep.args.context ?? previewStep.args.taskContext,
            }),
          }
        : step);
    }
    return this.insertStepAfter(
      steps,
      previewStep.stepNo,
      this.createPlannedStep(
        '校验计划时间线候选',
        VALIDATE_TIMELINE_PREVIEW_TOOL,
        this.removeUndefinedArgs({ preview: previewRef, taskContext: previewStep.args.context ?? previewStep.args.taskContext }),
        requiresApproval,
      ),
    );
  }

  private timelineSourceTypeForTool(tool: string): string {
    if (tool === GENERATE_CHAPTER_CRAFT_BRIEF_PREVIEW_TOOL) return 'craft_brief';
    if (tool === GENERATE_STORY_UNITS_PREVIEW_TOOL) return 'volume_outline';
    if (tool === GENERATE_VOLUME_OUTLINE_PREVIEW_TOOL) return 'volume_outline';
    if (tool === GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL || tool === MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL || tool === GENERATE_CHAPTER_OUTLINE_BATCH_PREVIEW_TOOL || tool === MERGE_CHAPTER_OUTLINE_BATCH_PREVIEWS_TOOL) return 'chapter_outline';
    return 'book_outline';
  }

  private latestStepByTools(steps: AgentPlanStepSpec[], tools: string[]): AgentPlanStepSpec | undefined {
    const toolSet = new Set(tools);
    return [...steps].reverse().find((item) => toolSet.has(item.tool));
  }

  /**
   * 导入计划必须形成 preview -> validate -> approval-gated persist 骨架。
   * 预览源优先使用 merge_import_previews；缺少分目标工具时允许 build_import_preview fallback，但不能扩大结构化目标范围。
   */
  private enforceProjectImportPipeline(taskType: unknown, steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, contextRequestedAssetTypes: ImportAssetType[], importPreviewMode?: ImportPreviewModeDto): AgentPlanStepSpec[] {
    if (taskType !== 'project_import_preview') return steps;
    let normalized = this.constrainImportTargetsToRequestedAssets(steps, contextRequestedAssetTypes);
    const requestedAssetTypes = contextRequestedAssetTypes.length ? contextRequestedAssetTypes : this.requestedAssetTypesFromImportSteps(normalized);
    const effectiveMode = this.effectiveImportPreviewMode(importPreviewMode, requestedAssetTypes);

    normalized = this.ensureBuildImportPreviewScope(normalized, requestedAssetTypes);
    if (effectiveMode === 'quick') {
      normalized = this.ensureQuickImportPreviewSource(normalized, registeredTools, requiresApproval, requestedAssetTypes);
    } else {
      normalized = this.ensureImportBriefStep(normalized, registeredTools, requiresApproval, requestedAssetTypes);
      normalized = this.ensureImportPreviewSource(normalized, registeredTools, requiresApproval, requestedAssetTypes);
      normalized = this.ensureTargetPreviewImportBriefArgs(normalized);
      normalized = this.ensureMergeImportPreviewsStep(normalized, registeredTools, requiresApproval, requestedAssetTypes);
    }

    const previewStep = this.findImportPreviewSourceStep(normalized);
    if (!previewStep) return normalized;
    normalized = this.ensureCrossTargetConsistencyCheckStep(normalized, previewStep, registeredTools, requiresApproval);
    const consistencyStep = [...normalized].reverse().find((step) => step.tool === CROSS_TARGET_CONSISTENCY_CHECK_TOOL);
    normalized = this.ensureValidateImportedAssetsStep(normalized, previewStep, registeredTools, requiresApproval, consistencyStep);

    const latestPreviewStep = this.findImportPreviewSourceStep(normalized) ?? previewStep;
    normalized = this.ensurePersistProjectAssetsStep(normalized, latestPreviewStep, registeredTools, requiresApproval);
    return normalized;
  }

  private effectiveImportPreviewMode(importPreviewMode: ImportPreviewModeDto | undefined, requestedAssetTypes: ImportAssetType[]): 'quick' | 'deep' {
    if (importPreviewMode === 'quick' || importPreviewMode === 'deep') return importPreviewMode;
    if (importPreviewMode === 'auto') return requestedAssetTypes.length > 0 && requestedAssetTypes.length <= 2 ? 'deep' : 'quick';
    return 'deep';
  }

  private constrainImportTargetsToRequestedAssets(steps: AgentPlanStepSpec[], requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    if (!requestedAssetTypes.length) return steps;
    const requested = new Set(requestedAssetTypes);
    const filtered = steps
      .filter((step) => {
        const assetType = IMPORT_TARGET_ASSET_BY_TOOL.get(step.tool);
        return !assetType || requested.has(assetType);
      })
      .map((step) => {
        if (step.tool === 'merge_import_previews') {
          const args: Record<string, unknown> = { ...step.args, requestedAssetTypes };
          for (const assetType of IMPORT_ASSET_TYPES) {
            if (!requested.has(assetType)) delete args[MERGE_PREVIEW_ARG_BY_ASSET_TYPE[assetType]];
          }
          return { ...step, args };
        }
        if (step.tool === 'build_import_preview') return { ...step, args: { ...step.args, requestedAssetTypes } };
        return step;
      });
    return filtered.length === steps.length ? filtered : this.renumberSteps(filtered);
  }

  private ensureBuildImportPreviewScope(steps: AgentPlanStepSpec[], requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    if (!requestedAssetTypes.length) return steps;
    return steps.map((step) => step.tool === 'build_import_preview' ? { ...step, args: { ...step.args, requestedAssetTypes } } : step);
  }

  private ensureQuickImportPreviewSource(steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    const quickSteps = this.renumberSteps(steps.filter((step) => (
      step.tool !== BUILD_IMPORT_BRIEF_TOOL
      && !IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool)
      && step.tool !== 'merge_import_previews'
    )));
    return this.ensureBuildImportPreviewStep(quickSteps, registeredTools, requiresApproval, requestedAssetTypes);
  }

  private ensureImportBriefStep(steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    if (!registeredTools.has(BUILD_IMPORT_BRIEF_TOOL)) return steps;
    const hasTargetPreview = steps.some((step) => IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool));
    const canUseRequestedTargetTools = requestedAssetTypes.length > 0 && requestedAssetTypes.every((assetType) => registeredTools.has(IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType]));
    if (!hasTargetPreview && !canUseRequestedTargetTools) return steps;
    const withoutBrief = this.renumberSteps(steps.filter((step) => step.tool !== BUILD_IMPORT_BRIEF_TOOL));
    const analysisStep = [...withoutBrief].reverse().find((step) => step.tool === 'analyze_source_text');
    if (!analysisStep) return steps;
    const args = this.removeUndefinedArgs({
      analysis: `{{steps.${analysisStep.stepNo}.output}}`,
      instruction: '{{context.userMessage}}',
      requestedAssetTypes: requestedAssetTypes.length ? requestedAssetTypes : undefined,
      projectContext: '{{context.project}}',
    });
    return this.insertStepAfter(withoutBrief, analysisStep.stepNo, {
      id: BUILD_IMPORT_BRIEF_TOOL,
      stepNo: 0,
      name: '生成导入全局简报',
      purpose: '在分目标预览前提炼共同主线、设定、人物、世界规则、语气和风险，供目标 Tool 参考。',
      tool: BUILD_IMPORT_BRIEF_TOOL,
      mode: 'act',
      requiresApproval: requiresApproval(BUILD_IMPORT_BRIEF_TOOL),
      args,
    });
  }

  private ensureImportPreviewSource(steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    const hasTargetPreview = steps.some((step) => IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool));
    if (requestedAssetTypes.length) {
      const allRequestedTargetToolsAvailable = requestedAssetTypes.every((assetType) => registeredTools.has(IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType]));
      if (allRequestedTargetToolsAvailable) {
        const withoutFallback = this.renumberSteps(steps.filter((step) => step.tool !== 'build_import_preview'));
        const withTargetPreviews = this.ensureRequestedTargetPreviewSteps(withoutFallback, requiresApproval, requestedAssetTypes);
        if (this.hasAllRequestedTargetPreviewSteps(withTargetPreviews, requestedAssetTypes)) return withTargetPreviews;
      }
      const fallbackSteps = this.renumberSteps(steps.filter((step) => !IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool) && step.tool !== 'merge_import_previews'));
      return this.ensureBuildImportPreviewStep(fallbackSteps, registeredTools, requiresApproval, requestedAssetTypes);
    }
    if (this.findImportPreviewSourceStep(steps) || hasTargetPreview) return steps;
    return this.ensureBuildImportPreviewStep(steps, registeredTools, requiresApproval, requestedAssetTypes);
  }

  private ensureRequestedTargetPreviewSteps(steps: AgentPlanStepSpec[], requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    const existingAssetTypes = new Set(steps.map((step) => IMPORT_TARGET_ASSET_BY_TOOL.get(step.tool)).filter((item): item is ImportAssetType => Boolean(item)));
    const missingAssetTypes = requestedAssetTypes.filter((assetType) => !existingAssetTypes.has(assetType));
    if (!missingAssetTypes.length) return steps;
    const analysisStep = [...steps].reverse().find((step) => step.tool === 'analyze_source_text');
    const importBriefStep = [...steps].reverse().find((step) => step.tool === BUILD_IMPORT_BRIEF_TOOL);
    if (!analysisStep) return steps;
    return [
      ...steps,
      ...missingAssetTypes.map((assetType, index) => {
        const tool = IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType];
        const args = this.removeUndefinedArgs({
          analysis: `{{steps.${analysisStep.stepNo}.output}}`,
          importBrief: importBriefStep ? `{{steps.${importBriefStep.stepNo}.output}}` : undefined,
          instruction: '{{context.userMessage}}',
          projectContext: '{{context.project}}',
        });
        return {
          id: tool,
          stepNo: steps.length + index + 1,
          name: IMPORT_TARGET_STEP_NAME_BY_ASSET_TYPE[assetType],
          purpose: `按用户选择的 ${assetType} 目标生成专用导入预览。`,
          tool,
          mode: 'act' as const,
          requiresApproval: requiresApproval(tool),
          args,
        };
      }),
    ];
  }

  private ensureTargetPreviewImportBriefArgs(steps: AgentPlanStepSpec[]): AgentPlanStepSpec[] {
    const importBriefStep = [...steps].reverse().find((step) => step.tool === BUILD_IMPORT_BRIEF_TOOL);
    if (!importBriefStep) return steps;
    return steps.map((step) => (
      IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool)
        ? { ...step, args: { ...step.args, importBrief: `{{steps.${importBriefStep.stepNo}.output}}` } }
        : step
    ));
  }

  private hasAllRequestedTargetPreviewSteps(steps: AgentPlanStepSpec[], requestedAssetTypes: ImportAssetType[]): boolean {
    const existingTools = new Set(steps.map((step) => step.tool));
    return requestedAssetTypes.every((assetType) => existingTools.has(IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType]));
  }

  private ensureBuildImportPreviewStep(steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    if (this.findImportPreviewSourceStep(steps) || !registeredTools.has('build_import_preview')) return steps;
    const analysisStep = [...steps].reverse().find((step) => step.tool === 'analyze_source_text');
    if (!analysisStep) return steps;
    const args = this.removeUndefinedArgs({
      analysis: `{{steps.${analysisStep.stepNo}.output}}`,
      instruction: '{{context.userMessage}}',
      requestedAssetTypes: requestedAssetTypes.length ? requestedAssetTypes : undefined,
    });
    return [
      ...steps,
      {
        id: 'build_import_preview',
        stepNo: steps.length + 1,
        name: '生成导入预览',
        purpose: '在专用目标预览工具缺失时，按用户选择的目标产物范围生成兼容导入预览。',
        tool: 'build_import_preview',
        mode: 'act',
        requiresApproval: requiresApproval('build_import_preview'),
        args,
      },
    ];
  }

  private ensureMergeImportPreviewsStep(steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, requestedAssetTypes: ImportAssetType[]): AgentPlanStepSpec[] {
    if (!registeredTools.has('merge_import_previews')) return steps;
    const targetPreviewSteps = steps.filter((step) => IMPORT_TARGET_ASSET_BY_TOOL.has(step.tool));
    if (!targetPreviewSteps.length) return steps;
    const requested = requestedAssetTypes.length ? requestedAssetTypes : [...new Set(targetPreviewSteps.map((step) => IMPORT_TARGET_ASSET_BY_TOOL.get(step.tool)).filter((item): item is ImportAssetType => Boolean(item)))];
    const mergeArgs = this.buildMergeImportPreviewArgs(steps, requested);
    const mergeStep = steps.find((step) => step.tool === 'merge_import_previews');
    if (mergeStep) {
      const latestTargetStepNo = Math.max(...targetPreviewSteps.map((step) => step.stepNo));
      if (mergeStep.stepNo <= latestTargetStepNo) {
        const withoutMerge = this.renumberSteps(steps.filter((step) => step.tool !== 'merge_import_previews'));
        return this.ensureMergeImportPreviewsStep(withoutMerge, registeredTools, requiresApproval, requested);
      }
      return steps.map((step) => step.tool === 'merge_import_previews' ? { ...step, requiresApproval: requiresApproval('merge_import_previews'), args: mergeArgs } : step);
    }
    return [
      ...steps,
      {
        id: 'merge_import_previews',
        stepNo: steps.length + 1,
        name: '合并目标产物导入预览',
        purpose: '把本次用户选择的目标产物预览合并为统一导入预览，供校验和审批写入使用。',
        tool: 'merge_import_previews',
        mode: 'act',
        requiresApproval: requiresApproval('merge_import_previews'),
        args: mergeArgs,
      },
    ];
  }

  private buildMergeImportPreviewArgs(steps: AgentPlanStepSpec[], requestedAssetTypes: ImportAssetType[]) {
    const args: Record<string, unknown> = { requestedAssetTypes };
    for (const assetType of requestedAssetTypes) {
      const tool = IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType];
      const step = [...steps].reverse().find((item) => item.tool === tool);
      if (step) args[MERGE_PREVIEW_ARG_BY_ASSET_TYPE[assetType]] = `{{steps.${step.stepNo}.output}}`;
    }
    return args;
  }

  private ensureCrossTargetConsistencyCheckStep(steps: AgentPlanStepSpec[], previewStep: AgentPlanStepSpec, registeredTools: Set<string>, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    if (!registeredTools.has(CROSS_TARGET_CONSISTENCY_CHECK_TOOL)) return steps;
    const previewRef = `{{steps.${previewStep.stepNo}.output}}`;
    const checkStep = steps.find((step) => step.tool === CROSS_TARGET_CONSISTENCY_CHECK_TOOL);
    if (checkStep) {
      if (checkStep.stepNo > previewStep.stepNo) {
        return steps.map((step) => step.tool === CROSS_TARGET_CONSISTENCY_CHECK_TOOL ? { ...step, requiresApproval: requiresApproval(CROSS_TARGET_CONSISTENCY_CHECK_TOOL), args: { ...step.args, preview: previewRef, instruction: '{{context.userMessage}}' } } : step);
      }
      const withoutCheck = this.renumberSteps(steps.filter((step) => step.tool !== CROSS_TARGET_CONSISTENCY_CHECK_TOOL));
      const nextPreviewStep = this.findImportPreviewSourceStep(withoutCheck);
      return nextPreviewStep ? this.insertStepAfter(withoutCheck, nextPreviewStep.stepNo, this.createPlannedStep('跨目标一致性检查', CROSS_TARGET_CONSISTENCY_CHECK_TOOL, { preview: `{{steps.${nextPreviewStep.stepNo}.output}}`, instruction: '{{context.userMessage}}' }, requiresApproval)) : withoutCheck;
    }
    return this.insertStepAfter(steps, previewStep.stepNo, this.createPlannedStep('跨目标一致性检查', CROSS_TARGET_CONSISTENCY_CHECK_TOOL, { preview: previewRef, instruction: '{{context.userMessage}}' }, requiresApproval));
  }

  private ensureValidateImportedAssetsStep(steps: AgentPlanStepSpec[], previewStep: AgentPlanStepSpec, registeredTools: Set<string>, requiresApproval: (tool: string) => boolean, afterStep?: AgentPlanStepSpec): AgentPlanStepSpec[] {
    if (!registeredTools.has('validate_imported_assets')) return steps;
    const previewRef = `{{steps.${previewStep.stepNo}.output}}`;
    const afterStepNo = afterStep?.stepNo ?? previewStep.stepNo;
    const validateStep = steps.find((step) => step.tool === 'validate_imported_assets');
    if (validateStep) {
      if (validateStep.stepNo > afterStepNo) {
        return steps.map((step) => step.tool === 'validate_imported_assets' ? { ...step, requiresApproval: requiresApproval('validate_imported_assets'), args: { ...step.args, preview: previewRef } } : step);
      }
      const withoutValidate = this.renumberSteps(steps.filter((step) => step.tool !== 'validate_imported_assets'));
      const nextPreviewStep = this.findImportPreviewSourceStep(withoutValidate);
      const nextAfterStep = [...withoutValidate].reverse().find((step) => step.tool === CROSS_TARGET_CONSISTENCY_CHECK_TOOL && (!nextPreviewStep || step.stepNo > nextPreviewStep.stepNo));
      return nextPreviewStep ? this.insertStepAfter(withoutValidate, nextAfterStep?.stepNo ?? nextPreviewStep.stepNo, this.createPlannedStep('校验导入预览', 'validate_imported_assets', { preview: `{{steps.${nextPreviewStep.stepNo}.output}}` }, requiresApproval)) : withoutValidate;
    }
    return this.insertStepAfter(steps, afterStepNo, this.createPlannedStep('校验导入预览', 'validate_imported_assets', { preview: previewRef }, requiresApproval));
  }

  private ensurePersistProjectAssetsStep(steps: AgentPlanStepSpec[], previewStep: AgentPlanStepSpec, registeredTools: Set<string>, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    if (!registeredTools.has('persist_project_assets')) return steps;
    const previewRef = `{{steps.${previewStep.stepNo}.output}}`;
    const validateStep = [...steps].reverse().find((step) => step.tool === 'validate_imported_assets');
    const afterStepNo = validateStep?.stepNo ?? previewStep.stepNo;
    const persistStep = steps.find((step) => step.tool === 'persist_project_assets');
    if (persistStep) {
      if (persistStep.stepNo <= afterStepNo) {
        const withoutPersist = this.renumberSteps(steps.filter((step) => step.tool !== 'persist_project_assets'));
        const nextPreviewStep = this.findImportPreviewSourceStep(withoutPersist);
        if (!nextPreviewStep) return withoutPersist;
        const nextValidateStep = [...withoutPersist].reverse().find((step) => step.tool === 'validate_imported_assets');
        const nextAfterStepNo = nextValidateStep?.stepNo ?? nextPreviewStep.stepNo;
        return this.insertStepAfter(withoutPersist, nextAfterStepNo, {
          ...persistStep,
          stepNo: 0,
          requiresApproval: requiresApproval('persist_project_assets'),
          args: { ...persistStep.args, preview: `{{steps.${nextPreviewStep.stepNo}.output}}` },
        });
      }
      return steps.map((step) => step.tool === 'persist_project_assets' ? { ...step, requiresApproval: requiresApproval('persist_project_assets'), args: { ...step.args, preview: previewRef } } : step);
    }
    return this.insertStepAfter(steps, afterStepNo, {
      id: 'persist_project_assets',
      stepNo: 0,
      name: '审批后写入导入资产',
      purpose: '在用户确认执行后，将本次导入预览写入所选择的项目资产。',
      tool: 'persist_project_assets',
      mode: 'act',
      requiresApproval: requiresApproval('persist_project_assets'),
      args: { preview: previewRef },
    });
  }

  private findImportPreviewSourceStep(steps: AgentPlanStepSpec[]) {
    const ordered = [...steps].sort((a, b) => b.stepNo - a.stepNo);
    return ordered.find((step) => step.tool === 'merge_import_previews')
      ?? ordered.find((step) => step.tool === 'build_import_preview');
  }

  private requestedAssetTypesFromImportSteps(steps: AgentPlanStepSpec[]): ImportAssetType[] {
    for (const step of steps) {
      if (step.tool === 'merge_import_previews' || step.tool === 'build_import_preview') {
        const explicit = this.explicitImportAssetTypes(this.asRecord(step.args).requestedAssetTypes);
        if (explicit.length) return explicit;
      }
    }
    return [];
  }

  private insertStepAfter(steps: AgentPlanStepSpec[], afterStepNo: number, step: AgentPlanStepSpec): AgentPlanStepSpec[] {
    const insertAt = afterStepNo + 1;
    const shifted = steps.map((item) =>
      item.stepNo >= insertAt
        ? {
            ...item,
            stepNo: item.stepNo + 1,
            args: this.rewriteNumericStepReferences(item.args, insertAt, 1) as Record<string, unknown>,
            ...(item.runIf ? { runIf: { ...item.runIf, ref: this.rewriteNumericStepReferences(item.runIf.ref, insertAt, 1) as string } } : {}),
          }
        : item,
    );
    return [...shifted, { ...step, stepNo: insertAt }].sort((a, b) => a.stepNo - b.stepNo);
  }

  private renumberSteps(steps: AgentPlanStepSpec[]): AgentPlanStepSpec[] {
    const ordered = [...steps].sort((a, b) => a.stepNo - b.stepNo);
    const stepNoMap = new Map<number, number>();
    ordered.forEach((step, index) => stepNoMap.set(step.stepNo, index + 1));
    return ordered.map((step, index) => ({
      ...step,
      stepNo: index + 1,
      args: this.rewriteNumericStepReferencesByMap(step.args, stepNoMap) as Record<string, unknown>,
      ...(step.runIf ? { runIf: { ...step.runIf, ref: this.rewriteNumericStepReferencesByMap(step.runIf.ref, stepNoMap) as string } } : {}),
    }));
  }

  private rewriteNumericStepReferences(value: unknown, fromStepNo: number, offset: number): unknown {
    if (typeof value === 'string') {
      return value.replace(/{{steps\.(\d+)\.output/g, (_match, rawStepNo) => `{{steps.${Number(rawStepNo) >= fromStepNo ? Number(rawStepNo) + offset : Number(rawStepNo)}.output`);
    }
    if (Array.isArray(value)) return value.map((item) => this.rewriteNumericStepReferences(item, fromStepNo, offset));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.rewriteNumericStepReferences(item, fromStepNo, offset)]));
    return value;
  }

  private rewriteNumericStepReferencesByMap(value: unknown, stepNoMap: Map<number, number>): unknown {
    if (typeof value === 'string') {
      return value.replace(/{{steps\.(\d+)\.output/g, (match, rawStepNo) => {
        const nextStepNo = stepNoMap.get(Number(rawStepNo));
        return nextStepNo ? `{{steps.${nextStepNo}.output` : match;
      });
    }
    if (Array.isArray(value)) return value.map((item) => this.rewriteNumericStepReferencesByMap(item, stepNoMap));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.rewriteNumericStepReferencesByMap(item, stepNoMap)]));
    return value;
  }

  private removeUndefinedArgs(args: Record<string, unknown>) {
    return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
  }

  private positiveInt(value: unknown): number | undefined {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
  }

  /** 统计 Planner 的模型调用次数，避免 JSON 修复循环失控。 */
  private consumeLlmCall(budget: PlannerLlmBudget, stage: string) {
    if (budget.used >= budget.max) throw new Error(`Planner LLM 调用超过上限：${budget.max}（阶段：${stage}）`);
    budget.used += 1;
  }

  /** 校验 Tool 参数中的变量引用只能读取前序步骤输出，避免计划形成循环依赖。 */
  private assertArgsOnlyReferencePreviousSteps(value: unknown, currentStepNo: number, previousStepIds: Set<string> = new Set()) {
    if (typeof value === 'string') {
      if (value.match(/^{{runtime\.(?:currentDraftId|currentChapterId)}}$/)) return;
      if (value.match(/^{{context\.[\w.]+}}$/)) return;
      const match = value.match(/^{{steps\.(\d+)\.output(?:\.[\w.]+)?}}$/);
      if (match && Number(match[1]) >= currentStepNo) throw new Error(`LLM Plan 第 ${currentStepNo} 步引用了非前序步骤 ${match[1]}`);
      const namedMatch = value.match(/^{{steps\.([A-Za-z][\w-]*)\.output(?:\.[\w.]+)?}}$/);
      if (namedMatch && !previousStepIds.has(namedMatch[1])) throw new Error(`LLM Plan 第 ${currentStepNo} 步引用了非前序步骤 ID：${namedMatch[1]}`);
      if (!match && !namedMatch && /^{{[^{}]+}}$/.test(value)) throw new Error(`LLM Plan 第 ${currentStepNo} 步使用了未知模板引用：${value}`);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => this.assertArgsOnlyReferencePreviousSteps(item, currentStepNo, previousStepIds));
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => this.assertArgsOnlyReferencePreviousSteps(item, currentStepNo, previousStepIds));
    }
  }

  /** 校验条件执行表达式只读取前序步骤或运行时当前草稿，避免条件分支形成循环依赖。 */
  private normalizeRunIf(value: unknown, currentStepNo: number): AgentStepCondition | undefined {
    const record = this.asRecord(value);
    if (!Object.keys(record).length) return undefined;
    if (typeof record.ref !== 'string') throw new Error(`LLM Plan 第 ${currentStepNo} 步 runIf.ref 必须是字符串`);
    const operator = record.operator;
    const allowed = new Set<AgentStepCondition['operator']>(['exists', 'not_exists', 'truthy', 'falsy', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
    if (!allowed.has(operator as AgentStepCondition['operator'])) throw new Error(`LLM Plan 第 ${currentStepNo} 步 runIf.operator 非法`);
    this.assertArgsOnlyReferencePreviousSteps(record.ref, currentStepNo);
    return { ref: record.ref, operator: operator as AgentStepCondition['operator'], ...(record.value !== undefined ? { value: record.value } : {}) };
  }

  private normalizeStepId(value: unknown, tool: string, stepNo: number, used: Set<string>) {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : tool;
    const base = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^[^A-Za-z]+/, '') || `step_${stepNo}`;
    if (!used.has(base)) return base;
    return `${base}_${stepNo}`;
  }

  private normalizeOnFailure(value: unknown): AgentPlanStepSpec['onFailure'] | undefined {
    const record = this.asRecord(value);
    const strategy = record.strategy;
    if (!['replan', 'ask_user', 'fail_fast', 'skip'].includes(String(strategy))) return undefined;
    return { strategy: strategy as NonNullable<AgentPlanStepSpec['onFailure']>['strategy'], reason: typeof record.reason === 'string' ? record.reason : '按工具失败情况处理。' };
  }

  private normalizeMissingInfo(value: unknown): AgentPlanSpec['missingInfo'] {
    if (!Array.isArray(value)) return [];
    return value.map((item) => this.asRecord(item)).filter((item) => typeof item.field === 'string' && typeof item.reason === 'string').map((item) => ({ field: String(item.field), reason: String(item.reason), canResolveByTool: Boolean(item.canResolveByTool), ...(typeof item.resolverTool === 'string' ? { resolverTool: item.resolverTool } : {}) }));
  }

  private normalizeRequiredContext(value: unknown): AgentPlanSpec['requiredContext'] {
    if (!Array.isArray(value)) return [];
    const allowed = new Set(['agent_context', 'resolver', 'tool', 'user']);
    return value.map((item) => this.asRecord(item)).filter((item) => typeof item.name === 'string' && typeof item.reason === 'string').map((item) => ({ name: String(item.name), reason: String(item.reason), source: allowed.has(String(item.source)) ? item.source as 'agent_context' | 'resolver' | 'tool' | 'user' : 'tool' }));
  }

  private normalizeRiskReview(value: unknown, requiresApproval: boolean, fallbackReasons: string[]): AgentPlanSpec['riskReview'] {
    const record = this.asRecord(value);
    const riskLevel = ['low', 'medium', 'high'].includes(String(record.riskLevel)) ? record.riskLevel as 'low' | 'medium' | 'high' : (requiresApproval ? 'medium' : 'low');
    const reasons = this.stringArray(record.reasons, fallbackReasons);
    return { riskLevel, reasons, requiresApproval, approvalMessage: typeof record.approvalMessage === 'string' && record.approvalMessage.trim() ? record.approvalMessage.trim() : (requiresApproval ? '确认后将执行写入或有副作用步骤。' : '该计划默认只包含低风险只读步骤。') };
  }

  private normalizeUserVisiblePlan(value: unknown, summary: string, steps: AgentPlanStepSpec[]): AgentPlanSpec['userVisiblePlan'] {
    const record = this.asRecord(value);
    const bullets = this.stringArray(record.bullets, steps.map((step) => step.purpose ?? step.name));
    return { summary: typeof record.summary === 'string' && record.summary.trim() ? record.summary.trim() : summary, bullets, hiddenTechnicalSteps: record.hiddenTechnicalSteps !== false };
  }

  private failureDetail(stage: string, error: unknown) {
    return { stage, message: error instanceof Error ? error.message : String(error) };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  }

  private stringArray(value: unknown, fallback: string[]): string[] {
    const items = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()) : [];
    return items.length ? items : fallback;
  }

  private explicitImportAssetTypes(value: unknown): ImportAssetType[] {
    if (!Array.isArray(value)) return [];
    const normalized = value.filter((item): item is ImportAssetType => typeof item === 'string' && IMPORT_ASSET_TYPES.includes(item as ImportAssetType));
    return [...new Set(normalized)];
  }

  /** LLM 可以选择的任务类型白名单；后端只限制边界，不再做语义分类裁决。 */
  private listTaskTypes(): string[] {
    return [...new Set(this.skills.list().flatMap((skill) => skill.taskTypes))];
  }

}
