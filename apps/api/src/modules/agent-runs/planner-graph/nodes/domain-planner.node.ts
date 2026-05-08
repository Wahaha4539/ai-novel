import type { AgentPlanWithToolsInput, AgentPlannerService } from '../../agent-planner.service';
import {
  AgentPlannerGraphState,
  AgentPlannerGraphUpdate,
  appendPlannerGraphNode,
} from '../planner-graph.state';

type DomainPlanner = Pick<AgentPlannerService, 'createPlanWithTools'>;

export function createDomainPlannerNode(planner: DomainPlanner) {
  return async function domainPlannerNode(state: AgentPlannerGraphState): Promise<AgentPlannerGraphUpdate> {
    if (!state.selectedTools?.length) throw new Error('domainPlannerNode requires selected tools');
    const input: AgentPlanWithToolsInput = {
      goal: state.goal,
      context: state.context,
      route: state.route,
      selectedBundle: state.selectedBundle,
      selectedTools: state.selectedTools,
    };
    const plan = await planner.createPlanWithTools(input);
    return {
      plan,
      diagnostics: appendPlannerGraphNode(state.diagnostics, {
        name: 'domainPlanner',
        status: 'ok',
        detail: `${state.selectedBundle?.bundleName ?? 'no_bundle'} plan=${plan.taskType}`,
      }),
    };
  };
}
