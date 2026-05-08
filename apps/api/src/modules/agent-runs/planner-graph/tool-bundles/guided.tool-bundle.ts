import type { ToolBundleDefinition } from './tool-bundle.types';

export const guidedToolBundles: ToolBundleDefinition[] = [
  {
    name: 'guided.step',
    domain: 'guided',
    intents: ['guided_step_consultation', 'guided_step_generate', 'guided_step_finalize'],
    strictToolNames: ['generate_guided_step_preview', 'validate_guided_step_preview', 'persist_guided_step_result'],
    optionalToolNames: ['inspect_project_context'],
    deniedToolNames: ['write_chapter', 'write_chapter_series', 'persist_outline'],
    plannerGuidance: [
      'Stay inside the active guided step and its structured step data.',
      'Do not treat guided-step Q&A as chapter prose writing.',
    ],
  },
];
