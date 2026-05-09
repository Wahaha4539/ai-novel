import type { ToolBundleDefinition } from './tool-bundle.types';

export const writingToolBundles: ToolBundleDefinition[] = [
  {
    name: 'writing.chapter',
    domain: 'writing',
    intents: ['chapter_write', 'write_chapter', 'continue_chapter'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'write_chapter', 'postprocess_chapter', 'fact_validation'],
    optionalToolNames: ['auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use write_chapter for a single chapter prose draft.',
      'Do not use rewrite_chapter or polish_chapter for fresh prose writing.',
      'Use writing.series, not writing.chapter, for consecutive multi-chapter prose.',
    ],
  },
  {
    name: 'writing.series',
    domain: 'writing',
    intents: ['multi_chapter_write', 'write_chapter_series'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'write_chapter_series', 'postprocess_chapter', 'fact_validation'],
    optionalToolNames: ['auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['write_chapter', 'rewrite_chapter', 'polish_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use write_chapter_series for consecutive multi-chapter prose.',
      'Do not expand a multi-chapter request into repeated write_chapter steps.',
      'Keep quality and fact-validation steps after draft generation.',
    ],
  },
];
