export type CraftBriefProgressType = 'info' | 'relationship' | 'resource' | 'status' | 'foreshadow' | 'rule' | 'emotion' | string;

export interface ChapterConcreteClue {
  name: string;
  sensoryDetail?: string;
  laterUse?: string;
}

export interface ChapterStoryUnit {
  unitId: string;
  title: string;
  chapterRange: {
    start: number;
    end: number;
  };
  chapterRole: string;
  localGoal: string;
  localConflict: string;
  serviceFunctions: string[];
  mainlineContribution: string;
  characterContribution: string;
  relationshipContribution: string;
  worldOrThemeContribution: string;
  unitPayoff: string;
  stateChangeAfterUnit: string;
}

export interface VolumeStoryUnit {
  unitId: string;
  title: string;
  chapterRange: {
    start: number;
    end: number;
  };
  localGoal: string;
  localConflict: string;
  serviceFunctions: string[];
  payoff: string;
  stateChangeAfterUnit: string;
}

export interface VolumeNarrativePlan {
  globalMainlineStage?: string;
  volumeMainline?: string;
  dramaticQuestion?: string;
  startState?: string;
  endState?: string;
  mainlineMilestones?: string[];
  subStoryLines?: Array<Record<string, unknown>>;
  storyUnits?: VolumeStoryUnit[];
  foreshadowPlan?: string[];
  endingHook?: string;
  handoffToNextVolume?: string;
}

export interface ChapterSceneBeat {
  sceneArcId: string;
  scenePart: string;
  continuesFromChapterNo?: number | null;
  continuesToChapterNo?: number | null;
  location: string;
  participants: string[];
  localGoal: string;
  visibleAction: string;
  obstacle: string;
  turningPoint: string;
  partResult: string;
  sensoryAnchor: string;
}

export interface ChapterContinuityState {
  characterPositions?: string[];
  activeThreats?: string[];
  ownedClues?: string[];
  relationshipChanges?: string[];
  nextImmediatePressure?: string;
}

export interface ChapterCraftBrief {
  visibleGoal?: string;
  hiddenEmotion?: string;
  coreConflict?: string;
  mainlineTask?: string;
  subplotTasks?: string[];
  storyUnit?: ChapterStoryUnit;
  actionBeats?: string[];
  sceneBeats?: ChapterSceneBeat[];
  concreteClues?: ChapterConcreteClue[];
  dialogueSubtext?: string;
  characterShift?: string;
  irreversibleConsequence?: string;
  progressTypes?: CraftBriefProgressType[];
  entryState?: string;
  exitState?: string;
  openLoops?: string[];
  closedLoops?: string[];
  handoffToNextChapter?: string;
  continuityState?: ChapterContinuityState;
}

export interface GuidedChapterData {
  chapterNo: number;
  volumeNo?: number;
  title: string;
  objective: string;
  conflict: string;
  outline: string;
  craftBrief?: ChapterCraftBrief;
}

export interface GuidedVolumeData {
  volumeNo: number;
  title: string;
  synopsis: string;
  objective: string;
  narrativePlan?: VolumeNarrativePlan;
}

export interface GuidedSupportingCharacterData {
  name: string;
  roleType: string;
  personalityCore: string;
  motivation: string;
  firstAppearChapter?: number;
}
