export type VolumeCharacterRoleType = 'protagonist' | 'antagonist' | 'supporting' | 'minor';

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

export type ChapterCharacterSource = 'existing' | 'volume_candidate' | 'minor_temporary';

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

export interface CharacterReferenceCatalog {
  existingCharacterNames?: string[];
  existingCharacterAliases?: Record<string, string[]>;
  volumeCandidateNames?: string[];
}

export interface AssertVolumeCharacterPlanOptions extends CharacterReferenceCatalog {
  chapterCount: number;
  label?: string;
}

export interface AssertChapterCharacterExecutionOptions extends CharacterReferenceCatalog {
  label?: string;
  sceneBeats?: Array<{ sceneArcId?: string; participants?: unknown }>;
  actionBeatCount?: number;
}

const VOLUME_ROLE_TYPES = new Set<VolumeCharacterRoleType>(['protagonist', 'antagonist', 'supporting', 'minor']);
const CHAPTER_CHARACTER_SOURCES = new Set<ChapterCharacterSource>(['existing', 'volume_candidate', 'minor_temporary']);
const MINOR_IMPORTANCE_PATTERN = /主线|核心|反派|长期|长线|人物弧|弧线|贯穿|主压力|最终对手|关键配角|重要配角|protagonist|antagonist|supporting|mainline|long[-_ ]?term/i;

