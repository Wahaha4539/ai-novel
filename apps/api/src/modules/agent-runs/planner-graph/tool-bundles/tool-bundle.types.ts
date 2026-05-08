import type { AgentPlannerDomain } from '../planner-graph.state';

export interface ToolBundleDefinition {
  name: string;
  domain: AgentPlannerDomain;
  intents: string[];
  strictToolNames: string[];
  optionalToolNames?: string[];
  deniedToolNames?: string[];
  plannerGuidance: string[];
}
