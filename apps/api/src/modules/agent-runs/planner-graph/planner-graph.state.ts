import type { ToolManifestForPlanner } from '../../agent-tools/tool-manifest.types';
import type { AgentContextV2 } from '../agent-context-builder.service';
import type { AgentPlanSpec } from '../agent-planner.service';

export const AGENT_PLANNER_GRAPH_VERSION = 'agent-supervisor-planner-v1';

export type AgentPlannerDomain =
  | 'outline'
  | 'writing'
  | 'revision'
  | 'worldbuilding'
  | 'timeline'
  | 'import'
  | 'quality'
  | 'guided'
  | 'project_ops'
  | 'general';

export interface RouteDecision {
  domain: AgentPlannerDomain;
  intent: string;
  confidence: number;
  reasons: string[];
  volumeNo?: number;
  chapterNo?: number;
  needsApproval?: boolean;
  needsPersistence?: boolean;
  ambiguity?: {
    needsClarification: boolean;
    questions: string[];
  };
}

export interface SelectedToolBundle {
  bundleName: string;
  strictToolNames: string[];
  optionalToolNames: string[];
  deniedToolNames?: string[];
  selectionReason: string;
}

export interface PlannerGraphOutputDefaults {
  taskType: string;
  summary: string;
  assumptions: string[];
  risks: string[];
}

export interface AgentPlannerGraphDiagnostics {
  graphVersion: string;
  route?: Pick<RouteDecision, 'domain' | 'intent' | 'confidence'>;
  toolBundleName?: string;
  promptChars?: number;
  selectedToolCount?: number;
  allToolCount?: number;
  selectedToolNames?: string[];
  allowedToolNames?: string[];
  selectedToolsChars?: number;
  allToolsChars?: number;
  nodes: Array<{ name: string; status: 'ok' | 'failed'; detail?: string }>;
}

export interface AgentPlannerGraphState {
  goal: string;
  context?: AgentContextV2;
  defaults: PlannerGraphOutputDefaults;
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
  selectedTools?: ToolManifestForPlanner[];
  plan?: AgentPlanSpec;
  validationErrors?: string[];
  diagnostics: AgentPlannerGraphDiagnostics;
}

export type AgentPlannerGraphUpdate = Partial<AgentPlannerGraphState>;

export interface AgentPlannerGraphInput {
  goal: string;
  context?: AgentContextV2;
  defaults: PlannerGraphOutputDefaults;
  legacyPlan?: AgentPlanSpec;
}

export function createInitialPlannerGraphDiagnostics(): AgentPlannerGraphDiagnostics {
  return {
    graphVersion: AGENT_PLANNER_GRAPH_VERSION,
    nodes: [],
  };
}

export function appendPlannerGraphNode(
  diagnostics: AgentPlannerGraphDiagnostics | undefined,
  node: AgentPlannerGraphDiagnostics['nodes'][number],
): AgentPlannerGraphDiagnostics {
  const current = diagnostics ?? createInitialPlannerGraphDiagnostics();
  return {
    ...current,
    nodes: [...current.nodes, node],
  };
}

export function createAgentPlannerGraphInitialState(input: AgentPlannerGraphInput): AgentPlannerGraphState {
  return {
    goal: input.goal,
    context: input.context,
    defaults: input.defaults,
    plan: input.legacyPlan,
    diagnostics: createInitialPlannerGraphDiagnostics(),
  };
}
