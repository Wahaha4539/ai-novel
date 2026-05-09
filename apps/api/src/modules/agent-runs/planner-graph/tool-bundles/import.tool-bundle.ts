import type { ToolBundleDefinition } from './tool-bundle.types';
import type { AgentContextV2 } from '../../agent-context-builder.service';

type ImportAssetType = NonNullable<AgentContextV2['session']['requestedAssetTypes']>[number];

const IMPORT_TARGET_TOOL_BY_ASSET_TYPE: Record<ImportAssetType, string> = {
  projectProfile: 'generate_import_project_profile_preview',
  outline: 'generate_import_outline_preview',
  characters: 'generate_import_characters_preview',
  worldbuilding: 'generate_import_worldbuilding_preview',
  writingRules: 'generate_import_writing_rules_preview',
};

const IMPORT_QUICK_STRICT_TOOLS = [
  'read_source_document',
  'analyze_source_text',
  'build_import_preview',
  'cross_target_consistency_check',
  'validate_imported_assets',
  'persist_project_assets',
];

const IMPORT_DEEP_COMMON_STRICT_TOOLS = [
  'read_source_document',
  'analyze_source_text',
  'build_import_brief',
];

const IMPORT_DEEP_FINAL_STRICT_TOOLS = [
  'merge_import_previews',
  'cross_target_consistency_check',
  'validate_imported_assets',
  'persist_project_assets',
];

export const importToolBundles: ToolBundleDefinition[] = [
  {
    name: 'import.project_assets',
    domain: 'import',
    intents: ['project_import_preview', 'import_project_assets', 'targeted_import'],
    strictToolNames: [
      'read_source_document',
      'analyze_source_text',
      'build_import_brief',
      'build_import_preview',
      'generate_import_project_profile_preview',
      'generate_import_outline_preview',
      'generate_import_characters_preview',
      'generate_import_worldbuilding_preview',
      'generate_import_writing_rules_preview',
      'merge_import_previews',
      'cross_target_consistency_check',
      'validate_imported_assets',
      'persist_project_assets',
    ],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Never expand requestedAssetTypes beyond the route or session scope.',
      'Use target-specific preview tools for deep targeted imports and merge before validation.',
    ],
  },
];

export function selectImportProjectAssetsStrictTools(context?: AgentContextV2): string[] {
  const requestedAssetTypes = importAssetTypes(context?.session.requestedAssetTypes);
  const mode = importPreviewMode(context?.session.importPreviewMode);
  const effectiveMode = mode === 'deep' || (mode === 'auto' && requestedAssetTypes.length > 0 && requestedAssetTypes.length <= 2)
    ? 'deep'
    : 'quick';
  if (effectiveMode === 'quick' || !requestedAssetTypes.length) return [...IMPORT_QUICK_STRICT_TOOLS];
  return [
    ...IMPORT_DEEP_COMMON_STRICT_TOOLS,
    ...requestedAssetTypes.map((assetType) => IMPORT_TARGET_TOOL_BY_ASSET_TYPE[assetType]),
    ...IMPORT_DEEP_FINAL_STRICT_TOOLS,
  ];
}

function importAssetTypes(value: unknown): ImportAssetType[] {
  const allowed = new Set(Object.keys(IMPORT_TARGET_TOOL_BY_ASSET_TYPE));
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is ImportAssetType => typeof item === 'string' && allowed.has(item)))];
}

function importPreviewMode(value: unknown): AgentContextV2['session']['importPreviewMode'] {
  return value === 'quick' || value === 'deep' || value === 'auto' ? value : undefined;
}
