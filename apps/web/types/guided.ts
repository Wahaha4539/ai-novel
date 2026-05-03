export type CraftBriefProgressType = 'info' | 'relationship' | 'resource' | 'status' | 'foreshadow' | 'rule' | 'emotion' | string;

export interface ChapterConcreteClue {
  name: string;
  sensoryDetail?: string;
  laterUse?: string;
}

export interface ChapterCraftBrief {
  visibleGoal?: string;
  hiddenEmotion?: string;
  coreConflict?: string;
  mainlineTask?: string;
  subplotTasks?: string[];
  actionBeats?: string[];
  concreteClues?: ChapterConcreteClue[];
  dialogueSubtext?: string;
  characterShift?: string;
  irreversibleConsequence?: string;
  progressTypes?: CraftBriefProgressType[];
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
