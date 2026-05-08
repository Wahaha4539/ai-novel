export interface AgentPolicyConfig {
  limits: {
    maxSteps: number;
    maxLlmCalls: number;
  };
  secondConfirmRiskIds: string[];
  destructiveSideEffects: string[];
  factLayerSideEffects: string[];
}

export interface BuiltinHardRule {
  id: string;
  text: string;
}

export const BUILTIN_POLICY_CONFIG: AgentPolicyConfig = {
  limits: {
    maxSteps: 100,
    maxLlmCalls: 2,
  },
  secondConfirmRiskIds: ['high_risk', 'destructive_side_effect', 'fact_layer_write', 'delete_side_effect'],
  destructiveSideEffects: ['delete', 'remove', 'replace'],
  factLayerSideEffects: ['fact', 'story_event', 'character_state', 'foreshadow', 'memory'],
};

export const BUILTIN_HARD_RULES: BuiltinHardRule[] = [
  { id: 'plan_no_side_effects', text: 'Plan 模式禁止写正式业务表' },
  { id: 'act_only_planned_tools', text: 'Act 模式只能执行已批准计划' },
  { id: 'registered_tools_only', text: '禁止调用未注册工具' },
  { id: 'tool_approval_required', text: 'requiresApproval=true 的 Tool 必须存在用户审批' },
  { id: 'max_steps', text: `自动执行步骤数不得超过 ${BUILTIN_POLICY_CONFIG.limits.maxSteps}` },
  { id: 'max_batch_chapters', text: '连续生成多章正文时单次不得超过 5 章' },
  { id: 'max_llm_calls', text: `Planner LLM 调用次数不得超过 ${BUILTIN_POLICY_CONFIG.limits.maxLlmCalls}` },
  { id: 'second_confirm_high_risk', text: '高风险、删除、覆盖事实层或破坏性副作用步骤必须二次确认' },
];
