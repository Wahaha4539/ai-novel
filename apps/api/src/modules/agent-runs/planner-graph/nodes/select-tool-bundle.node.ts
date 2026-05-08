import {
  AgentPlannerGraphState,
  AgentPlannerGraphUpdate,
  appendPlannerGraphNode,
} from '../planner-graph.state';
import { ToolBundleRegistry } from '../tool-bundles';

export function createSelectToolBundleNode(registry: ToolBundleRegistry) {
  return async function selectToolBundleNode(state: AgentPlannerGraphState): Promise<AgentPlannerGraphUpdate> {
    if (!state.route) throw new Error('selectToolBundleNode requires route decision');
    const selectedBundle = state.context?.session.guided?.currentStep
      ? registry.resolveBundle('guided.step')
      : registry.resolveForRoute(state.route);
    const selectedTools = registry.listManifestsForBundle(selectedBundle);
    return {
      selectedBundle,
      selectedTools,
      diagnostics: {
        ...appendPlannerGraphNode(state.diagnostics, {
          name: 'selectToolBundle',
          status: 'ok',
          detail: `${selectedBundle.bundleName} selectedTools=${selectedTools.length}`,
        }),
        selectedToolCount: selectedTools.length,
        allToolCount: registry.registeredToolCount(),
      },
    };
  };
}
