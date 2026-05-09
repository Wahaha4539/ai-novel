import type { ToolBundleDefinition } from './tool-bundle.types';
import type { RouteDecision } from '../planner-graph.state';

const TIMELINE_PREVIEW_STRICT_TOOLS = ['collect_task_context', 'generate_timeline_preview', 'align_chapter_timeline_preview', 'validate_timeline_preview'];
const TIMELINE_PERSIST_TOOL = 'persist_timeline_events';

export const timelineToolBundles: ToolBundleDefinition[] = [
  {
    name: 'timeline.plan',
    domain: 'timeline',
    intents: ['timeline_plan', 'planned_timeline_preview', 'timeline_confirmation'],
    strictToolNames: TIMELINE_PREVIEW_STRICT_TOOLS,
    optionalToolNames: [TIMELINE_PERSIST_TOOL],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Preview and validate planned timeline candidates before any persistence.',
      'Only include persist_timeline_events when the route explicitly asks to save after approval.',
    ],
  },
];

export function selectTimelinePlanStrictTools(route: Pick<RouteDecision, 'needsPersistence'>): string[] {
  return route.needsPersistence ? [...TIMELINE_PREVIEW_STRICT_TOOLS, TIMELINE_PERSIST_TOOL] : [...TIMELINE_PREVIEW_STRICT_TOOLS];
}
