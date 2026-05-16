import { getTargetDimensions } from './scoring-dimensions';
import {
  PlatformProfileKey,
  ScoringTargetSnapshot,
  ScoringTargetType,
  SCORING_PROMPT_VERSION,
  SCORING_RUBRIC_VERSION,
} from './scoring-contracts';
import { assertPlatformProfileCoversTarget, getPlatformProfile } from './platform-scoring-profiles';

export interface ScoringPromptMessages {
  system: string;
  user: string;
  promptVersion: string;
  rubricVersion: string;
  profileVersion: string;
}

const TARGET_PROMPTS: Record<ScoringTargetType, string> = {
  project_outline: [
    'Please score whether the project outline can support a long-form Chinese novel project.',
    'Focus on premise, mainline, conflict engine, character arc, longform sustainability, platform hook, and future expansion room.',
  ].join('\n'),
  volume_outline: [
    'Please score whether the volume outline can carry its narrative function.',
    'Focus on volume goal, staged conflict, pacing curve, midpoint turn, climax design, foreshadowing, and handoff to adjacent volumes.',
  ].join('\n'),
  chapter_outline: [
    'Please score whether the chapter outline can support later craftBrief and draft generation.',
    'Focus on chapter goal, concrete conflict, scene chain, motivated character action, information design, continuity, and reader retention.',
  ].join('\n'),
  chapter_craft_brief: [
    'Please score whether the chapter craftBrief is executable enough to support draft generation.',
    'Focus on visible scene chain, actionBeats, concrete obstacle, turning point, result, character entry/exit states, sensory anchors, and continuity handoff.',
  ].join('\n'),
  chapter_draft: [
    'Please score whether the chapter draft executes the chapter plan and works as a serialized platform chapter.',
    'First extract main characters, core events, key scenes, new information, and ending hook. Then score plan adherence against chapter outline and craftBrief.',
  ].join('\n'),
};

export function buildScoringPromptMessages(input: {
  targetType: ScoringTargetType;
  platformProfile: PlatformProfileKey;
  targetSnapshot: ScoringTargetSnapshot;
}): ScoringPromptMessages {
  const profile = getPlatformProfile(input.platformProfile);
  const weights = assertPlatformProfileCoversTarget(input.targetType, input.platformProfile);
  const dimensions = getTargetDimensions(input.targetType).map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    description: dimension.description,
    weight: weights[dimension.key],
    critical: dimension.criticalFor?.includes(input.targetType) ?? false,
  }));

  return {
    system: [
      'You are a strict but practical Chinese long-form fiction editor, platform-oriented content evaluator, and story structure consultant.',
      'Your job is scoring only. Do not rewrite content. Do not add new story facts. Do not output Markdown.',
      'Do not use keywords, regex-like shortcuts, blacklist logic, or superficial length checks to judge complex creative meaning.',
      'Use the provided target snapshot, project context, platform scoring profile, and rubric. Return strict JSON only.',
      'If the target is insufficient to score, return verdict "fail" with concrete blockingIssues. Never fabricate evidence.',
    ].join('\n'),
    user: JSON.stringify({
      task: 'multidimensional_fiction_scoring',
      promptVersion: SCORING_PROMPT_VERSION,
      rubricVersion: SCORING_RUBRIC_VERSION,
      targetType: input.targetType,
      platformProfile: {
        key: profile.key,
        name: profile.name,
        version: profile.version,
        description: profile.description,
        disclaimer: profile.disclaimer,
        emphasis: profile.emphasis,
      },
      targetInstruction: TARGET_PROMPTS[input.targetType],
      targetSnapshot: input.targetSnapshot,
      dimensions,
      outputContract: {
        requiredTopLevelFields: [
          'targetType',
          'platformProfile',
          'overallScore',
          'verdict',
          'summary',
          'extractedElements',
          'dimensions',
          'blockingIssues',
          'revisionPriorities',
        ],
        dimensionRequiredFields: [
          'key',
          'label',
          'score',
          'weight',
          'weightedScore',
          'confidence',
          'evidence',
          'reason',
          'suggestion',
        ],
        issueRequiredFields: ['dimensionKey', 'severity', 'path', 'evidence', 'reason', 'suggestion'],
        extractedElementsRequiredFields: [
          'mainCharacters',
          'coreEvents',
          'keyScenes',
          'keyInformation',
          'continuityAnchors',
          'marketSignals',
        ],
      },
    }),
    promptVersion: SCORING_PROMPT_VERSION,
    rubricVersion: SCORING_RUBRIC_VERSION,
    profileVersion: profile.version,
  };
}

export function buildScoringJsonSchema(name = 'multidimensional_scoring_report') {
  return {
    name,
    description: 'Strict multidimensional fiction scoring report.',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'targetType',
        'platformProfile',
        'overallScore',
        'verdict',
        'summary',
        'extractedElements',
        'dimensions',
        'blockingIssues',
        'revisionPriorities',
      ],
      properties: {
        targetType: { type: 'string' },
        platformProfile: { type: 'string' },
        overallScore: { type: 'number' },
        verdict: { type: 'string', enum: ['pass', 'warn', 'fail'] },
        summary: { type: 'string' },
        extractedElements: {
          type: 'object',
          additionalProperties: false,
          required: ['mainCharacters', 'coreEvents', 'keyScenes', 'keyInformation', 'continuityAnchors', 'marketSignals'],
          properties: {
            mainCharacters: { type: 'array', items: { type: 'string' } },
            coreEvents: { type: 'array', items: { type: 'string' } },
            keyScenes: { type: 'array', items: { type: 'string' } },
            keyInformation: { type: 'array', items: { type: 'string' } },
            continuityAnchors: { type: 'array', items: { type: 'string' } },
            marketSignals: { type: 'array', items: { type: 'string' } },
          },
        },
        dimensions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['key', 'label', 'score', 'weight', 'weightedScore', 'confidence', 'evidence', 'reason', 'suggestion'],
            properties: {
              key: { type: 'string' },
              label: { type: 'string' },
              score: { type: 'number' },
              weight: { type: 'number' },
              weightedScore: { type: 'number' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              evidence: { type: 'string' },
              reason: { type: 'string' },
              suggestion: { type: 'string' },
            },
          },
        },
        blockingIssues: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['dimensionKey', 'severity', 'path', 'evidence', 'reason', 'suggestion'],
            properties: {
              dimensionKey: { type: 'string' },
              severity: { type: 'string', enum: ['info', 'warning', 'blocking'] },
              path: { type: 'string' },
              evidence: { type: 'string' },
              reason: { type: 'string' },
              suggestion: { type: 'string' },
            },
          },
        },
        revisionPriorities: { type: 'array', items: { type: 'string' } },
      },
    },
  };
}
