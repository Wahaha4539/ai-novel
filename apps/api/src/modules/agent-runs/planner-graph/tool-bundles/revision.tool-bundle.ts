import type { ToolBundleDefinition } from './tool-bundle.types';

export const revisionToolBundles: ToolBundleDefinition[] = [
  {
    name: 'revision.passage',
    domain: 'revision',
    intents: ['chapter_passage_revision', 'passage_revision'],
    strictToolNames: ['collect_chapter_context', 'revise_chapter_passage_preview', 'apply_chapter_passage_revision'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'When sourcePage=editor_passage_agent and selectionIntent=chapter_passage_revision with selectedText, selectedRange, currentDraftId, and currentDraftVersion, keep the plan on the selected passage only.',
      'Use revise_chapter_passage_preview to create the local replacement preview, then apply_chapter_passage_revision only after approval.',
      'Do not switch to polish_chapter or rewrite_chapter unless the user explicitly asks to revise the whole chapter.',
      'If selectedRange, selectedText, currentDraftId, or currentDraftVersion is missing, do not use passage tools; reselect or fall back to a non-passage revision route.',
    ],
  },
  {
    name: 'revision.polish',
    domain: 'revision',
    intents: ['chapter_revision', 'chapter_polish', 'polish_chapter'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'polish_chapter', 'fact_validation'],
    optionalToolNames: ['postprocess_chapter', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use polish_chapter for local edits, style polishing, or AI-flavor cleanup.',
      'For AI-flavor cleanup, preserve the user instruction and rely on the project humanizer-polish skill: diagnose remaining AI tells internally, then do a final anti-AI pass without outputting diagnostics.',
      'Do not use rewrite_chapter unless the route explicitly asks to rewrite from scratch or not reuse the old draft.',
    ],
  },
  {
    name: 'revision.rewrite',
    domain: 'revision',
    intents: ['chapter_rewrite', 'rewrite_chapter'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'rewrite_chapter', 'fact_validation'],
    optionalToolNames: ['postprocess_chapter', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'polish_chapter', 'persist_outline', 'persist_project_assets'],
    plannerGuidance: [
      'Use rewrite_chapter only when the route says to rewrite from scratch or not reuse the old draft.',
      'Do not use polish_chapter for full rewrites.',
    ],
  },
];
