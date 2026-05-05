export interface GenerationProfileSnapshot {
  source: 'database' | 'defaults';
  defaultChapterWordCount: number | null;
  autoContinue: boolean;
  autoSummarize: boolean;
  autoUpdateCharacterState: boolean;
  autoUpdateTimeline: boolean;
  autoValidation: boolean;
  allowNewCharacters: boolean;
  allowNewLocations: boolean;
  allowNewForeshadows: boolean;
  preGenerationChecks: unknown[];
  promptBudget: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface GenerationProfileLike {
  defaultChapterWordCount?: number | null;
  autoContinue?: boolean | null;
  autoSummarize?: boolean | null;
  autoUpdateCharacterState?: boolean | null;
  autoUpdateTimeline?: boolean | null;
  autoValidation?: boolean | null;
  allowNewCharacters?: boolean | null;
  allowNewLocations?: boolean | null;
  allowNewForeshadows?: boolean | null;
  preGenerationChecks?: unknown;
  promptBudget?: unknown;
  metadata?: unknown;
}

export const GENERATION_PROFILE_DEFAULTS: Omit<GenerationProfileSnapshot, 'source'> = {
  defaultChapterWordCount: null,
  autoContinue: false,
  autoSummarize: true,
  autoUpdateCharacterState: true,
  autoUpdateTimeline: false,
  autoValidation: true,
  allowNewCharacters: false,
  allowNewLocations: true,
  allowNewForeshadows: true,
  preGenerationChecks: [],
  promptBudget: {},
  metadata: {},
};

export function buildGenerationProfileSnapshot(profile?: GenerationProfileLike | null): GenerationProfileSnapshot {
  return {
    source: profile ? 'database' : 'defaults',
    defaultChapterWordCount: profile?.defaultChapterWordCount ?? GENERATION_PROFILE_DEFAULTS.defaultChapterWordCount,
    autoContinue: profile?.autoContinue ?? GENERATION_PROFILE_DEFAULTS.autoContinue,
    autoSummarize: profile?.autoSummarize ?? GENERATION_PROFILE_DEFAULTS.autoSummarize,
    autoUpdateCharacterState: profile?.autoUpdateCharacterState ?? GENERATION_PROFILE_DEFAULTS.autoUpdateCharacterState,
    autoUpdateTimeline: profile?.autoUpdateTimeline ?? GENERATION_PROFILE_DEFAULTS.autoUpdateTimeline,
    autoValidation: profile?.autoValidation ?? GENERATION_PROFILE_DEFAULTS.autoValidation,
    allowNewCharacters: profile?.allowNewCharacters ?? GENERATION_PROFILE_DEFAULTS.allowNewCharacters,
    allowNewLocations: profile?.allowNewLocations ?? GENERATION_PROFILE_DEFAULTS.allowNewLocations,
    allowNewForeshadows: profile?.allowNewForeshadows ?? GENERATION_PROFILE_DEFAULTS.allowNewForeshadows,
    preGenerationChecks: Array.isArray(profile?.preGenerationChecks) ? profile.preGenerationChecks : GENERATION_PROFILE_DEFAULTS.preGenerationChecks,
    promptBudget: asRecord(profile?.promptBudget) ?? GENERATION_PROFILE_DEFAULTS.promptBudget,
    metadata: asRecord(profile?.metadata) ?? GENERATION_PROFILE_DEFAULTS.metadata,
  };
}

export function buildGenerationProfileDefaults(projectId: string) {
  return {
    projectId,
    ...GENERATION_PROFILE_DEFAULTS,
    createdAt: null,
    updatedAt: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
