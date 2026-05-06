import { Injectable, Optional } from '@nestjs/common';
import { ToolRegistryService } from '../agent-tools/tool-registry.service';
import { LlmGatewayService } from '../llm/llm-gateway.service';
import { AgentContextV2 } from './agent-context-builder.service';
import { AgentObservation, ReplanAttemptStats, ReplanPatch } from './agent-observation.types';
import { AgentPlanStepSpec } from './agent-planner.service';

type ReplannerInput = { userGoal: string; currentPlanSteps: AgentPlanStepSpec[]; failedObservation: AgentObservation; agentContext?: AgentContextV2; replanStats?: ReplanAttemptStats };

/**
 * 根据结构化 Observation 生成最小修复补丁。
 * 当前先覆盖缺 ID 与歧义实体等高频可恢复场景；不会绕过审批，也不会重写整份计划。
 */
@Injectable()
export class AgentReplannerService {
  constructor(
    private readonly tools: ToolRegistryService,
    @Optional() private readonly llm?: LlmGatewayService,
  ) {}

  createPatch(input: ReplannerInput): ReplanPatch {
    const { userGoal, currentPlanSteps, failedObservation, agentContext, replanStats } = input;
    const failedStep = currentPlanSteps.find((step) => step.stepNo === failedObservation.stepNo);
    if (!failedObservation.error.retryable || !failedStep) {
      return { action: 'fail_with_reason', reason: '该错误不可安全自动修复，或失败步骤已不在当前计划中。' };
    }

    const approvalBoundary = this.patchApprovalBoundaryFailure(failedObservation);
    if (approvalBoundary) return approvalBoundary;

    const ambiguous = this.patchAmbiguousEntity(failedObservation);
    if (ambiguous) return ambiguous;

    const lowConfidence = this.patchLowConfidenceResolver(failedObservation);
    if (lowConfidence) return lowConfidence;

    const previewValidationRepair = this.patchMissingPreviewValidation(userGoal, failedObservation, failedStep, currentPlanSteps);
    if (previewValidationRepair) return previewValidationRepair;

    const missingField = this.patchMissingToolOutputField(failedObservation, failedStep);
    if (missingField) return missingField;

    const guard = this.guardAutoPatchLimit(replanStats);
    if (guard) return guard;

    const schemaCoercion = this.patchSafeSchemaCoercion(failedObservation);
    if (schemaCoercion) return schemaCoercion;

    const referenceRepair = this.patchInvalidPreviousStepReference(failedObservation, failedStep, currentPlanSteps);
    if (referenceRepair) return referenceRepair;

    const validationRepair = this.patchValidationFailure(failedObservation);
    if (validationRepair) return validationRepair;

    const missingChapterId = failedObservation.error.code === 'MISSING_REQUIRED_ARGUMENT' && failedObservation.error.missing?.includes('chapterId');
    const schemaChapterId = failedObservation.error.code === 'SCHEMA_VALIDATION_FAILED' && this.hasNaturalLanguageId(failedObservation.args, 'chapterId');
    if ((missingChapterId || schemaChapterId) && this.tools.get('resolve_chapter')) {
      return this.patchMissingChapterId(userGoal, failedStep, agentContext);
    }

    const missingCharacterId = failedObservation.error.code === 'MISSING_REQUIRED_ARGUMENT' && failedObservation.error.missing?.includes('characterId');
    const schemaCharacterId = failedObservation.error.code === 'SCHEMA_VALIDATION_FAILED' && this.hasNaturalLanguageId(failedObservation.args, 'characterId');
    if ((missingCharacterId || schemaCharacterId) && this.tools.get('resolve_character')) {
      return this.patchMissingCharacterId(userGoal, failedStep, agentContext);
    }

    return { action: 'fail_with_reason', reason: '当前 Observation 没有匹配到可自动修复的最小补丁。' };
  }