export function assertVolumeCharacterPlan(value: unknown, options: AssertVolumeCharacterPlanOptions): VolumeCharacterPlan {
  const label = options.label ?? 'characterPlan';
  if (!Number.isInteger(options.chapterCount) || options.chapterCount < 1) {
    throw new Error(`${label} 校验需要有效 chapterCount。`);
  }
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    throw new Error(`${label} 缺少卷级角色规划。`);
  }

  const existingCharacterArcs = requiredRecordArray(record.existingCharacterArcs, `${label}.existingCharacterArcs`).map((arc, index) => {
    const arcLabel = `${label}.existingCharacterArcs[${index}]`;
    const firstActiveChapter = requiredPositiveInt(arc.firstActiveChapter, `${arcLabel}.firstActiveChapter`);
    if (firstActiveChapter > options.chapterCount) {
      throw new Error(`${arcLabel}.firstActiveChapter 超出本卷章节范围。`);
    }
    const lastActiveChapter = optionalPositiveInt(arc.lastActiveChapter, `${arcLabel}.lastActiveChapter`);
    if (lastActiveChapter !== undefined && (lastActiveChapter < firstActiveChapter || lastActiveChapter > options.chapterCount)) {
      throw new Error(`${arcLabel}.lastActiveChapter 超出本卷章节范围。`);
    }
    const characterName = requiredText(arc.characterName, `${arcLabel}.characterName`);
    if (options.existingCharacterNames?.length && !resolveExistingCharacterName(characterName, options)) {
      throw new Error(`${arcLabel}.characterName 引用未知既有角色：${characterName}`);
    }
    return {
      characterId: optionalText(arc.characterId),
      characterName,
      roleInVolume: requiredText(arc.roleInVolume, `${arcLabel}.roleInVolume`),
      entryState: requiredText(arc.entryState, `${arcLabel}.entryState`),
      volumeGoal: requiredText(arc.volumeGoal, `${arcLabel}.volumeGoal`),
      hiddenNeed: optionalText(arc.hiddenNeed),
      pressure: requiredText(arc.pressure, `${arcLabel}.pressure`),
      keyChoices: requiredStringArray(arc.keyChoices, `${arcLabel}.keyChoices`),
      firstActiveChapter,
      ...(lastActiveChapter !== undefined ? { lastActiveChapter } : {}),
      endState: requiredText(arc.endState, `${arcLabel}.endState`),
    };
  });

  const newCharacterCandidates = requiredRecordArray(record.newCharacterCandidates, `${label}.newCharacterCandidates`).map((candidate, index) => {
    const candidateLabel = `${label}.newCharacterCandidates[${index}]`;
    const roleType = requiredEnum(candidate.roleType, VOLUME_ROLE_TYPES, `${candidateLabel}.roleType`);
    const firstAppearChapter = requiredPositiveInt(candidate.firstAppearChapter, `${candidateLabel}.firstAppearChapter`);
    if (firstAppearChapter > options.chapterCount) {
      throw new Error(`${candidateLabel}.firstAppearChapter 超出本卷章节范围。`);
    }
    if (requiredText(candidate.scope, `${candidateLabel}.scope`) !== 'volume') throw new Error(`${candidateLabel}.scope 必须为 volume。`);
    if (requiredText(candidate.approvalStatus, `${candidateLabel}.approvalStatus`) !== 'candidate') throw new Error(`${candidateLabel}.approvalStatus 必须为 candidate。`);
    const scope: 'volume' = 'volume';
    const approvalStatus: 'candidate' = 'candidate';
    return {
      candidateId: requiredText(candidate.candidateId, `${candidateLabel}.candidateId`),
      name: requiredText(candidate.name, `${candidateLabel}.name`),
      roleType,
      scope,
      narrativeFunction: requiredText(candidate.narrativeFunction, `${candidateLabel}.narrativeFunction`),
      personalityCore: requiredText(candidate.personalityCore, `${candidateLabel}.personalityCore`),
      motivation: requiredText(candidate.motivation, `${candidateLabel}.motivation`),
      backstorySeed: optionalText(candidate.backstorySeed),
      conflictWith: stringArray(candidate.conflictWith),
      relationshipAnchors: stringArray(candidate.relationshipAnchors),
      firstAppearChapter,
      expectedArc: requiredText(candidate.expectedArc, `${candidateLabel}.expectedArc`),
      approvalStatus,
    };
  });

  const knownRelationshipNames = new Set([
    ...normalizeNameList(options.existingCharacterNames ?? []),
    ...normalizeNameList(Object.values(options.existingCharacterAliases ?? {}).flat()),
    ...normalizeNameList(existingCharacterArcs.map((arc) => arc.characterName)),
    ...normalizeNameList(newCharacterCandidates.map((candidate) => candidate.name)),
  ]);
  for (const [index, candidate] of newCharacterCandidates.entries()) {
    const candidateLabel = `${label}.newCharacterCandidates[${index}]`;
    assertKnownCharacterReferences(candidate.conflictWith, knownRelationshipNames, `${candidateLabel}.conflictWith`);
    assertKnownCharacterReferences(candidate.relationshipAnchors, knownRelationshipNames, `${candidateLabel}.relationshipAnchors`);
  }
  const relationshipArcs = requiredRecordArray(record.relationshipArcs, `${label}.relationshipArcs`).map((arc, index) => {
    const arcLabel = `${label}.relationshipArcs[${index}]`;
    const participants = requiredStringArray(arc.participants, `${arcLabel}.participants`);
    for (const participant of participants) {
      if (!knownRelationshipNames.has(normalizeName(participant))) {
        throw new Error(`${arcLabel}.participants 引用未知角色：${participant}`);
      }
    }
    const turnChapterNos = requiredPositiveIntArray(arc.turnChapterNos, `${arcLabel}.turnChapterNos`);
    if (turnChapterNos.some((chapterNo) => chapterNo > options.chapterCount)) {
      throw new Error(`${arcLabel}.turnChapterNos 超出本卷章节范围。`);
    }
    return {
      participants,
      startState: requiredText(arc.startState, `${arcLabel}.startState`),
      hiddenTension: optionalText(arc.hiddenTension),
      turnChapterNos,
      endState: requiredText(arc.endState, `${arcLabel}.endState`),
    };
  });

  const roleCoverageRecord = asRecord(record.roleCoverage);
  if (!Object.keys(roleCoverageRecord).length) {
    throw new Error(`${label}.roleCoverage 缺失。`);
  }

  const roleCoverage = {
    mainlineDrivers: stringArray(roleCoverageRecord.mainlineDrivers),
    antagonistPressure: stringArray(roleCoverageRecord.antagonistPressure),
    emotionalCounterweights: stringArray(roleCoverageRecord.emotionalCounterweights),
    expositionCarriers: stringArray(roleCoverageRecord.expositionCarriers),
  };
  assertKnownCharacterReferences(roleCoverage.mainlineDrivers, knownRelationshipNames, `${label}.roleCoverage.mainlineDrivers`);
  assertKnownCharacterReferences(roleCoverage.antagonistPressure, knownRelationshipNames, `${label}.roleCoverage.antagonistPressure`);
  assertKnownCharacterReferences(roleCoverage.emotionalCounterweights, knownRelationshipNames, `${label}.roleCoverage.emotionalCounterweights`);
  assertKnownCharacterReferences(roleCoverage.expositionCarriers, knownRelationshipNames, `${label}.roleCoverage.expositionCarriers`);

  return {
    existingCharacterArcs,
    newCharacterCandidates,
    relationshipArcs,
    roleCoverage,
  };
}

