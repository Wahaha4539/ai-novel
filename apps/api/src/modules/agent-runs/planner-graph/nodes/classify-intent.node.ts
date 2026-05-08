import { classifyIntent } from '../supervisors/root-supervisor';
import {
  AgentPlannerGraphState,
  AgentPlannerGraphUpdate,
  appendPlannerGraphNode,
} from '../planner-graph.state';

export async function classifyIntentNode(state: AgentPlannerGraphState): Promise<AgentPlannerGraphUpdate> {
  const route = classifyIntent({ goal: state.goal, context: state.context });
  return {
    route,
    diagnostics: appendPlannerGraphNode(state.diagnostics, {
      name: 'classifyIntent',
      status: 'ok',
      detail: `${route.domain}:${route.intent} confidence=${route.confidence}`,
    }),
  };
}
