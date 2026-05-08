import type { ToolBundleDefinition } from './tool-bundle.types';

export const timelineToolBundles: ToolBundleDefinition[] = [
  {
    name: 'timeline.plan',
    domain: 'timeline',
    intents: ['timeline_plan', 'planned_timeline_preview', 'timeline_confirmation'],
    strictToolNames: ['collect_task_context', 'generate_timeline_preview', 'align_chapter_timeline_preview', 'validate_timeline_preview'],
    optionalToolNames: ['persist_timeline_events'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Preview and validate planned timeline candidates before any persistence.',
      'Only include persist_timeline_events when the route explicitly asks to save after approval.',
    ],
  },
];
