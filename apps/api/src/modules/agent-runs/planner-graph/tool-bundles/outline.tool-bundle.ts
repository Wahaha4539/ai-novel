import type { ToolBundleDefinition } from './tool-bundle.types';

export const outlineToolBundles: ToolBundleDefinition[] = [
  {
    name: 'outline.volume',
    domain: 'outline',
    intents: ['generate_volume_outline', 'rewrite_volume_outline', 'volume_outline'],
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates'],
    optionalToolNames: [],
    deniedToolNames: ['segment_chapter_outline_batches', 'generate_chapter_outline_batch_preview', 'merge_chapter_outline_batch_previews', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline', 'write_chapter', 'write_chapter_series'],
    plannerGuidance: [
      'Only create or rewrite the volume-level outline.',
      'Do not split into chapter outlines unless the route explicitly asks for chapter planning.',
    ],
  },
  {
    name: 'outline.chapter',
    domain: 'outline',
    intents: ['generate_chapter_outline', 'split_volume_to_chapters', 'chapter_outline', 'volume_chapter_outline'],
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'generate_story_units_preview', 'segment_chapter_outline_batches', 'generate_chapter_outline_batch_preview', 'merge_chapter_outline_batch_previews', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline'],
    optionalToolNames: ['persist_volume_character_candidates', 'generate_timeline_preview', 'validate_timeline_preview'],
    deniedToolNames: ['generate_outline_preview', 'write_chapter', 'write_chapter_series', 'persist_volume_outline'],
    plannerGuidance: [
      'Generate or reuse independent story units before chapter outlines.',
      'For chapterCount greater than 12, prefer segment_chapter_outline_batches followed by visible generate_chapter_outline_batch_preview steps covering every chapter range, then merge_chapter_outline_batch_previews.',
      'If target chapterCount differs from the target volume chapterCount in context, rebuild generate_volume_outline_preview and generate_story_units_preview first, then pass volumeOutline and storyUnitPlan through segment, batch preview, and merge steps.',
      'For a single chapter or short ranges, use one generate_chapter_outline_preview step per target chapter, then merge_chapter_outline_previews.',
      'Do not append a terminal validate_outline step for chapter splitting; PlanValidator must catch count/range/reference issues up front, and each chapter/batch plus merge tool validates generated structure before approved persist_outline.',
    ],
  },
  {
    name: 'outline.story_units',
    domain: 'outline',
    intents: ['story_units', 'generate_story_units', 'rewrite_story_units'],
    strictToolNames: ['inspect_project_context', 'generate_story_units_preview', 'persist_story_units'],
    optionalToolNames: [],
    deniedToolNames: ['generate_volume_outline_preview', 'persist_volume_outline', 'persist_volume_character_candidates', 'segment_chapter_outline_batches', 'generate_chapter_outline_batch_preview', 'merge_chapter_outline_batch_previews', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline', 'write_chapter', 'write_chapter_series'],
    plannerGuidance: [
      'Generate or rewrite independent storyUnitPlan for a volume.',
      'Persist with persist_story_units only after user approval.',
      'Do not create chapter outlines unless the user explicitly asks to split into chapters.',
    ],
  },
  {
    name: 'outline.craft_brief',
    domain: 'outline',
    intents: ['chapter_craft_brief', 'chapter_progress_card', 'craft_brief'],
    strictToolNames: ['resolve_chapter', 'collect_chapter_context', 'generate_chapter_craft_brief_preview', 'validate_chapter_craft_brief', 'persist_chapter_craft_brief'],
    optionalToolNames: ['generate_timeline_preview', 'validate_timeline_preview'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Generate Chapter.craftBrief previews and validate them before approved persistence.',
      'Do not turn progress-card requests into prose writing.',
    ],
  },
  {
    name: 'outline.scene_card',
    domain: 'outline',
    intents: ['scene_card_planning', 'scene_card_update', 'scene_card'],
    strictToolNames: ['list_scene_cards', 'collect_task_context', 'generate_scene_cards_preview', 'validate_scene_cards', 'persist_scene_cards', 'update_scene_card'],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Use SceneCard tools for scene splitting or SceneCard edits.',
      'Do not use Chapter.craftBrief tools for SceneCard-only requests.',
    ],
  },
];