  /**
   * 默认关闭的 LLM Replanner 实验兜底。
   * 只有 deterministic Replanner 返回不可修复时才尝试；输出仍经过硬安全校验，不能绕过审批、低置信度澄清或循环上限。
   */
  async createPatchWithExperimentalFallback(input: ReplannerInput): Promise<ReplanPatch> {
    const deterministic = this.createPatch(input);
    if (deterministic.action !== 'fail_with_reason') return deterministic;
    if (!this.isExperimentalLlmReplannerEnabled() || !this.llm || !this.canTryLlmReplanner(input)) return deterministic;

    try {
      const response = await this.llm.chatJson<ReplanPatch>([
        {
          role: 'system',
          content: [
            '你是 AI Novel 的实验性 Agent Replanner。你只能输出严格 JSON。',
            '只在确定性 Replanner 无法处理时给出一个最小补丁，不要重写整份计划。',
            '不得绕过 Policy、Approval 或 Tool Schema；不得插入写入类、persist_*、write_* 或需审批步骤。',
            'Resolver 低置信度或多候选必须输出 ask_user，不能自动选择候选。',
            '如果无法安全修复，输出 fail_with_reason。',
          ].join('\n'),
        },
        {
          role: 'user',
          content: JSON.stringify({
            userGoal: input.userGoal,
            currentPlanSteps: input.currentPlanSteps,
            failedObservation: input.failedObservation,
            agentContext: input.agentContext,
            deterministicFailure: deterministic.reason,
            outputContract: {
              action: 'patch_plan|ask_user|fail_with_reason',
              reason: 'string',
              insertStepsBeforeFailedStep: 'optional readonly resolver/context steps only',
              replaceFailedStepArgs: 'optional minimal args patch; *.Id must be template references from context or resolver output',
              questionForUser: 'required when ask_user',
              choices: 'optional candidates from observation only',
            },
          }),
        },
      ], { appStep: 'agent_replanner', temperature: 0, maxTokens: 1200, timeoutMs: 30_000, retries: 0 });
      return this.normalizeAndValidateLlmPatch(response.data, input, deterministic);
    } catch (error) {
      return { ...deterministic, reason: `${deterministic.reason}；LLM Replanner 实验降级：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private isExperimentalLlmReplannerEnabled(): boolean {
    return process.env.AGENT_EXPERIMENTAL_LLM_REPLANNER === 'true';
  }

  /** LLM 兜底不处理不可重试、审批/策略阻断和已触达循环上限的场景。 */
  private canTryLlmReplanner(input: ReplannerInput): boolean {
    const code = input.failedObservation.error.code;
    if (!input.failedObservation.error.retryable) return false;
    if (code === 'APPROVAL_REQUIRED' || code === 'POLICY_BLOCKED') return false;
    if (this.guardAutoPatchLimit(input.replanStats)) return false;
    return true;
  }

  private normalizeAndValidateLlmPatch(raw: unknown, input: ReplannerInput, fallback: ReplanPatch): ReplanPatch {
    const patch = raw && typeof raw === 'object' ? raw as ReplanPatch : fallback;
    if (!['patch_plan', 'ask_user', 'fail_with_reason'].includes(patch.action)) return fallback;
    const normalized: ReplanPatch = {
      action: patch.action,
      reason: typeof patch.reason === 'string' && patch.reason.trim() ? `LLM 实验：${patch.reason}` : 'LLM 实验给出修复建议。',
      ...(patch.questionForUser ? { questionForUser: String(patch.questionForUser) } : {}),
      ...(Array.isArray(patch.choices) ? { choices: patch.choices.slice(0, 5).map((choice, index) => ({ id: String(choice.id ?? `candidate_${index + 1}`), label: String(choice.label ?? `候选 ${index + 1}`), payload: choice.payload })) } : {}),
      ...(patch.replaceFailedStepArgs && typeof patch.replaceFailedStepArgs === 'object' ? { replaceFailedStepArgs: patch.replaceFailedStepArgs } : {}),
      ...(Array.isArray(patch.insertStepsBeforeFailedStep) ? { insertStepsBeforeFailedStep: patch.insertStepsBeforeFailedStep.slice(0, 1) } : {}),
    };
    return this.isSafeLlmPatch(normalized, input) ? normalized : fallback;
  }

  /** 实验 LLM patch 只允许只读 resolver/context 修复，ID 只能来自模板引用，避免扩大写入范围。 */
  private isSafeLlmPatch(patch: ReplanPatch, input: ReplannerInput): boolean {
    if (patch.action === 'fail_with_reason') return true;
    if (patch.action === 'ask_user') return Boolean(patch.questionForUser);
    const inserted = patch.insertStepsBeforeFailedStep ?? [];
    if (inserted.some((step) => step.requiresApproval || !this.isAllowedReadOnlyRepairTool(step.tool))) return false;
    const replacements = patch.replaceFailedStepArgs ?? {};
    if (Object.entries(replacements).some(([key, value]) => /(^id$|Id$)/.test(key) && !this.isSafeIdReplacement(value))) return false;
    const failedStep = input.currentPlanSteps.find((step) => step.stepNo === input.failedObservation.stepNo);
    if (!failedStep) return false;
    return !inserted.some((step) => step.tool.startsWith('write_') || step.tool.startsWith('persist_'));
  }

  private isSafeIdReplacement(value: unknown): boolean {
    return typeof value === 'string' && /^{{(steps\.[A-Za-z0-9_]+\.output\.[A-Za-z0-9_]+|context\.[A-Za-z0-9_.]+)}}$/.test(value);
  }

  private isAllowedReadOnlyRepairTool(tool: string): boolean {
    return [
      'resolve_chapter',
      'resolve_character',
      'collect_task_context',
      'collect_chapter_context',
      'inspect_project_context',
      'generate_story_bible_preview',
      'validate_story_bible',
      'generate_scene_cards_preview',
      'validate_scene_cards',
      'list_scene_cards',
      'generate_continuity_preview',
      'validate_continuity_changes',
    ].includes(tool);
  }

  /** 自动修复必须有界：总轮数和同类错误都设硬上限，避免 Replan 循环扩大风险。 */
  private guardAutoPatchLimit(stats?: ReplanAttemptStats): ReplanPatch | undefined {
    if (!stats) return undefined;
    if (stats.previousAutoPatchCount >= 2) {
      return { action: 'fail_with_reason', reason: '自动修复已达到本次 AgentRun 的 2 次上限，请人工检查计划后重新规划。' };
    }
    if (stats.sameStepErrorPatchCount >= 1) {
      return { action: 'fail_with_reason', reason: '同一步骤的同类错误已经自动修复过 1 次，继续重试可能形成循环，请人工检查参数或上下文。' };
    }
    return undefined;
  }

  private patchMissingChapterId(userGoal: string, failedStep: AgentPlanStepSpec, agentContext?: AgentContextV2): ReplanPatch {
    const resolver = this.tools.get('resolve_chapter');
    const resolverStepId = this.uniqueRepairStepId('resolve_chapter_for_failed_step', failedStep.stepNo);
    return {
      action: 'patch_plan',
      reason: '失败步骤缺少真实 chapterId，需要先把用户的章节自然语言引用解析为系统章节 ID。',
      insertStepsBeforeFailedStep: [{
        id: resolverStepId,
        stepNo: failedStep.stepNo,
        name: '解析失败步骤所需章节',
        purpose: '将用户目标中的章节引用解析为真实 chapterId，避免自然语言冒充内部 ID。',
        tool: 'resolve_chapter',
        mode: 'act',
        requiresApproval: resolver?.requiresApproval ?? false,
        args: {
          projectId: agentContext?.session.currentProjectId ? '{{context.session.currentProjectId}}' : undefined,
          chapterRef: userGoal,
          currentChapterId: agentContext?.session.currentChapterId ? '{{context.session.currentChapterId}}' : undefined,
        },
        produces: ['chapterResolution'],
      }],
      replaceFailedStepArgs: { chapterId: `{{steps.${resolverStepId}.output.chapterId}}` },
    };
  }

  private patchMissingCharacterId(userGoal: string, failedStep: AgentPlanStepSpec, agentContext?: AgentContextV2): ReplanPatch {
    const resolver = this.tools.get('resolve_character');
    const resolverStepId = this.uniqueRepairStepId('resolve_character_for_failed_step', failedStep.stepNo);
    return {
      action: 'patch_plan',
      reason: '失败步骤缺少真实 characterId，需要先解析用户提到的角色引用。',
      insertStepsBeforeFailedStep: [{
        id: resolverStepId,
        stepNo: failedStep.stepNo,
        name: '解析失败步骤所需角色',
        purpose: '将用户目标中的角色引用解析为真实 characterId，低置信度时由 resolver 返回候选供用户选择。',
        tool: 'resolve_character',
        mode: 'act',
        requiresApproval: resolver?.requiresApproval ?? false,
        args: {
          projectId: agentContext?.session.currentProjectId ? '{{context.session.currentProjectId}}' : undefined,
          characterRef: userGoal,
        },
        produces: ['characterResolution'],
      }],
      replaceFailedStepArgs: { characterId: `{{steps.${resolverStepId}.output.characterId}}` },
    };
  }

  private patchAmbiguousEntity(observation: AgentObservation): ReplanPatch | undefined {
    if (observation.error.code !== 'AMBIGUOUS_ENTITY') return undefined;
    const candidates = observation.error.candidates ?? [];
    return {
      action: 'ask_user',
      reason: '实体解析存在多个接近候选，自动选择可能导致误写。',
      questionForUser: '我不确定你指的是哪一个对象，请选择后我继续。',
      choices: candidates.map((candidate, index) => ({ id: `candidate_${index + 1}`, label: this.formatCandidateLabel(candidate, index), payload: candidate })),
    };
  }

  /** Resolver 低置信度不能由 Replanner 自动选中候选，只能显式交给用户确认。 */
  private patchLowConfidenceResolver(observation: AgentObservation): ReplanPatch | undefined {
    if (observation.error.code !== 'VALIDATION_FAILED' || !observation.tool.startsWith('resolve_')) return undefined;
    const candidates = observation.error.candidates ?? [];
    if (!candidates.length && !/低置信度|confidence|置信度/.test(observation.error.message)) return undefined;
    return {
      action: 'ask_user',
      reason: 'Resolver 返回低置信度结果，自动选择可能把自然语言引用解析到错误实体。',
      questionForUser: '我找到了一些可能的对象，但置信度不够高，请选择你真正指的是哪一个。',
      choices: candidates.map((candidate, index) => ({ id: `candidate_${index + 1}`, label: this.formatCandidateLabel(candidate, index), payload: candidate })),
    };
  }

  /** 上游工具输出缺少下游必填字段时，不盲目重跑写入步骤；有候选则澄清，否则安全失败。 */
  private patchMissingToolOutputField(observation: AgentObservation, failedStep: AgentPlanStepSpec): ReplanPatch | undefined {
    if (observation.error.code !== 'MISSING_REQUIRED_ARGUMENT') return undefined;
    const missingField = observation.error.missing?.find((field) => typeof failedStep.args[field] === 'string' && String(failedStep.args[field]).startsWith('{{steps.'));
    if (!missingField) return undefined;
    const candidates = this.findCandidatesInPreviousOutputs(observation.previousOutputs);
    if (candidates.length) {
      return {
        action: 'ask_user',
        reason: `前序工具输出缺少 ${missingField}，但返回了候选项，需要用户确认后才能继续。`,
        questionForUser: `前序工具没有给出可直接使用的 ${missingField}，请选择正确对象。`,
        choices: candidates.map((candidate, index) => ({ id: `candidate_${index + 1}`, label: this.formatCandidateLabel(candidate, index), payload: candidate })),
      };
    }
    return { action: 'fail_with_reason', reason: `前序工具输出缺少 ${missingField}，且没有候选可供选择，不能安全自动修复。` };
  }

  /** 只做显然安全的 schema 类型转换，例如 “3500” → 3500；ID 和引用字符串绝不转换。 */
  private patchSafeSchemaCoercion(observation: AgentObservation): ReplanPatch | undefined {
    if (observation.error.code !== 'SCHEMA_VALIDATION_FAILED') return undefined;
    const replacements: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(observation.args)) {
      if (!this.isSafelyCoercibleNumberField(key, value)) continue;
      replacements[key] = Number(String(value).trim());
    }
    if (!Object.keys(replacements).length) return undefined;
    return {
      action: 'patch_plan',
      reason: 'Tool schema 校验失败，但存在可安全转换的数值类型参数，因此仅做最小类型转换补丁。',
      replaceFailedStepArgs: replacements,
    };
  }

  /** 修复 LLM 把 context 参数错误指向未来步骤/不存在步骤的常见引用问题。 */
  private patchInvalidPreviousStepReference(observation: AgentObservation, failedStep: AgentPlanStepSpec, currentPlanSteps: AgentPlanStepSpec[]): ReplanPatch | undefined {
    if (observation.error.code !== 'SCHEMA_VALIDATION_FAILED' || !/引用|非前序步骤|future|previous step/i.test(observation.error.message)) return undefined;
    const previousContextStep = [...currentPlanSteps]
      .filter((step) => step.stepNo < failedStep.stepNo && ['collect_task_context', 'collect_chapter_context', 'inspect_project_context'].includes(step.tool))
      .at(-1);
    if (!previousContextStep) return undefined;
    const stepRef = previousContextStep.id ?? String(previousContextStep.stepNo);
    return {
      action: 'patch_plan',
      reason: '失败步骤引用了当前或未来步骤输出，需要改为引用已完成的前序上下文步骤。',
      replaceFailedStepArgs: { context: `{{steps.${stepRef}.output}}` },
    };
  }

  /** validation failed 场景只允许收紧为最小修复，不扩大写入范围或自动绕过审批。 */
  private patchValidationFailure(observation: AgentObservation): ReplanPatch | undefined {
    if (observation.error.code !== 'VALIDATION_FAILED' || observation.tool !== 'auto_repair_chapter') return undefined;
    return {
      action: 'patch_plan',
      reason: '章节校验失败后只能进行最小必要修复，限制修复轮数并强化不改剧情事实的约束。',
      replaceFailedStepArgs: {
        maxRounds: 1,
        instruction: '仅根据 validation failed 的具体问题做最小必要修复；不得新增重大剧情、角色长期状态或世界观设定。',
      },
    };
  }

  private patchApprovalBoundaryFailure(observation: AgentObservation): ReplanPatch | undefined {
    if (observation.error.code !== 'APPROVAL_REQUIRED') return undefined;
    return {
      action: 'fail_with_reason',
      reason: 'Write tool is missing explicit user approval. Replan must not insert write steps or bypass approval; return to the approval flow before retrying persist.',
    };
  }

  private patchMissingPreviewValidation(userGoal: string, observation: AgentObservation, failedStep: AgentPlanStepSpec, currentPlanSteps: AgentPlanStepSpec[]): ReplanPatch | undefined {
    const config = this.previewValidationRepairConfig(observation.tool);
    if (!config || observation.error.code !== 'MISSING_REQUIRED_ARGUMENT') return undefined;

    const missing = new Set(observation.error.missing ?? []);
    const missingPreview = missing.has('preview') || !this.isSafePreviousStepOutputReference(failedStep.args.preview);
    const missingValidation = missing.has('validation') || !this.isSafePreviousStepOutputReference(failedStep.args.validation);
    if (!missingPreview && !missingValidation) return undefined;
    if (!this.tools.get(config.previewTool) || !this.tools.get(config.validateTool) || !this.tools.get('collect_task_context')) return undefined;

    const insertStepsBeforeFailedStep: NonNullable<ReplanPatch['insertStepsBeforeFailedStep']> = [];
    const existingContextStep = this.findPreviousReadOnlyContextStep(currentPlanSteps, failedStep);
    const contextRef = existingContextStep
      ? `{{steps.${existingContextStep.id ?? existingContextStep.stepNo}.output}}`
      : `{{steps.${config.collectStepId}.output}}`;

    if (!existingContextStep) {
      insertStepsBeforeFailedStep.push({
        id: config.collectStepId,
        stepNo: failedStep.stepNo,
        name: config.collectName,
        purpose: 'Collect read-only context required to rebuild missing preview and validation artifacts without writing business data.',
        tool: 'collect_task_context',
        mode: 'act',
        requiresApproval: this.tools.get('collect_task_context')?.requiresApproval ?? false,
        args: { taskType: config.taskType, focus: config.contextFocus, instruction: userGoal },
        produces: ['taskContext'],
      });
    }

    const previewRef = missingPreview ? `{{steps.${config.previewStepId}.output}}` : String(failedStep.args.preview);
    if (missingPreview) {
      insertStepsBeforeFailedStep.push({
        id: config.previewStepId,
        stepNo: failedStep.stepNo,
        name: config.previewName,
        purpose: 'Recreate the missing read-only preview artifact before retrying the existing persist step.',
        tool: config.previewTool,
        mode: 'act',
        requiresApproval: this.tools.get(config.previewTool)?.requiresApproval ?? false,
        args: { context: contextRef, instruction: userGoal },
        produces: ['preview'],
      });
    }

    const validationRef = (missingValidation || missingPreview) ? `{{steps.${config.validateStepId}.output}}` : String(failedStep.args.validation);
    if (missingValidation || missingPreview) {
      insertStepsBeforeFailedStep.push({
        id: config.validateStepId,
        stepNo: failedStep.stepNo,
        name: config.validateName,
        purpose: 'Validate the read-only preview artifact before the existing persist step can retry.',
        tool: config.validateTool,
        mode: 'act',
        requiresApproval: this.tools.get(config.validateTool)?.requiresApproval ?? false,
        args: { preview: previewRef, taskContext: contextRef },
        produces: ['validation'],
      });
    }

    if (insertStepsBeforeFailedStep.some((step) => step.requiresApproval || !this.isAllowedReadOnlyRepairTool(step.tool))) return undefined;

    return {
      action: 'patch_plan',
      reason: config.reason,
      insertStepsBeforeFailedStep,
      replaceFailedStepArgs: { preview: previewRef, validation: validationRef },
    };
  }

  private previewValidationRepairConfig(tool: string): {
    taskType: string;
    collectStepId: string;
    collectName: string;
    previewStepId: string;
    previewName: string;
    previewTool: string;
    validateStepId: string;
    validateName: string;
    validateTool: string;
    contextFocus: string[];
    reason: string;
  } | undefined {
    if (tool === 'persist_story_bible') {
      return {
        taskType: 'story_bible_expand',
        collectStepId: 'collect_story_bible_context_for_failed_persist',
        collectName: 'Collect Story Bible context',
        previewStepId: 'generate_story_bible_preview_for_failed_persist',
        previewName: 'Regenerate Story Bible preview',
        previewTool: 'generate_story_bible_preview',
        validateStepId: 'validate_story_bible_for_failed_persist',
        validateName: 'Validate Story Bible preview',
        validateTool: 'validate_story_bible',
        contextFocus: ['world_facts', 'plot_events', 'memory_chunks'],
        reason: 'persist_story_bible is missing preview or validation output. Replan may only insert read-only collect_task_context, generate_story_bible_preview, and validate_story_bible steps before retrying; it must not add writes or bypass approval.',
      };
    }
    if (tool === 'persist_continuity_changes') {
      return {
        taskType: 'continuity_check',
        collectStepId: 'collect_continuity_context_for_failed_persist',
        collectName: 'Collect continuity context',
        previewStepId: 'generate_continuity_preview_for_failed_persist',
        previewName: 'Regenerate continuity preview',
        previewTool: 'generate_continuity_preview',
        validateStepId: 'validate_continuity_changes_for_failed_persist',
        validateName: 'Validate continuity preview',
        validateTool: 'validate_continuity_changes',
        contextFocus: ['relationship_graph', 'timeline_events', 'world_facts', 'memory_chunks'],
        reason: 'persist_continuity_changes is missing continuity preview or validation output. Replan may only insert read-only collect_task_context, generate_continuity_preview, and validate_continuity_changes steps before retrying; it must not add writes or bypass approval.',
      };
    }
    if (tool === 'persist_scene_cards') {
      return {
        taskType: 'scene_card_planning',
        collectStepId: 'collect_scene_card_context_for_failed_persist',
        collectName: 'Collect SceneCard context',
        previewStepId: 'generate_scene_cards_preview_for_failed_persist',
        previewName: 'Regenerate SceneCard preview',
        previewTool: 'generate_scene_cards_preview',
        validateStepId: 'validate_scene_cards_for_failed_persist',
        validateName: 'Validate SceneCard preview',
        validateTool: 'validate_scene_cards',
        contextFocus: ['outline', 'characters', 'pacing', 'scene_cards'],
        reason: 'persist_scene_cards is missing preview or validation output. Replan may only insert read-only collect_task_context, generate_scene_cards_preview, and validate_scene_cards steps before retrying; it must not add writes or bypass approval.',
      };
    }
    return undefined;
  }

  private findPreviousReadOnlyContextStep(currentPlanSteps: AgentPlanStepSpec[], failedStep: AgentPlanStepSpec): AgentPlanStepSpec | undefined {
    return [...currentPlanSteps]
      .filter((step) => step.stepNo < failedStep.stepNo && ['collect_task_context', 'collect_chapter_context', 'inspect_project_context'].includes(step.tool))
      .at(-1);
  }

  private isSafePreviousStepOutputReference(value: unknown): boolean {
    return typeof value === 'string' && /^{{steps\.[A-Za-z0-9_-]+\.output(?:\.[A-Za-z0-9_.-]+)?}}$/.test(value);
  }

  private hasNaturalLanguageId(args: Record<string, unknown>, key: string): boolean {
    const value = args[key];
    return typeof value === 'string' && !value.startsWith('{{') && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private isSafelyCoercibleNumberField(key: string, value: unknown): boolean {
    if (/(^id$|Id$|Ref$)/.test(key) || typeof value !== 'string' || value.startsWith('{{')) return false;
    if (!/^(targetWordCount|wordCount|maxRounds|chapterNo|chapterIndex|versionNo|priority)$/.test(key)) return false;
    return /^\d+(?:\.\d+)?$/.test(value.trim());
  }

  private findCandidatesInPreviousOutputs(previousOutputs: Record<string, unknown>): unknown[] {
    for (const output of Object.values(previousOutputs)) {
      if (!output || typeof output !== 'object') continue;
      const record = output as Record<string, unknown>;
      const candidates = Array.isArray(record.candidates) ? record.candidates : Array.isArray(record.alternatives) ? record.alternatives : [];
      if (candidates.length) return candidates;
    }
    return [];
  }

  private uniqueRepairStepId(base: string, failedStepNo: number): string {
    return `${base}_${failedStepNo}`;
  }

  private formatCandidateLabel(candidate: unknown, index: number): string {
    if (candidate && typeof candidate === 'object') {
      const record = candidate as Record<string, unknown>;
      return String(record.name ?? record.title ?? record.label ?? `候选 ${index + 1}`);
    }
    return String(candidate ?? `候选 ${index + 1}`);
  }
}
