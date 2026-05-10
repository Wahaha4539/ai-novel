import {
  AgentPlannerGraphState,
  AgentPlannerGraphUpdate,
  appendPlannerGraphNode,
} from '../planner-graph.state';
import { invokeOutlineSubgraph } from '../subgraphs/outline.subgraph';
import { ToolBundleRegistry } from '../tool-bundles';

function manifestChars(manifests: unknown[]): number {
  return JSON.stringify(manifests).length;
}

export function createSelectToolBundleNode(registry: ToolBundleRegistry) {
  return async function selectToolBundleNode(state: AgentPlannerGraphState): Promise<AgentPlannerGraphUpdate> {
    if (!state.route) throw new Error('selectToolBundleNode requires route decision');
    const outlineResult = state.route.domain === 'outline' && state.route.intent === 'outline'
      ? await invokeOutlineSubgraph({ goal: state.goal, context: state.context, diagnostics: state.diagnostics })
      : undefined;
    const route = outlineResult?.route ?? state.route;
    const diagnostics = outlineResult?.diagnostics ?? state.diagnostics;
    const selectedBundle = state.context?.session?.guided?.currentStep
      ? registry.resolveBundle('guided.step')
      : registry.resolveForRoute(route, state.context);
    const selectedTools = registry.listManifestsForBundle(selectedBundle);
    const allTools = registry.listAllManifestsForPlanner();
    const selectedToolNames = selectedTools.map((tool) => tool.name);
    const allowedToolNames = [...new Set([...selectedBundle.strictToolNames, ...selectedBundle.optionalToolNames])];
    const selectedToolsChars = manifestChars(selectedTools);
    const allToolsChars = manifestChars(allTools);
    return {
      route,
      selectedBundle,
      selectedTools,
      diagnostics: {
        ...appendPlannerGraphNode(diagnostics, {
          name: 'selectToolBundle',
          status: 'ok',
          detail: `${selectedBundle.bundleName} selectedTools=${selectedTools.length}`,
        }),
        selectedToolCount: selectedTools.length,
        allToolCount: allTools.length || registry.registeredToolCount(),
        route: {
          domain: route.domain,
          intent: route.intent,
          confidence: route.confidence,
        },
        toolBundleName: selectedBundle.bundleName,
        selectedToolNames,
        allowedToolNames,
        selectedToolsChars,
        allToolsChars,
        promptChars: selectedToolsChars,
      },
    };
  };
}
