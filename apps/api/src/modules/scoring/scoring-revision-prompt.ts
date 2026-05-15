import { PlatformScoringProfile, getPlatformProfile } from './platform-scoring-profiles';
import {
  PlatformProfileKey,
  ScoringDimensionScore,
  ScoringIssue,
  ScoringTargetSnapshot,
  ScoringTargetType,
} from './scoring-contracts';
import { CreateScoringRevisionInput, ScoringRevisionTargetMapping } from './scoring-revision.types';

export interface BuildScoringRevisionPromptInput {
  scoringRunId: string;
  targetType: ScoringTargetType;
  targetSnapshot: ScoringTargetSnapshot;
  platformProfileKey: PlatformProfileKey;
  dimensions: ScoringDimensionScore[];
  selectedDimensions: ScoringDimensionScore[];
  issues: ScoringIssue[];
  selectedIssues: ScoringIssue[];
  revisionPriorities: string[];
  selectedRevisionPriorities: string[];
  request: CreateScoringRevisionInput;
  mapping: ScoringRevisionTargetMapping;
  overallScore: number;
  verdict: string;
  summary: string;
}

export interface ScoringRevisionPromptResult {
  prompt: string;
  context: Record<string, unknown>;
  platformProfile: Pick<PlatformScoringProfile, 'key' | 'name' | 'version' | 'description' | 'disclaimer' | 'emphasis'>;
}

export function buildScoringRevisionPrompt(input: BuildScoringRevisionPromptInput): ScoringRevisionPromptResult {
  const profile = getPlatformProfile(input.platformProfileKey);
  const context = {
    task: 'score_driven_agent_revision',
    scoringRunId: input.scoringRunId,
    entryPoint: input.request.entryPoint ?? 'report',
    targetType: input.targetType,
    agentTarget: input.mapping.agentTarget,
    recommendedPreviewAction: input.mapping.recommendedPreviewAction,
    expectedOutput: input.mapping.expectedOutput,
    overallScore: input.overallScore,
    verdict: input.verdict,
    summary: input.summary,
    targetSnapshot: input.targetSnapshot,
    platformProfile: {
      key: profile.key,
      name: profile.name,
      version: profile.version,
      description: profile.description,
      disclaimer: profile.disclaimer,
      emphasis: profile.emphasis,
    },
    selectedDimensions: input.selectedDimensions,
    selectedIssues: input.selectedIssues,
    revisionPriorities: input.selectedRevisionPriorities,
    allDimensions: input.dimensions,
    allIssues: input.issues,
    userInstruction: input.request.userInstruction ?? '',
    prohibitions: [
      'Do not persist, apply, overwrite, delete, or mutate novel assets directly.',
      'Do not invent missing story facts to hide scoring or context gaps.',
      'Do not use keyword, regex, blacklist, or superficial text-length rules as semantic judgment gates.',
      'Do not bypass existing preview, validation, approval, and persist boundaries.',
      'Do not switch chapter-outline work to the old batch outline flow.',
    ],
    outputRequirements: [
      'Create only the mapped Agent preview target.',
      'Keep every proposed change traceable to selectedDimensions, selectedIssues, or revisionPriorities.',
      'Return a preview with changeSummary, preservedFacts, remainingRisks, and explicit approval requirements.',
      'Fail instead of producing placeholder content if required context is missing.',
    ],
  };

  return {
    context,
    platformProfile: context.platformProfile,
    prompt: [
      'Score-driven revision request.',
      '',
      'Use the JSON context below as the authoritative contract for the Agent task.',
      'The revision must create a preview/task only. It must not directly persist or apply content.',
      'Follow the mapped target and output requirements exactly.',
      '',
      JSON.stringify(context, null, 2),
    ].join('\n'),
  };
}
