export type CraftBriefProgressType = 'info' | 'relationship' | 'resource' | 'status' | 'foreshadow' | 'rule' | 'emotion' | string;

export interface ChapterConcreteClue {
  name: string;
  sensoryDetail?: string;
  laterUse?: string;
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
  title: string;
  objective: string;
  conflict: string;
  outline: string;
  craftBrief?: ChapterCraftBrief;
}

export interface GuidedSupportingCharacterData {
  name: string;
  roleType: string;
  personalityCore: string;
  motivation: string;
  firstAppearChapter?: number;
}
