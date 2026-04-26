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
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
}

export interface ToolContext {
  agentRunId: string;
  projectId: string;
  chapterId?: string;
  mode: AgentMode;
  approved: boolean;
  userId?: string;
  outputs: Record<number, unknown>;
  policy: Record<string, unknown>;
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

  /**
   * 执行受控工具能力。工具只能通过 Runtime 注入的上下文访问运行态数据，
   * 避免 LLM 直接绕过 Policy 写入业务表。
   */
  run(args: TInput, context: ToolContext): Promise<TOutput>;
}