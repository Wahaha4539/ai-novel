import { asRecord, asRecordArray, positiveInt, stringArray, text } from './chapter-outline-batch-contracts';

export interface AssertCompleteChapterCraftBriefOptions {
  label: string;
}

const REQUIRED_TEXT_FIELDS = [
  'visibleGoal',
  'hiddenEmotion',
  'coreConflict',
  'mainlineTask',
  'dialogueSubtext',
  'characterShift',
  'irreversibleConsequence',
  'entryState',
  'exitState',
  'handoffToNextChapter',
];

const REQUIRED_ARRAY_FIELDS = [
  'subplotTasks',
  'actionBeats',
  'progressTypes',
  'openLoops',
  'closedLoops',
];

/**
 * Deterministic structure guard only. It never judges literary quality or
 * fills missing content; missing required craftBrief data remains a hard error.
 */
export function assertCompleteChapterCraftBrief(value: unknown, options: AssertCompleteChapterCraftBriefOptions): void {
  const label = options.label;
  try {
    const craftBrief = asRecord(value);
    if (!Object.keys(craftBrief).length) throw new Error(`${label} missing craftBrief.`);

    for (const field of REQUIRED_TEXT_FIELDS) {
      if (!text(craftBrief[field])) throw new Error(`${label}.${field} is required.`);
    }
    for (const field of REQUIRED_ARRAY_FIELDS) {
      if (!stringArray(craftBrief[field]).length) throw new Error(`${label}.${field} is required.`);
    }
    assertStoryUnit(craftBrief.storyUnit, `${label}.storyUnit`);
    assertSceneBeats(craftBrief.sceneBeats, `${label}.sceneBeats`);
    assertConcreteClues(craftBrief.concreteClues, `${label}.concreteClues`);
    assertContinuityState(craftBrief.continuityState, `${label}.continuityState`);
    assertCharacterExecutionShape(craftBrief.characterExecution, `${label}.characterExecution`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('craftBrief 不完整')) throw error;
    throw new Error(`${label} craftBrief 不完整：${message}`);
  }
}

function assertStoryUnit(value: unknown, label: string): void {
  const storyUnit = asRecord(value);
  if (!Object.keys(storyUnit).length) throw new Error(`${label} is required.`);
  for (const field of ['unitId', 'title', 'chapterRole', 'localGoal', 'localConflict', 'mainlineContribution', 'characterContribution', 'relationshipContribution', 'worldOrThemeContribution', 'unitPayoff', 'stateChangeAfterUnit']) {
    if (!text(storyUnit[field])) throw new Error(`${label}.${field} is required.`);
  }
  const range = asRecord(storyUnit.chapterRange);
  const start = positiveInt(range.start);
  const end = positiveInt(range.end);
  if (!start || !end || end < start) throw new Error(`${label}.chapterRange is required.`);
  if (stringArray(storyUnit.serviceFunctions).length < 3) throw new Error(`${label}.serviceFunctions requires at least 3 items.`);
}

function assertSceneBeats(value: unknown, label: string): void {
  const sceneBeats = asRecordArray(value);
  if (sceneBeats.length < 3) throw new Error(`${label} requires at least 3 items.`);
  sceneBeats.forEach((sceneBeat, index) => {
    for (const field of ['sceneArcId', 'scenePart', 'location', 'localGoal', 'visibleAction', 'obstacle', 'turningPoint', 'partResult', 'sensoryAnchor']) {
      if (!text(sceneBeat[field])) throw new Error(`${label}[${index}].${field} is required.`);
    }
    if (!stringArray(sceneBeat.participants).length) throw new Error(`${label}[${index}].participants is required.`);
  });
}

function assertConcreteClues(value: unknown, label: string): void {
  const clues = asRecordArray(value);
  if (!clues.length) throw new Error(`${label} requires at least 1 item.`);
  clues.forEach((clue, index) => {
    for (const field of ['name', 'sensoryDetail', 'laterUse']) {
      if (!text(clue[field])) throw new Error(`${label}[${index}].${field} is required.`);
    }
  });
}

function assertContinuityState(value: unknown, label: string): void {
  const continuityState = asRecord(value);
  if (!Object.keys(continuityState).length) throw new Error(`${label} is required.`);
  if (!text(continuityState.nextImmediatePressure)) throw new Error(`${label}.nextImmediatePressure is required.`);
  if (![
    stringArray(continuityState.characterPositions),
    stringArray(continuityState.activeThreats),
    stringArray(continuityState.ownedClues),
    stringArray(continuityState.relationshipChanges),
  ].some((items) => items.length > 0)) {
    throw new Error(`${label} requires at least one continuity array.`);
  }
}

function assertCharacterExecutionShape(value: unknown, label: string): void {
  const characterExecution = asRecord(value);
  if (!Object.keys(characterExecution).length) throw new Error(`${label} is required.`);
  if (!text(characterExecution.povCharacter)) throw new Error(`${label}.povCharacter is required.`);
  if (!asRecordArray(characterExecution.cast).length) throw new Error(`${label}.cast is required.`);
  if (!Array.isArray(characterExecution.relationshipBeats)) throw new Error(`${label}.relationshipBeats is required.`);
  if (!Array.isArray(characterExecution.newMinorCharacters)) throw new Error(`${label}.newMinorCharacters is required.`);
}
