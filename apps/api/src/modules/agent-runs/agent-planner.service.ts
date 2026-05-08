import { Injectable } from '@nestjs/common';
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
const GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL = 'generate_chapter_outline_preview';
const MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL = 'merge_chapter_outline_previews';
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
  ) {}

  async createPlan(goal: string, context?: AgentContextV2): Promise<AgentPlanSpec> {
    const defaults = this.createOutputDefaults(goal);
    const llmBudget: PlannerLlmBudget = { used: 0, max: this.rules.getPolicy().limits.maxLlmCalls, failures: [] };
    try {
      return await this.createLlmPlan(goal, defaults, llmBudget, context);
    } catch (error) {
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

  private async createLlmPlan(goal: string, defaults: PlannerOutputDefaults, llmBudget: PlannerLlmBudget, context?: AgentContextV2): Promise<AgentPlanSpec> {
    const tools = this.toolManifestsForPrompt();
    const promptContext = this.contextForPrompt(context);
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
          '用户要求“卷细纲 / 章节细纲 / 60 章细纲 / 等长细纲 / 章节规划”时选择 outline_design，并优先编排 inspect_project_context -> generate_chapter_outline_preview（每章一个步骤）-> merge_chapter_outline_previews -> validate_outline -> persist_outline；不要误判为 write_chapter。',
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
            currentAgentMode: 'plan',
            stepModeContract: 'steps[].mode 固定为 act；Plan/Act 运行时模式由后端 AgentRuntimeService 注入，不由 LLM 决定。',
            availableTaskTypes,
            taskTypeGuidance: {
              chapter_write: '写某一章正文、章节内容、目标字数、续写正文；若明确要求重写旧章节，应使用 rewrite_chapter。',
              multi_chapter_write: '连续生成多章正文，例如接下来三章、第 1-5 章、多个指定章节；应优先使用 write_chapter_series，不要展开多个 write_chapter。默认设置 qualityPipeline=full，除非用户明确要求只要草稿。',
              chapter_polish: '润色、局部修改、改稿、优化文风、去 AI 味；不用于从头重写章节。',
              outline_design: '设计大纲、卷细纲、章节细纲、60章细纲、等长细纲、拆卷、把某卷拆成多章、章节规划；应使用 generate_chapter_outline_preview 为每一章生成可见 Tool 调用，再用 merge_chapter_outline_previews 合并为 outline_preview；不要误判为写正文。',
              project_import_preview: '拆解导入文案，并按用户指定目标产物生成预览。只要大纲时不要生成角色/世界观/写作规则；要求全套时才生成项目资料、剧情大纲、角色、世界观和写作规则。',
              chapter_revision: '修改当前章或已有章节草稿、增强节奏/压迫感、保留结局等禁改约束；若用户要求重写或不沿用旧稿，使用 rewrite_chapter。',
              character_consistency_check: '检查人设是否崩、角色动机/对话是否符合设定。',
              worldbuilding_expand: '扩展世界观、宗门、城市、能力体系，且不覆盖已确认剧情。',
              story_bible_expand: '批量扩展 Story Bible 设定资产；必须先 generate_story_bible_preview，再 validate_story_bible，写入步骤 persist_story_bible 必须等待审批。',
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
      { appStep: 'agent_planner', maxTokens: 4500, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 1, temperature: 0.1 },
    );

    try {
      return { ...this.validateAndNormalizeLlmPlan(data, defaults, context), plannerDiagnostics: { source: 'llm', model: result.model, usage: result.usage, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 2 } };
    } catch (error) {
      llmBudget.failures.push(this.failureDetail('schema_validation', error));
      return this.repairLlmPlan(goal, defaults, data, error instanceof Error ? error.message : String(error), llmBudget, context);
    }
  }

  private async repairLlmPlan(goal: string, defaults: PlannerOutputDefaults, invalidPlan: unknown, validationError: string, llmBudget: PlannerLlmBudget, context?: AgentContextV2): Promise<AgentPlanSpec> {
    const registeredTools = this.toolManifestsForPrompt();
    const promptContext = this.contextForPrompt(context);
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
            '修复卷细纲、章节细纲、60 章细纲或等长细纲计划时，taskType 应为 outline_design，并使用 generate_chapter_outline_preview 为每章生成独立步骤，再用 merge_chapter_outline_previews 合并；只有写正文/生成正文才使用 chapter_write，明确重写/不沿用旧稿时使用 rewrite_chapter，拆成场景/SceneCard 才使用 scene_card_planning。',
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
      { appStep: 'agent_planner', maxTokens: 4500, timeoutMs: DEFAULT_LLM_TIMEOUT_MS, retries: 1, temperature: 0.1 },
    );

    return { ...this.validateAndNormalizeLlmPlan(data, defaults, context), plannerDiagnostics: { source: 'llm_repair', model: result.model, usage: result.usage, repairedFromError: validationError, llmCalls: llmBudget.used, maxLlmCalls: llmBudget.max, schemaVersion: 2 } };
  }

  private contextForPrompt(context?: AgentContextV2): AgentContextPromptPayload | undefined {
    if (!context) return undefined;
    const { availableTools: _availableTools, ...promptContext } = context;
    return promptContext;
  }

  private toolManifestsForPrompt(): PlannerPromptToolManifest[] {
    return this.tools.listManifestsForPlanner().map((tool) => this.compactToolManifestForPrompt(tool));
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

  private validateAndNormalizeLlmPlan(data: unknown, defaults: PlannerOutputDefaults, context?: AgentContextV2): AgentPlanSpec {
    const record = this.asRecord(data);
    const availableTaskTypes = new Set(this.listTaskTypes());
    const registeredTools = new Set(this.tools.list().map((tool) => tool.name));
    const toolRequiresApproval = new Map(this.tools.list().map((tool) => [tool.name, tool.requiresApproval]));
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

    const normalizedSteps = this.enforceOutlineDesignPipeline(
      record.taskType,
      this.enforceProjectImportPipeline(
        record.taskType,
        this.enforceChapterWriteQualityPipeline(steps, (tool) => toolRequiresApproval.get(tool) ?? false),
        registeredTools,
        (tool) => toolRequiresApproval.get(tool) ?? false,
        this.explicitImportAssetTypes(context?.session.requestedAssetTypes),
        context?.session.importPreviewMode,
      ),
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

  /**
   * 大纲计划需要在 UI 时间线里显式展示每章 Tool 调用。
   * LLM 可以先给出旧的 generate_outline_preview 聚合步骤；这里将其稳定展开为 N 个单章步骤。
   */
  private enforceOutlineDesignPipeline(taskType: unknown, steps: AgentPlanStepSpec[], registeredTools: Set<string>, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    if (taskType !== 'outline_design') return steps;
    if (!registeredTools.has(GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL) || !registeredTools.has(MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL)) return steps;

    const aggregateStep = steps.find((step) => step.tool === GENERATE_OUTLINE_PREVIEW_TOOL);
    if (aggregateStep) {
      const args = aggregateStep.args;
      const chapterCount = this.positiveInt(args.chapterCount) ?? 0;
      if (!chapterCount) return steps;
      const volumeNo = this.positiveInt(args.volumeNo) ?? 1;
      const prefix = this.renumberSteps(steps.filter((step) => step.stepNo < aggregateStep.stepNo));
      const contextArg = args.context ?? this.latestStepOutputRef(prefix, 'inspect_project_context') ?? '{{context.project}}';
      const instructionArg = args.instruction ?? '{{context.userMessage}}';
      return this.buildExpandedChapterOutlineSteps(prefix, contextArg, instructionArg, volumeNo, chapterCount, registeredTools, requiresApproval);
    }

    const chapterSteps = steps.filter((step) => step.tool === GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL);
    if (!chapterSteps.length) return steps;
    const firstChapterStep = chapterSteps[0];
    const chapterCount = this.positiveInt(firstChapterStep.args.chapterCount) ?? chapterSteps.length;
    const volumeNo = this.positiveInt(firstChapterStep.args.volumeNo) ?? 1;
    const prefix = this.renumberSteps(steps.filter((step) => step.stepNo < firstChapterStep.stepNo));
    const contextArg = firstChapterStep.args.context ?? this.latestStepOutputRef(prefix, 'inspect_project_context') ?? '{{context.project}}';
    const instructionArg = firstChapterStep.args.instruction ?? '{{context.userMessage}}';
    return this.buildExpandedChapterOutlineSteps(prefix, contextArg, instructionArg, volumeNo, chapterCount, registeredTools, requiresApproval);
  }

  private buildExpandedChapterOutlineSteps(
    prefix: AgentPlanStepSpec[],
    contextArg: unknown,
    instructionArg: unknown,
    volumeNo: number,
    chapterCount: number,
    registeredTools: Set<string>,
    requiresApproval: (tool: string) => boolean,
  ): AgentPlanStepSpec[] {
    const steps = [...prefix];
    const chapterSteps: AgentPlanStepSpec[] = [];
    for (let chapterNo = 1; chapterNo <= chapterCount; chapterNo += 1) {
      const previous = chapterSteps.at(-1);
      const stepNo = steps.length + 1;
      const step: AgentPlanStepSpec = {
        id: `chapter_outline_${String(chapterNo).padStart(3, '0')}`,
        stepNo,
        name: `生成第 ${chapterNo} 章单章细纲`,
        purpose: `生成第 ${chapterNo}/${chapterCount} 章章节细纲与 Chapter.craftBrief 执行卡。`,
        tool: GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL,
        mode: 'act',
        requiresApproval: requiresApproval(GENERATE_CHAPTER_OUTLINE_PREVIEW_TOOL),
        args: this.removeUndefinedArgs({
          context: contextArg,
          instruction: instructionArg,
          volumeNo,
          chapterNo,
          chapterCount,
          previousChapter: previous ? `{{steps.${previous.stepNo}.output.chapter}}` : undefined,
        }),
      };
      steps.push(step);
      chapterSteps.push(step);
    }
    steps.push({
      id: MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL,
      stepNo: steps.length + 1,
      name: '合并所有单章细纲预览',
      purpose: '把每章细纲预览合并为完整 outline_preview，供校验和审批写入使用。',
      tool: MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL,
      mode: 'act',
      requiresApproval: requiresApproval(MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL),
      args: {
        previews: chapterSteps.map((step) => `{{steps.${step.stepNo}.output}}`),
        volumeNo,
        chapterCount,
        instruction: instructionArg,
      },
    });
    return this.ensureOutlineValidateAndPersistSteps(steps, MERGE_CHAPTER_OUTLINE_PREVIEWS_TOOL, registeredTools, requiresApproval);
  }

  private ensureOutlineValidateAndPersistSteps(steps: AgentPlanStepSpec[], previewTool: string, registeredTools: Set<string>, requiresApproval: (tool: string) => boolean): AgentPlanStepSpec[] {
    const withoutOld = this.renumberSteps(steps.filter((step) => step.tool !== 'validate_outline' && step.tool !== 'persist_outline'));
    const previewStep = [...withoutOld].reverse().find((step) => step.tool === previewTool);
    if (!previewStep) return steps;
    let normalized = withoutOld;
    if (registeredTools.has('validate_outline')) {
      normalized = [
        ...normalized,
        {
          id: 'validate_outline',
          stepNo: normalized.length + 1,
          name: '校验合并后的完整细纲',
          purpose: '校验章节数量、编号连续性、字段完整性和 craftBrief 质量。',
          tool: 'validate_outline',
          mode: 'act',
          requiresApproval: requiresApproval('validate_outline'),
          args: { preview: `{{steps.${previewStep.stepNo}.output}}` },
        },
      ];
    }
    if (registeredTools.has('persist_outline')) {
      const validateStep = [...normalized].reverse().find((step) => step.tool === 'validate_outline');
      normalized = [
        ...normalized,
        {
          id: 'persist_outline',
          stepNo: normalized.length + 1,
          name: '审批后写入完整细纲',
          purpose: '用户审批后把完整 outline_preview 写入卷和 planned 章节。',
          tool: 'persist_outline',
          mode: 'act',
          requiresApproval: requiresApproval('persist_outline'),
          args: this.removeUndefinedArgs({
            preview: `{{steps.${previewStep.stepNo}.output}}`,
            validation: validateStep ? `{{steps.${validateStep.stepNo}.output}}` : undefined,
          }),
        },
      ];
    }
    return normalized;
  }

  private latestStepOutputRef(steps: AgentPlanStepSpec[], tool: string): string | undefined {
    const step = [...steps].reverse().find((item) => item.tool === tool);
    return step ? `{{steps.${step.stepNo}.output}}` : undefined;
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
