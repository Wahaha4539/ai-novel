import { Injectable } from '@nestjs/common';
import { IMPORT_ASSET_TYPES, type ImportAssetType } from '../../agent-tools/tools/import-preview.types';
import type { AgentContextV2 } from '../agent-context-builder.service';
import type { AgentPlanSpec } from '../agent-planner.service';
import type { RouteDecision, SelectedToolBundle } from './planner-graph.state';

export interface PlanValidatorInput {
  plan: AgentPlanSpec;
  context?: AgentContextV2;
  route?: RouteDecision;
  selectedBundle?: SelectedToolBundle;
}

const IMPORT_TARGET_TOOL_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: 'generate_import_project_profile_preview',
  outline: 'generate_import_outline_preview',
  characters: 'generate_import_characters_preview',
  worldbuilding: 'generate_import_worldbuilding_preview',
  writingRules: 'generate_import_writing_rules_preview',
};

const IMPORT_TARGET_ASSET_BY_TOOL = new Map<string, ImportAssetType>(
  Object.entries(IMPORT_TARGET_TOOL_BY_ASSET_TYPE).map(([assetType, tool]) => [tool, assetType as ImportAssetType]),
);

const WRITE_TOOL_NAMES = new Set([
  'write_chapter',
  'write_chapter_series',
  'rewrite_chapter',
  'polish_chapter',
  'auto_repair_chapter',
  'extract_chapter_facts',
  'rebuild_memory',
  'ai_quality_review',
]);

@Injectable()
export class PlanValidatorService {
  validate(input: PlanValidatorInput): void {
    this.assertBundleTools(input.plan, input.selectedBundle);
    this.assertWriteApproval(input.plan);
    this.assertRouteBoundaries(input.plan, input.route);
    this.assertImportScope(input.plan, input.route, input.context);
  }

  private assertBundleTools(plan: AgentPlanSpec, selectedBundle?: SelectedToolBundle): void {
    if (!selectedBundle) return;
    const allowed = new Set([...selectedBundle.strictToolNames, ...selectedBundle.optionalToolNames]);
    const outside = plan.steps.map((step) => step.tool).filter((tool) => !allowed.has(tool));
    if (outside.length) {
      throw new Error(`PlanValidator blocked bundle-outside tools for ${selectedBundle.bundleName}: ${[...new Set(outside)].join(', ')}`);
    }
  }

  private assertWriteApproval(plan: AgentPlanSpec): void {
    const unsafe = plan.steps.filter((step) => (WRITE_TOOL_NAMES.has(step.tool) || step.tool.startsWith('persist_')) && !step.requiresApproval);
    if (unsafe.length) throw new Error(`PlanValidator blocked write tools without approval: ${unsafe.map((step) => step.tool).join(', ')}`);
  }

  private assertRouteBoundaries(plan: AgentPlanSpec, route?: RouteDecision): void {
    if (!route) return;
    const tools = new Set(plan.steps.map((step) => step.tool));
    if (route.domain === 'outline' && route.intent === 'generate_volume_outline') {
      this.rejectTools(tools, ['generate_outline_preview', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'validate_outline', 'persist_outline', 'write_chapter', 'write_chapter_series'], 'volume outline route');
    }
    if (route.domain === 'outline' && route.intent === 'split_volume_to_chapters' && !tools.has('generate_chapter_outline_preview')) {
      throw new Error('PlanValidator blocked outline.chapter route without generate_chapter_outline_preview');
    }
    if (route.domain === 'guided') {
      this.rejectTools(tools, ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory'], 'guided route');
    }
    if (route.domain === 'timeline' && !route.needsPersistence) {
      this.rejectTools(tools, ['persist_timeline_events'], 'timeline preview route');
    }
  }

  private assertImportScope(plan: AgentPlanSpec, route?: RouteDecision, context?: AgentContextV2): void {
    if (route?.domain !== 'import') return;
    const requestedAssetTypes = this.importAssetTypes(context?.session.requestedAssetTypes);
    if (!requestedAssetTypes.length) return;
    const requested = new Set(requestedAssetTypes);
    const targetToolAssets = plan.steps
      .map((step) => IMPORT_TARGET_ASSET_BY_TOOL.get(step.tool))
      .filter((assetType): assetType is ImportAssetType => Boolean(assetType));
    const extraTargetTools = targetToolAssets.filter((assetType) => !requested.has(assetType));
    if (extraTargetTools.length) {
      throw new Error(`PlanValidator blocked import target expansion: ${[...new Set(extraTargetTools)].join(', ')}`);
    }
    for (const step of plan.steps) {
      if (step.tool !== 'build_import_preview' && step.tool !== 'merge_import_previews') continue;
      const explicit = this.importAssetTypes(step.args.requestedAssetTypes);
      if (!explicit.length) {
        throw new Error(`PlanValidator blocked import step without requestedAssetTypes: ${step.tool}`);
      }
      const extra = explicit.filter((assetType) => !requested.has(assetType));
      const missing = requestedAssetTypes.filter((assetType) => !explicit.includes(assetType));
      if (extra.length || missing.length) {
        throw new Error(`PlanValidator blocked import requestedAssetTypes mismatch for ${step.tool}: expected ${requestedAssetTypes.join(', ')}, got ${explicit.join(', ')}`);
      }
    }
  }

  private rejectTools(actualTools: Set<string>, deniedTools: string[], label: string): void {
    const found = deniedTools.filter((tool) => actualTools.has(tool));
    if (found.length) throw new Error(`PlanValidator blocked ${label} tools: ${found.join(', ')}`);
  }

  private importAssetTypes(value: unknown): ImportAssetType[] {
    if (!Array.isArray(value)) return [];
    const normalized = value.filter((item): item is ImportAssetType => typeof item === 'string' && IMPORT_ASSET_TYPES.includes(item as ImportAssetType));
    return [...new Set(normalized)];
  }
}
