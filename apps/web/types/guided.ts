export type CraftBriefProgressType = 'info' | 'relationship' | 'resource' | 'status' | 'foreshadow' | 'rule' | 'emotion' | string;
export type VolumeCharacterRoleType = 'protagonist' | 'antagonist' | 'supporting' | 'minor';
export type ChapterCharacterSource = 'existing' | 'volume_candidate' | 'minor_temporary';

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
  characterPlan?: VolumeCharacterPlan;
}

export interface VolumeCharacterPlan {
  existingCharacterArcs: Array<{
    characterId?: string;
    characterName: string;
    roleInVolume: string;
    entryState: string;
    volumeGoal: string;
    hiddenNeed?: string;
    pressure: string;
    keyChoices: string[];
    firstActiveChapter: number;
    lastActiveChapter?: number;
    endState: string;
  }>;
  newCharacterCandidates: Array<{
    candidateId: string;
    name: string;
    roleType: VolumeCharacterRoleType;
    scope: 'volume';
    narrativeFunction: string;
    personalityCore: string;
    motivation: string;
    backstorySeed?: string;
    conflictWith: string[];
    relationshipAnchors: string[];
    firstAppearChapter: number;
    expectedArc: string;
    approvalStatus: 'candidate';
  }>;
  relationshipArcs: Array<{
    participants: string[];
    startState: string;
    hiddenTension?: string;
    turnChapterNos: number[];
    endState: string;
  }>;
  roleCoverage: {
    mainlineDrivers: string[];
    antagonistPressure: string[];
    emotionalCounterweights: string[];
    expositionCarriers: string[];
  };
}

export interface ChapterCharacterExecution {
  povCharacter?: string;
  cast: Array<{
    characterName: string;
    characterId?: string;
    source: ChapterCharacterSource;
    functionInChapter: string;
    visibleGoal: string;
    hiddenGoal?: string;
    pressure: string;
    actionBeatRefs: number[];
    sceneBeatRefs: string[];
    entryState: string;
    exitState: string;
    dialogueJob?: string;
  }>;
  relationshipBeats: Array<{
    participants: string[];
    publicStateBefore: string;
    hiddenStateBefore?: string;
    trigger: string;
    shift: string;
    publicStateAfter: string;
    hiddenStateAfter?: string;
  }>;
  newMinorCharacters: Array<{
    nameOrLabel: string;
    narrativeFunction: string;
    interactionScope: string;
    firstAndOnlyUse: boolean;
    approvalPolicy: 'preview_only' | 'needs_approval';
  }>;
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
  characterExecution?: ChapterCharacterExecution;
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
  chapterCount: number;
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