export function assertChapterCharacterExecution(value: unknown, options: AssertChapterCharacterExecutionOptions = {}): ChapterCharacterExecution {
  const label = options.label ?? 'characterExecution';
  const record = asRecord(value);
  if (!Object.keys(record).length) {
    throw new Error(`${label} 缺少章节角色执行。`);
  }
  const knownSceneBeatIds = new Set(
    (options.sceneBeats ?? [])
      .map((sceneBeat) => text(sceneBeat.sceneArcId))
      .filter(Boolean),
  );

  const newMinorCharacters = requiredRecordArray(record.newMinorCharacters, `${label}.newMinorCharacters`).map((minor, index) => {
    const minorLabel = `${label}.newMinorCharacters[${index}]`;
    const firstAndOnlyUse = requiredBoolean(minor.firstAndOnlyUse, `${minorLabel}.firstAndOnlyUse`);
    if (!firstAndOnlyUse) {
      throw new Error(`${minorLabel}.firstAndOnlyUse 必须为 true，临时角色不得承担长期人物弧。`);
    }
    const approvalPolicy = requiredText(minor.approvalPolicy, `${minorLabel}.approvalPolicy`);
    if (approvalPolicy !== 'preview_only' && approvalPolicy !== 'needs_approval') {
      throw new Error(`${minorLabel}.approvalPolicy 非法。`);
    }
    const nameOrLabel = requiredText(minor.nameOrLabel, `${minorLabel}.nameOrLabel`);
    const narrativeFunction = requiredText(minor.narrativeFunction, `${minorLabel}.narrativeFunction`);
    const interactionScope = requiredText(minor.interactionScope, `${minorLabel}.interactionScope`);
    const importanceText = [nameOrLabel, narrativeFunction, interactionScope, approvalPolicy].join(' ');
    if (approvalPolicy === 'needs_approval' || MINOR_IMPORTANCE_PATTERN.test(importanceText)) {
      throw new Error(`${minorLabel} 临时角色承担了重要或长期角色功能，必须先进入卷级角色候选。`);
    }
    return {
      nameOrLabel,
      narrativeFunction,
      interactionScope,
      firstAndOnlyUse,
      approvalPolicy: approvalPolicy as 'preview_only' | 'needs_approval',
    };
  });
  const minorNames = new Set(normalizeNameList(newMinorCharacters.map((minor) => minor.nameOrLabel)));

  const rawCast = requiredRecordArray(record.cast, `${label}.cast`);
  if (!rawCast.length) {
    throw new Error(`${label}.cast 至少需要 1 个角色。`);
  }
  const cast = rawCast.map((member, index) => {
    const memberLabel = `${label}.cast[${index}]`;
    const characterName = requiredText(member.characterName, `${memberLabel}.characterName`);
    const source = requiredEnum(member.source, CHAPTER_CHARACTER_SOURCES, `${memberLabel}.source`);
    if (source === 'existing' && !resolveExistingCharacterName(characterName, options)) {
      throw new Error(`${memberLabel}.characterName 引用未知既有角色：${characterName}`);
    }
    if (source === 'volume_candidate' && !normalizeNameList(options.volumeCandidateNames ?? []).has(normalizeName(characterName))) {
      throw new Error(`${memberLabel}.characterName 未进入卷级角色候选：${characterName}`);
    }
    if (source === 'minor_temporary') {
      if (!minorNames.has(normalizeName(characterName))) {
        throw new Error(`${memberLabel}.characterName 未出现在 newMinorCharacters：${characterName}`);
      }
      const functionText = [
        member.functionInChapter,
        member.visibleGoal,
        member.hiddenGoal,
        member.pressure,
        member.dialogueJob,
      ].map((item) => text(item)).join(' ');
      if (MINOR_IMPORTANCE_PATTERN.test(functionText)) {
        throw new Error(`${memberLabel} 临时角色承担了重要或长期角色功能，必须先进入卷级角色候选。`);
      }
    }
    const actionBeatRefs = requiredPositiveIntArray(member.actionBeatRefs, `${memberLabel}.actionBeatRefs`);
    if (options.actionBeatCount && actionBeatRefs.some((ref) => ref > options.actionBeatCount!)) {
      throw new Error(`${memberLabel}.actionBeatRefs 超出 actionBeats 范围。`);
    }
    const sceneBeatRefs = requiredStringArray(member.sceneBeatRefs, `${memberLabel}.sceneBeatRefs`);
    if (knownSceneBeatIds.size) {
      for (const ref of sceneBeatRefs) {
        if (!knownSceneBeatIds.has(ref)) {
          throw new Error(`${memberLabel}.sceneBeatRefs 引用未知 sceneBeat：${ref}`);
        }
      }
    }
    return {
      characterName,
      characterId: optionalText(member.characterId),
      source,
      functionInChapter: requiredText(member.functionInChapter, `${memberLabel}.functionInChapter`),
      visibleGoal: requiredText(member.visibleGoal, `${memberLabel}.visibleGoal`),
      hiddenGoal: optionalText(member.hiddenGoal),
      pressure: requiredText(member.pressure, `${memberLabel}.pressure`),
      actionBeatRefs,
      sceneBeatRefs,
      entryState: requiredText(member.entryState, `${memberLabel}.entryState`),
      exitState: requiredText(member.exitState, `${memberLabel}.exitState`),
      dialogueJob: optionalText(member.dialogueJob),
    };
  });

  const castNames = new Set(normalizeNameList(cast.map((member) => member.characterName)));
  const povCharacter = optionalText(record.povCharacter);
  if (povCharacter && !castNames.has(normalizeName(povCharacter))) {
    throw new Error(`${label}.povCharacter 未出现在 cast：${povCharacter}`);
  }

  const relationshipBeats = requiredRecordArray(record.relationshipBeats, `${label}.relationshipBeats`).map((beat, index) => {
    const beatLabel = `${label}.relationshipBeats[${index}]`;
    const participants = requiredStringArray(beat.participants, `${beatLabel}.participants`);
    assertParticipantsInCast(participants, castNames, `${beatLabel}.participants`);
    return {
      participants,
      publicStateBefore: requiredText(beat.publicStateBefore, `${beatLabel}.publicStateBefore`),
      hiddenStateBefore: optionalText(beat.hiddenStateBefore),
      trigger: requiredText(beat.trigger, `${beatLabel}.trigger`),
      shift: requiredText(beat.shift, `${beatLabel}.shift`),
      publicStateAfter: requiredText(beat.publicStateAfter, `${beatLabel}.publicStateAfter`),
      hiddenStateAfter: optionalText(beat.hiddenStateAfter),
    };
  });

  for (const [index, sceneBeat] of (options.sceneBeats ?? []).entries()) {
    const participants = requiredStringArray(sceneBeat.participants, `${label}.sceneBeats[${index}].participants`);
    assertParticipantsInCast(participants, castNames, `${label}.sceneBeats[${index}].participants`);
  }

  return {
    ...(povCharacter ? { povCharacter } : {}),
    cast,
    relationshipBeats,
    newMinorCharacters,
  };
}

