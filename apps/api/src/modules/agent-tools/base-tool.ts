import type { ToolManifestV2 } from './tool-manifest.types';

export type AgentMode = 'plan' | 'act';
export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type ToolSchemaType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export const stringSchema: ToolJsonSchema = { type: 'string' };
export const numberSchema: ToolJsonSchema = { type: 'number' };
export const booleanSchema: ToolJsonSchema = { type: 'boolean' };
export const nullableStringSchema: ToolJsonSchema = { type: ['string', 'null'] };
export const anyObjectSchema: ToolJsonSchema = { type: 'object' };
export const anyArraySchema: ToolJsonSchema = { type: 'array' };

export interface ToolJsonSchema {
  type?: ToolSchemaType | readonly ToolSchemaType[];
  required?: string[];
  properties?: Record<string, ToolJsonSchema>;
  items?: ToolJsonSchema;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean;
}

export interface ToolLlmUsage {
  appStep?: string;
  model?: string;
  usage?: Record<string, number>;
  rawPayloadSummary?: Record<string, unknown>;
  elapsedMs?: number;
}

export interface ToolRepairDiagnostic {
  toolName: string;
  attempted: true;
  attempts: number;
  repairedFromErrors: string[];
  model?: string;
  failedError?: string;
}

export interface ToolProgressPatch {
  phase?: string;
  phaseMessage?: string;
  progressCurrent?: number;
  progressTotal?: number;
  timeoutMs?: number;
  deadlineMs?: number;
}

export interface ToolContext {
  agentRunId: string;
  projectId: string;
  chapterId?: string;
  mode: AgentMode;
  approved: boolean;
  userId?: string;
  outputs: Record<number, unknown>;
  stepTools?: Record<number, string>;
  policy: Record<string, unknown>;
  recordLlmUsage?: (usage: ToolLlmUsage) => void;
  recordRepairDiagnostic?: (diagnostic: ToolRepairDiagnostic) => void;
  updateProgress?: (patch: ToolProgressPatch) => Promise<void>;
  heartbeat?: (patch?: ToolProgressPatch) => Promise<void>;
  signal?: AbortSignal;
}

export interface BaseTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;
  allowedModes: AgentMode[];
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  sideEffects: string[];
  /** Optional wall-clock timeout for slow tools such as long-form chapter generation. Defaults to Executor's standard timeout. */
  executionTimeoutMs?: number;

  /**
   * LLM 友好的 Tool Manifest V2。字段保持可选，便于现有工具渐进补齐语义说明。
   */
  manifest?: ToolManifestV2;

  /**
   * 执行受控工具能力。工具只能通过 Runtime 注入的上下文访问运行态数据，
   * 避免 LLM 直接绕过 Policy 写入业务表。
   */
  run(args: TInput, context: ToolContext): Promise<TOutput>;
}
