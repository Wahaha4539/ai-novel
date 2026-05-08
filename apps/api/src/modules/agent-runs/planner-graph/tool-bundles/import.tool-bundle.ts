import type { ToolBundleDefinition } from './tool-bundle.types';

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
