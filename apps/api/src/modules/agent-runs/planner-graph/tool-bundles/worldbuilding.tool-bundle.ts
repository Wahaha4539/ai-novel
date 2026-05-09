import type { ToolBundleDefinition } from './tool-bundle.types';

export const worldbuildingToolBundles: ToolBundleDefinition[] = [
  {
    name: 'worldbuilding.expand',
    domain: 'worldbuilding',
    intents: ['worldbuilding_expand'],
    strictToolNames: [
      'inspect_project_context',
      'collect_task_context',
      'generate_worldbuilding_preview',
      'validate_worldbuilding',
      'persist_worldbuilding',
    ],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'persist_outline'],
    plannerGuidance: [
      'Generate and validate worldbuilding previews before approved persistence.',
      'Do not overwrite locked facts or confirmed plot boundaries.',
    ],
  },
  {
    name: 'worldbuilding.story_bible',
    domain: 'worldbuilding',
    intents: ['story_bible_expand'],
    strictToolNames: [
      'inspect_project_context',
      'collect_task_context',
      'generate_story_bible_preview',
      'validate_story_bible',
      'persist_story_bible',
    ],
    optionalToolNames: [],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'rewrite_chapter', 'polish_chapter', 'persist_outline'],
    plannerGuidance: [
      'Generate and validate Story Bible previews before approved persistence.',
      'Do not overwrite locked facts or confirmed plot boundaries.',
    ],
  },
];
