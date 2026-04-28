export type AgentObservationErrorCode =
  | 'MISSING_REQUIRED_ARGUMENT'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'ENTITY_NOT_FOUND'
  | 'AMBIGUOUS_ENTITY'
  | 'POLICY_BLOCKED'
  | 'APPROVAL_REQUIRED'
  | 'LLM_JSON_INVALID'
  | 'TOOL_TIMEOUT'
  | 'TOOL_INTERNAL_ERROR'
  | 'VALIDATION_FAILED';

export interface AgentObservation {
  stepId?: string;
  stepNo: number;
  tool: string;
  mode: 'plan' | 'act';
  args: Record<string, unknown>;
  error: {
    code: AgentObservationErrorCode;
    message: string;
    missing?: string[];
    candidates?: unknown[];
    retryable: boolean;
  };
  previousOutputs: Record<string, unknown>;
}

/**
 * Executor 将可恢复 Tool 失败包装为 Observation，Runtime 可据此生成最小 Replan patch。
 * 副作用：无；仅携带已结构化的失败上下文供 trace、artifact 和 replanner 使用。
 */
export class AgentExecutionObservationError extends Error {
  constructor(readonly observation: AgentObservation) {
    super(observation.error.message);
    this.name = 'AgentExecutionObservationError';
  }
}

export interface ReplanPatch {
  action: 'patch_plan' | 'ask_user' | 'fail_with_reason';
  reason: string;
  insertStepsBeforeFailedStep?: Array<{
    id: string;
    stepNo: number;
    name: string;
    purpose: string;
    tool: string;
    mode: 'act';
    requiresApproval: boolean;
    args: Record<string, unknown>;
    produces?: string[];
  }>;
  replaceFailedStepArgs?: Record<string, unknown>;
  questionForUser?: string;
  choices?: Array<{ id: string; label: string; payload: unknown }>;
}

export interface ReplanAttemptStats {
  /** 当前 AgentRun 中已经自动生成过多少次 patch_plan，用于限制总自动修复轮数。 */
  previousAutoPatchCount: number;
  /** 同一 step/tool/errorCode 已经被自动修复过的次数，避免同类错误反复打补丁。 */
  sameStepErrorPatchCount: number;
}