import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { legacyPlannerNode } from './nodes';
import {
  AgentPlannerGraphDiagnostics,
  AgentPlannerGraphInput,
  AgentPlannerGraphState,
  PlannerGraphOutputDefaults,
  RouteDecision,
  SelectedToolBundle,
  createAgentPlannerGraphInitialState,
  createInitialPlannerGraphDiagnostics,
} from './planner-graph.state';
import type { ToolManifestForPlanner } from '../../agent-tools/tool-manifest.types';
import type { AgentContextV2 } from '../agent-context-builder.service';
import type { AgentPlanSpec } from '../agent-planner.service';

export const AgentPlannerGraphAnnotation = Annotation.Root({
  goal: Annotation<string>(),
  context: Annotation<AgentContextV2 | undefined>(),
  defaults: Annotation<PlannerGraphOutputDefaults>(),
  route: Annotation<RouteDecision | undefined>(),
  selectedBundle: Annotation<SelectedToolBundle | undefined>(),
  selectedTools: Annotation<ToolManifestForPlanner[] | undefined>(),
  plan: Annotation<AgentPlanSpec | undefined>(),
  validationErrors: Annotation<string[] | undefined>(),
  diagnostics: Annotation<AgentPlannerGraphDiagnostics>({
    reducer: (_left, right) => right,
    default: createInitialPlannerGraphDiagnostics,
  }),
});

export function buildAgentPlannerGraph() {
  return new StateGraph(AgentPlannerGraphAnnotation)
    .addNode('legacyPlanner', legacyPlannerNode)
    .addEdge(START, 'legacyPlanner')
    .addEdge('legacyPlanner', END)
    .compile({
      name: 'agent-planner-graph',
      description: 'Agent Supervisor Planner scaffold. Runtime integration is gated in later ASP tasks.',
    });
}

export async function invokeAgentPlannerGraph(input: AgentPlannerGraphInput): Promise<AgentPlannerGraphState> {
  const graph = buildAgentPlannerGraph();
  return graph.invoke(createAgentPlannerGraphInitialState(input));
}