export function extractVolumeCandidateNames(characterPlan: unknown): string[] {
  return requiredRecordArray(asRecord(characterPlan).newCharacterCandidates, 'characterPlan.newCharacterCandidates')
    .map((candidate) => requiredText(candidate.name, 'characterPlan.newCharacterCandidates.name'));
}

function assertParticipantsInCast(participants: string[], castNames: Set<string>, label: string): void {
  for (const participant of participants) {
    if (!castNames.has(normalizeName(participant))) {
      throw new Error(`${label} 未被 characterExecution.cast 覆盖：${participant}`);
    }
  }
}

function assertKnownCharacterReferences(names: string[], knownNames: Set<string>, label: string): void {
  for (const name of names) {
    if (!knownNames.has(normalizeName(name))) {
      throw new Error(`${label} 引用未知角色：${name}`);
    }
  }
}

function resolveExistingCharacterName(name: string, catalog: CharacterReferenceCatalog): string | undefined {
  const target = normalizeName(name);
  const existingNames = catalog.existingCharacterNames ?? [];
  const direct = existingNames.find((item) => normalizeName(item) === target);
  if (direct) return direct;
  for (const [canonicalName, aliases] of Object.entries(catalog.existingCharacterAliases ?? {})) {
    if (normalizeName(canonicalName) === target) return canonicalName;
    if (normalizeNameList(aliases).has(target)) return canonicalName;
  }
  return undefined;
}

function requiredRecordArray(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组。`);
  }
  return value.map((item, index) => {
    const record = asRecord(item);
    if (!Object.keys(record).length) {
      throw new Error(`${label}[${index}] 必须是对象。`);
    }
    return record;
  });
}

function requiredEnum<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  const item = requiredText(value, label) as T;
  if (!allowed.has(item)) {
    throw new Error(`${label} 非法：${item}`);
  }
  return item;
}

function requiredText(value: unknown, label: string): string {
  const item = text(value);
  if (!item) throw new Error(`${label} 缺失。`);
  return item;
}

function optionalText(value: unknown): string | undefined {
  const item = text(value);
  return item || undefined;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} 必须是布尔值。`);
  }
  return value;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function requiredStringArray(value: unknown, label: string): string[] {
  const items = stringArray(value);
  if (!items.length) throw new Error(`${label} 缺失。`);
  return items;
}

function requiredPositiveInt(value: unknown, label: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} 必须是正整数。`);
  }
  return numeric;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredPositiveInt(value, label);
}

function requiredPositiveIntArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组。`);
  const items = value.map((item) => Number(item));
  if (!items.length || items.some((item) => !Number.isInteger(item) || item < 1)) {
    throw new Error(`${label} 必须是正整数数组。`);
  }
  return items;
}

function normalizeNameList(names: string[]): Set<string> {
  return new Set(names.map((name) => normalizeName(name)).filter(Boolean));
}

function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
