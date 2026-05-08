import type { ToolBundleDefinition } from './tool-bundle.types';

export const revisionToolBundles: ToolBundleDefinition[] = [
  {
    name: 'revision.chapter',
    domain: 'revision',
    intents: ['chapter_revision', 'chapter_polish', 'chapter_rewrite', 'rewrite_chapter', 'polish_chapter'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'polish_chapter', 'rewrite_chapter', 'auto_repair_chapter', 'fact_validation'],
    optionalToolNames: ['postprocess_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['write_chapter_series', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use rewrite_chapter only when the route says to rewrite from scratch or not reuse the old draft.',
      'Use polish_chapter for local edits, style polishing, or AI-flavor cleanup.',
    ],
  },
];
