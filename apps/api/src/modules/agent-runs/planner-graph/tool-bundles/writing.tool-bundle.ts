import type { ToolBundleDefinition } from './tool-bundle.types';

export const writingToolBundles: ToolBundleDefinition[] = [
  {
    name: 'writing.chapter',
    domain: 'writing',
    intents: ['chapter_write', 'multi_chapter_write', 'write_chapter', 'continue_chapter'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'write_chapter', 'write_chapter_series', 'postprocess_chapter', 'fact_validation'],
    optionalToolNames: ['auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['rewrite_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use write_chapter for one chapter and write_chapter_series for consecutive multi-chapter prose.',
      'Keep quality and fact-validation steps after draft generation.',
    ],
  },
];
