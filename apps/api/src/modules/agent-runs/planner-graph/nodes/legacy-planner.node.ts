import {
  AgentPlannerGraphState,
  AgentPlannerGraphUpdate,
  appendPlannerGraphNode,
} from '../planner-graph.state';

export async function legacyPlannerNode(state: AgentPlannerGraphState): Promise<AgentPlannerGraphUpdate> {
  return {
    plan: state.plan,
    diagnostics: appendPlannerGraphNode(state.diagnostics, {
      name: 'legacyPlanner',
      status: 'ok',
      detail: state.plan
        ? 'Returned legacy AgentPlanSpec from graph state.'
        : 'Graph scaffold invoked without a legacy plan.',
    }),
  };
}
