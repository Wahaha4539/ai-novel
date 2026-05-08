import type { ToolBundleDefinition } from './tool-bundle.types';

export const outlineToolBundles: ToolBundleDefinition[] = [
  {
    name: 'outline.volume',
    domain: 'outline',
    intents: ['generate_volume_outline', 'rewrite_volume_outline', 'volume_outline'],
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'persist_volume_outline'],
    optionalToolNames: [],
    deniedToolNames: ['generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'persist_outline', 'write_chapter', 'write_chapter_series'],
    plannerGuidance: [
      'Only create or rewrite the volume-level outline.',
      'Do not split into chapter outlines unless the route explicitly asks for chapter planning.',
    ],
  },
  {
    name: 'outline.chapter',
    domain: 'outline',
    intents: ['generate_chapter_outline', 'split_volume_to_chapters', 'chapter_outline', 'volume_chapter_outline'],
    strictToolNames: ['inspect_project_context', 'generate_volume_outline_preview', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'validate_outline', 'persist_outline'],
    optionalToolNames: ['generate_timeline_preview', 'validate_timeline_preview'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_volume_outline'],
    plannerGuidance: [
      'Use one generate_chapter_outline_preview step per target chapter.',
      'Merge and validate chapter previews before any approved persist_outline step.',
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
