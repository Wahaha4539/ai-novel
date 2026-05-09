import type { ToolBundleDefinition } from './tool-bundle.types';

export const qualityToolBundles: ToolBundleDefinition[] = [
  {
    name: 'quality.check',
    domain: 'quality',
    intents: ['character_consistency_check', 'plot_consistency_check', 'ai_quality_review', 'continuity_check'],
    strictToolNames: ['resolve_chapter', 'resolve_character', 'collect_task_context', 'collect_chapter_context', 'character_consistency_check', 'plot_consistency_check', 'ai_quality_review'],
    optionalToolNames: ['report_result'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'auto_repair_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use quality tools for checks and reviews, not for prose generation.',
      'Keep write-like repair or persistence tools outside read-only quality checks unless a later route explicitly selects them.',
    ],
  },
];
