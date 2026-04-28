import type { AgentMode, ToolJsonSchema, ToolRiskLevel } from './base-tool';

export interface ToolParameterHint {
  source: 'context' | 'resolver' | 'previous_step' | 'user_message' | 'literal' | 'runtime';
  description: string;
  resolverTool?: string;
  examples?: string[];
}

export interface ToolManifestExampleStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface ToolManifestExample {
  user: string;
  context?: Record<string, unknown>;
  plan: ToolManifestExampleStep[];
}

export interface ToolFailureHint {
  code: string;
  meaning: string;
  suggestedRepair: string;
}

export interface ToolIdPolicy {
  forbiddenToInvent: string[];
  allowedSources: string[];
}

export interface ToolArtifactMapping {
  outputPath: string;
  artifactType: string;
  title: string;
}

/**
 * 面向 LLM Planner 的 Tool Manifest V2。
 * 这些字段不改变工具执行契约，只补充“何时用、如何补参、风险是什么”等语义说明。
 */
export interface ToolManifestV2 {
  name: string;
  displayName: string;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputSchema?: ToolJsonSchema;
  outputSchema?: ToolJsonSchema;
  parameterHints?: Record<string, ToolParameterHint>;
  examples?: ToolManifestExample[];
  preconditions?: string[];
  postconditions?: string[];
  failureHints?: ToolFailureHint[];
  allowedModes: AgentMode[];
  riskLevel: ToolRiskLevel;
  requiresApproval: boolean;
  sideEffects: string[];
  idPolicy?: ToolIdPolicy;
  artifactMapping?: ToolArtifactMapping[];
}

export type ToolManifestForPlanner = Pick<
  ToolManifestV2,
  | 'name'
  | 'displayName'
  | 'description'
  | 'whenToUse'
  | 'whenNotToUse'
  | 'inputSchema'
  | 'outputSchema'
  | 'parameterHints'
  | 'examples'
  | 'failureHints'
  | 'allowedModes'
  | 'riskLevel'
  | 'requiresApproval'
  | 'sideEffects'
  | 'idPolicy'
>;