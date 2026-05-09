import { Injectable } from '@nestjs/common';
import { ToolRegistryService } from '../../../agent-tools/tool-registry.service';
import type { ToolManifestForPlanner } from '../../../agent-tools/tool-manifest.types';
import type { AgentContextV2 } from '../../agent-context-builder.service';
import type { RouteDecision, SelectedToolBundle } from '../planner-graph.state';
import { guidedToolBundles } from './guided.tool-bundle';
import { importToolBundles, selectImportProjectAssetsStrictTools } from './import.tool-bundle';
import { outlineToolBundles } from './outline.tool-bundle';
import { qualityToolBundles } from './quality.tool-bundle';
import { revisionToolBundles } from './revision.tool-bundle';
import { selectTimelinePlanStrictTools, timelineToolBundles } from './timeline.tool-bundle';
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

  listAllManifestsForPlanner(): ToolManifestForPlanner[] {
    return this.tools.listManifestsForPlanner();
  }

  resolveForRoute(route: Pick<RouteDecision, 'domain' | 'intent' | 'needsPersistence'>, context?: AgentContextV2): SelectedToolBundle {
    const definition = TOOL_BUNDLE_DEFINITIONS.find((item) => item.domain === route.domain && item.intents.includes(route.intent))
      ?? TOOL_BUNDLE_DEFINITIONS.find((item) => item.domain === route.domain);
    if (!definition) throw new Error(`No ToolBundle for route ${route.domain}:${route.intent}`);
    const selectedBundle = this.resolveBundle(definition.name);
    if (definition.name === 'import.project_assets') {
      const strictToolNames = selectImportProjectAssetsStrictTools(context);
      this.assertToolNamesRegistered(definition.name, strictToolNames);
      return {
        ...selectedBundle,
        strictToolNames,
        selectionReason: `${selectedBundle.selectionReason} Selected import tools are scoped by importPreviewMode and requestedAssetTypes.`,
      };
    }
    if (definition.name === 'timeline.plan') {
      const strictToolNames = selectTimelinePlanStrictTools(route);
      this.assertToolNamesRegistered(definition.name, strictToolNames);
      return {
        ...selectedBundle,
        strictToolNames,
        optionalToolNames: selectedBundle.optionalToolNames.filter((toolName) => !strictToolNames.includes(toolName)),
        selectionReason: `${selectedBundle.selectionReason} Timeline persistence tools are selected only when route.needsPersistence is true.`,
      };
    }
    return selectedBundle;
  }

  assertAllBundlesRegistered(): void {
    for (const definition of TOOL_BUNDLE_DEFINITIONS) this.assertDefinitionToolsRegistered(definition);
  }

  registeredToolCount(): number {
    return this.tools.list().length;
  }

  private assertDefinitionToolsRegistered(definition: ToolBundleDefinition): void {
    this.assertToolNamesRegistered(definition.name, this.bundleToolNames(definition));
  }

  private assertToolNamesRegistered(label: string, referenced: string[]): void {
    const registered = new Set(this.tools.list().map((tool) => tool.name));
    const missing = referenced.filter((toolName) => !registered.has(toolName));
    if (missing.length) {
      throw new Error(`ToolBundle ${label} references unregistered tools: ${missing.join(', ')}`);
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
