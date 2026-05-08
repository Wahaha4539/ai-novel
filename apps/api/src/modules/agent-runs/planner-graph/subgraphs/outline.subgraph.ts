import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { AgentContextV2 } from '../../agent-context-builder.service';
import {
  AgentPlannerGraphDiagnostics,
  RouteDecision,
  appendPlannerGraphNode,
  createInitialPlannerGraphDiagnostics,
} from '../planner-graph.state';
import { OutlineSupervisor } from '../supervisors/outline-supervisor';

export interface OutlineSubgraphInput {
  goal: string;
  context?: AgentContextV2;
  diagnostics?: AgentPlannerGraphDiagnostics;
}

export interface OutlineSubgraphState extends OutlineSubgraphInput {
  route?: RouteDecision;
  diagnostics: AgentPlannerGraphDiagnostics;
}

const OutlineSubgraphAnnotation = Annotation.Root({
  goal: Annotation<string>(),
  context: Annotation<AgentContextV2 | undefined>(),
  route: Annotation<RouteDecision | undefined>(),
  diagnostics: Annotation<AgentPlannerGraphDiagnostics>({
    reducer: (_left, right) => right,
    default: createInitialPlannerGraphDiagnostics,
  }),
});

export function buildOutlineSubgraph(supervisor = new OutlineSupervisor()) {
  return new StateGraph(OutlineSubgraphAnnotation)
    .addNode('outlineSupervisor', async (state): Promise<Partial<OutlineSubgraphState>> => {
      const route = supervisor.classify({ goal: state.goal, context: state.context });
      return {
        route,
        diagnostics: appendPlannerGraphNode(state.diagnostics, {
          name: 'outlineSupervisor',
          status: 'ok',
          detail: `${route.outlineIntent}:${route.intent}`,
        }),
      };
    })
    .addEdge(START, 'outlineSupervisor')
    .addEdge('outlineSupervisor', END)
    .compile({
      name: 'outline-subgraph',
      description: 'Classifies outline sub-intents without invoking tools or generating content.',
    });
}

export async function invokeOutlineSubgraph(input: OutlineSubgraphInput): Promise<OutlineSubgraphState> {
  const graph = buildOutlineSubgraph();
  return graph.invoke({
    goal: input.goal,
    context: input.context,
    diagnostics: input.diagnostics ?? createInitialPlannerGraphDiagnostics(),
  });
}
