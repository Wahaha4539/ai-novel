import { Injectable } from '@nestjs/common';
import { ToolRegistryService } from '../../../agent-tools/tool-registry.service';
import type { ToolManifestForPlanner } from '../../../agent-tools/tool-manifest.types';
import type { RouteDecision, SelectedToolBundle } from '../planner-graph.state';
import { guidedToolBundles } from './guided.tool-bundle';
import { importToolBundles } from './import.tool-bundle';
import { outlineToolBundles } from './outline.tool-bundle';
import { qualityToolBundles } from './quality.tool-bundle';
import { revisionToolBundles } from './revision.tool-bundle';
import { timelineToolBundles } from './timeline.tool-bundle';
import type { ToolBundleDefinition } from './tool-bundle.types';
import { worldbuildingToolBundles } from './worldbuilding.tool-bundle';
import { writingToolBundles } from './writing.tool-bundle';

export const TOOL_BUNDLE_DEFINITIONS: ToolBundleDefinition[] = [
  ...outlineToolBundles,
  ...writingToolBundles,
  ...revisionToolBundles,
  ...importToolBundles,
  ...guidedToolBundles,
  ...timelineToolBundles,
  ...qualityToolBundles,
  ...worldbuildingToolBundles,
];

@Injectable()
export class ToolBundleRegistry {
  constructor(private readonly tools: ToolRegistryService) {}

  listDefinitions(): ToolBundleDefinition[] {
    return TOOL_BUNDLE_DEFINITIONS.map((definition) => this.cloneDefinition(definition));
  }

  getDefinition(name: string): ToolBundleDefinition {
    const definition = TOOL_BUNDLE_DEFINITIONS.find((item) => item.name === name);
    if (!definition) throw new Error(`ToolBundle not found: ${name}`);
    return this.cloneDefinition(definition);
  }

  resolveBundle(name: string): SelectedToolBundle {
    const definition = this.getDefinition(name);
    this.assertDefinitionToolsRegistered(definition);
    return {
      bundleName: definition.name,
      strictToolNames: [...definition.strictToolNames],
      optionalToolNames: [...(definition.optionalToolNames ?? [])],
      ...(definition.deniedToolNames?.length ? { deniedToolNames: [...definition.deniedToolNames] } : {}),
      selectionReason: definition.plannerGuidance.join(' '),
    };
  }

  listManifestsForBundle(bundle: SelectedToolBundle): ToolManifestForPlanner[] {
    return this.tools.listManifestsForPlanner(bundle.strictToolNames);
  }

  resolveForRoute(route: Pick<RouteDecision, 'domain' | 'intent'>): SelectedToolBundle {
    const definition = TOOL_BUNDLE_DEFINITIONS.find((item) => item.domain === route.domain && item.intents.includes(route.intent))
      ?? TOOL_BUNDLE_DEFINITIONS.find((item) => item.domain === route.domain);
    if (!definition) throw new Error(`No ToolBundle for route ${route.domain}:${route.intent}`);
    return this.resolveBundle(definition.name);
  }

  assertAllBundlesRegistered(): void {
    for (const definition of TOOL_BUNDLE_DEFINITIONS) this.assertDefinitionToolsRegistered(definition);
  }

  registeredToolCount(): number {
    return this.tools.list().length;
  }

  private assertDefinitionToolsRegistered(definition: ToolBundleDefinition): void {
    const registered = new Set(this.tools.list().map((tool) => tool.name));
    const referenced = this.bundleToolNames(definition);
    const missing = referenced.filter((toolName) => !registered.has(toolName));
    if (missing.length) {
      throw new Error(`ToolBundle ${definition.name} references unregistered tools: ${missing.join(', ')}`);
    }
  }

  private bundleToolNames(definition: ToolBundleDefinition): string[] {
    return [...new Set([
      ...definition.strictToolNames,
      ...(definition.optionalToolNames ?? []),
      ...(definition.deniedToolNames ?? []),
    ])];
  }

  private cloneDefinition(definition: ToolBundleDefinition): ToolBundleDefinition {
    return {
      ...definition,
      intents: [...definition.intents],
      strictToolNames: [...definition.strictToolNames],
      optionalToolNames: definition.optionalToolNames ? [...definition.optionalToolNames] : undefined,
      deniedToolNames: definition.deniedToolNames ? [...definition.deniedToolNames] : undefined,
      plannerGuidance: [...definition.plannerGuidance],
    };
  }
}
