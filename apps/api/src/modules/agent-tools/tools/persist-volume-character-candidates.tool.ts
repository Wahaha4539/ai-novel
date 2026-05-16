import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmChatMessage } from '../../llm/dto/llm-chat.dto';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { DEFAULT_LLM_TIMEOUT_MS } from '../../llm/llm-timeout.constants';
import { BaseTool, ToolContext } from '../base-tool';
import { ToolManifestV2 } from '../tool-manifest.types';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { assertVolumeCharacterPlan, VOLUME_CHARACTER_ROLE_TYPES, VolumeCharacterPlan } from './outline-character-contracts';
import { recordToolLlmUsage } from './import-preview-llm-usage';

interface PersistVolumeCharacterCandidatesInput {
  preview?: OutlinePreviewOutput;
  approvedCandidateIds?: string[];
  approvedCandidateNames?: string[];
  approveAll?: boolean;
  includeRelationshipArcs?: boolean;
}

interface ExistingCharacter {
  id: string;
  name: string;
  alias?: unknown;
  roleType?: string | null;
  personalityCore?: string | null;
  motivation?: string | null;
  speechStyle?: string | null;
  backstory?: string | null;
  growthArc?: string | null;
  source?: string | null;
  metadata?: unknown;
}

interface CharacterWriteResult {
  candidateId: string;
  name: string;
  action: 'created' | 'updated' | 'skipped';
  characterId?: string;
  reason?: string;
}

interface RelationshipWriteResult {
  participants: string[];
  action: 'created' | 'skipped';
  relationshipId?: string;
  reason?: string;
}

interface PersistVolumeCharacterCandidatesOutput {
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  relationshipCreatedCount: number;
  relationshipSkippedCount: number;
  profileGeneratedCount: number;
  characterResults: CharacterWriteResult[];
  relationshipResults: RelationshipWriteResult[];
  approvalMessage: string;
}

type VolumeCharacterCandidate = VolumeCharacterPlan['newCharacterCandidates'][number];

interface CharacterProfileCard {
  name: string;
  roleType: VolumeCharacterCandidate['roleType'];
  oneLinePositioning: string;
  detailedProfile: {
    age: string;
    identity: string;
    appearanceKeywords: string[];
    personalityCore: string;
    surfaceGoal: string;
    deepNeed: string;
    coreFear: string;
    majorFlaw: string;
    hiddenSecret: string;
    moralBoundary: string;
  };
  characterArc: {
    initialState: string;
    falseBelief: string;
    keyBlow: string;
    turningPoint: string;
    finalChange: string;
    failedEnding: string;
    growthEnding: string;
  };
  relationships: {
    withProtagonist: string;
    withAntagonist: string;
    withWorldForces: string;
    conflictMakers: string[];
    misunderstandingMakers: string[];
    foreshadowLinks: string[];
  };
  voiceProfile: {
    commonSentencePatterns: string[];
    rhythm: string;
    emotionalExposure: string;
    addressHabits: string[];
    forbiddenExpressions: string[];
    sampleDialogues: string[];
  };
  storyUsage: {
    plotDrivers: string[];
    foreshadowSuitability: string[];
    suggestedAppearanceChapters: number[];
    possibleProblems: string[];
    laterPayoffSettings: string[];
  };
  usableForeshadows: string[];
  conflictEngines: string[];
  debutSceneSuggestions: string[];
  lateTwistPossibilities: string[];
}

const CHARACTER_PROFILE_APP_STEP = 'agent_volume_character_profile';

@Injectable()
export class PersistVolumeCharacterCandidatesTool implements BaseTool<PersistVolumeCharacterCandidatesInput, PersistVolumeCharacterCandidatesOutput> {
  name = 'persist_volume_character_candidates';
  description = '用户明确审批后，将卷纲 characterPlan 中选定的卷级候选写入正式 Character；不会写入章节临时角色，也不会覆盖手工角色。';
  inputSchema = {
    type: 'object' as const,
    required: ['preview'],
    additionalProperties: false,
    properties: {
      preview: { type: 'object' as const },
      approvedCandidateIds: { type: 'array' as const, items: { type: 'string' as const } },
      approvedCandidateNames: { type: 'array' as const, items: { type: 'string' as const } },
      approveAll: { type: 'boolean' as const },
      includeRelationshipArcs: { type: 'boolean' as const },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['createdCount', 'updatedCount', 'skippedCount', 'relationshipCreatedCount', 'relationshipSkippedCount', 'profileGeneratedCount', 'characterResults', 'relationshipResults', 'approvalMessage'],
    properties: {
      createdCount: { type: 'number' as const, minimum: 0 },
      updatedCount: { type: 'number' as const, minimum: 0 },
      skippedCount: { type: 'number' as const, minimum: 0 },
      relationshipCreatedCount: { type: 'number' as const, minimum: 0 },
      relationshipSkippedCount: { type: 'number' as const, minimum: 0 },
      profileGeneratedCount: { type: 'number' as const, minimum: 0 },
      characterResults: { type: 'array' as const },
      relationshipResults: { type: 'array' as const },
      approvalMessage: { type: 'string' as const },
    },
  };
  allowedModes: Array<'act'> = ['act'];
  riskLevel: 'high' = 'high';
  requiresApproval = true;
  sideEffects = ['create_or_update_volume_characters', 'create_relationship_edges'];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: 'Persist Volume Character Candidates',
    description: 'After explicit approval, enriches each new selected volume-level character candidate with one dedicated LLM call, then writes the complete character card into the official Character table. Set approvedCandidateIds/approvedCandidateNames, or approveAll=true only when the user approved every candidate. It does not persist chapter-only temporary characters and does not overwrite manual characters.',
    whenToUse: ['Use after the outline preview/merge has succeeded and the user explicitly approves turning selected volume character candidates into official characters.', 'Use when simple outline candidates need full long-term character cards before being saved.'],
    whenNotToUse: ['Do not use for chapter minor_temporary characters.', 'Do not use for drafting chapter prose or persisting outline JSON.'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    failureHints: [
      {
        code: 'UNRESOLVED_RELATIONSHIP_PARTICIPANT',
        meaning: 'A relationship arc participant could not be resolved to an existing or approved character.',
        suggestedRepair: 'Approve the missing volume candidate first, add the character manually, or regenerate a valid characterPlan.',
      },
    ],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
    @Optional() private readonly llm?: LlmGatewayService,
  ) {}

  async run(args: PersistVolumeCharacterCandidatesInput, context: ToolContext): Promise<PersistVolumeCharacterCandidatesOutput> {
    if (context.mode !== 'act') throw new BadRequestException('persist_volume_character_candidates must run in act mode.');
    if (!context.approved) throw new BadRequestException('persist_volume_character_candidates requires explicit user approval.');
    if (!args.preview?.volume?.narrativePlan) throw new BadRequestException('persist_volume_character_candidates requires an outline preview with volume.narrativePlan.characterPlan.');
    if (!this.hasExplicitCandidateSelection(args)) {
      throw new BadRequestException('persist_volume_character_candidates requires explicit approvedCandidateIds/approvedCandidateNames, or approveAll=true when the user approved every volume character candidate.');
    }

    const existingCharacters = await this.findExistingCharacters(this.prisma, context.projectId);
    const catalog = this.buildCharacterCatalog(existingCharacters);
    const characterPlan = assertVolumeCharacterPlan(this.asRecord(args.preview.volume.narrativePlan).characterPlan, {
      chapterCount: Number(args.preview.volume.chapterCount),
      existingCharacterNames: existingCharacters.map((character) => character.name),
      existingCharacterAliases: catalog.aliases,
      label: 'volume.narrativePlan.characterPlan',
    });
    const selectedCandidates = this.selectCandidates(characterPlan, args);
    const candidatesToCreate = selectedCandidates.filter((candidate) => !this.findCharacter(candidate.name, catalog));
    const profileCards = await this.generateProfilesForNewCandidates(candidatesToCreate, args.preview, context, existingCharacters, characterPlan);

    const result = await this.prisma.$transaction(async (tx) => {
      const latestExistingCharacters = await this.findExistingCharacters(tx, context.projectId);
      const latestCatalog = this.buildCharacterCatalog(latestExistingCharacters);
      const characterResults: CharacterWriteResult[] = [];

      for (const candidate of selectedCandidates) {
        const existing = this.findCharacter(candidate.name, latestCatalog);
        if (!existing) {
          const profile = profileCards.get(candidate.candidateId);
          if (!profile) {
            throw new BadRequestException(`Missing generated character profile for approved candidate ${candidate.name}.`);
          }
          const created = await tx.character.create({
            data: this.buildCharacterCreateData(candidate, profile, args.preview!, context),
          });
          const saved = { id: created.id, name: created.name, alias: created.alias, source: created.source, metadata: created.metadata };
          this.addCharacterToCatalog(saved, latestCatalog);
          characterResults.push({ candidateId: candidate.candidateId, name: candidate.name, action: 'created', characterId: created.id });
          continue;
        }

        characterResults.push({ candidateId: candidate.candidateId, name: candidate.name, action: 'skipped', characterId: existing.id, reason: 'existing_character' });
      }

      const relationshipResults = args.includeRelationshipArcs
        ? await this.persistRelationshipArcs(tx, characterPlan, latestCatalog, context, args.preview!)
        : [];

      return this.buildOutput(characterResults, relationshipResults, profileCards.size);
    });

    if (result.createdCount || result.updatedCount || result.relationshipCreatedCount) {
      await this.cacheService.deleteProjectRecallResults(context.projectId);
    }
    return result;
  }

  private selectCandidates(characterPlan: VolumeCharacterPlan, args: PersistVolumeCharacterCandidatesInput): VolumeCharacterPlan['newCharacterCandidates'] {
    const idSelection = new Set((args.approvedCandidateIds ?? []).map((item) => this.normalizeName(item)).filter(Boolean));
    const nameSelection = new Set((args.approvedCandidateNames ?? []).map((item) => this.normalizeName(item)).filter(Boolean));
    if (args.approveAll === true) return characterPlan.newCharacterCandidates;

    const candidates = characterPlan.newCharacterCandidates.filter((candidate) => (
      idSelection.has(this.normalizeName(candidate.candidateId)) || nameSelection.has(this.normalizeName(candidate.name))
    ));
    const knownIds = new Set(characterPlan.newCharacterCandidates.map((candidate) => this.normalizeName(candidate.candidateId)));
    const knownNames = new Set(characterPlan.newCharacterCandidates.map((candidate) => this.normalizeName(candidate.name)));
    const unknownIds = [...idSelection].filter((id) => !knownIds.has(id));
    const unknownNames = [...nameSelection].filter((name) => !knownNames.has(name));
    if (unknownIds.length || unknownNames.length) {
      throw new BadRequestException(`Unknown volume character candidate selection: ${[...unknownIds, ...unknownNames].join(', ')}`);
    }
    return candidates;
  }

  private hasExplicitCandidateSelection(args: PersistVolumeCharacterCandidatesInput): boolean {
    return args.approveAll === true
      || (args.approvedCandidateIds ?? []).some((item) => this.normalizeName(item).length > 0)
      || (args.approvedCandidateNames ?? []).some((item) => this.normalizeName(item).length > 0);
  }

  private async persistRelationshipArcs(
    tx: Prisma.TransactionClient,
    characterPlan: VolumeCharacterPlan,
    catalog: { byName: Map<string, ExistingCharacter>; aliases: Record<string, string[]> },
    context: ToolContext,
    preview: OutlinePreviewOutput,
  ): Promise<RelationshipWriteResult[]> {
    const existingRelationships = await tx.relationshipEdge.findMany({
      where: { projectId: context.projectId },
      select: { characterAName: true, characterBName: true, relationType: true },
    });
    const existingKeys = new Set(existingRelationships.map((edge) => this.relationshipKey(edge.characterAName, edge.characterBName, edge.relationType)));
    const results: RelationshipWriteResult[] = [];

    for (const arc of characterPlan.relationshipArcs) {
      if (arc.participants.length !== 2) {
        throw new BadRequestException(`relationshipArcs.participants must contain exactly two characters: ${arc.participants.join(', ')}`);
      }
      const [characterAName, characterBName] = arc.participants;
      const characterA = this.findCharacter(characterAName, catalog);
      const characterB = this.findCharacter(characterBName, catalog);
      if (!characterA || !characterB) {
        throw new BadRequestException(`UNRESOLVED_RELATIONSHIP_PARTICIPANT: ${arc.participants.join(' / ')}`);
      }
      const relationType = 'volume_arc';
      const key = this.relationshipKey(characterA.name, characterB.name, relationType);
      if (existingKeys.has(key)) {
        results.push({ participants: arc.participants, action: 'skipped', reason: 'existing_relationship' });
        continue;
      }
      const created = await tx.relationshipEdge.create({
        data: {
          projectId: context.projectId,
          characterAId: characterA.id,
          characterBId: characterB.id,
          characterAName: characterA.name,
          characterBName: characterB.name,
          relationType,
          publicState: arc.startState,
          hiddenState: arc.hiddenTension,
          turnChapterNos: arc.turnChapterNos as Prisma.InputJsonValue,
          finalState: arc.endState,
          sourceType: 'agent_outline',
          metadata: {
            agentRunId: context.agentRunId,
            volumeNo: preview.volume.volumeNo,
            sourceTool: this.name,
            participantNames: arc.participants,
          } as Prisma.InputJsonValue,
        },
      });
      existingKeys.add(key);
      results.push({ participants: arc.participants, action: 'created', relationshipId: created.id });
    }

    return results;
  }

  private buildOutput(characterResults: CharacterWriteResult[], relationshipResults: RelationshipWriteResult[], profileGeneratedCount: number): PersistVolumeCharacterCandidatesOutput {
    const createdCount = characterResults.filter((result) => result.action === 'created').length;
    const updatedCount = characterResults.filter((result) => result.action === 'updated').length;
    const skippedCount = characterResults.filter((result) => result.action === 'skipped').length;
    const relationshipCreatedCount = relationshipResults.filter((result) => result.action === 'created').length;
    const relationshipSkippedCount = relationshipResults.filter((result) => result.action === 'skipped').length;
    return {
      createdCount,
      updatedCount,
      skippedCount,
      relationshipCreatedCount,
      relationshipSkippedCount,
      profileGeneratedCount,
      characterResults,
      relationshipResults,
      approvalMessage: `Approved ${createdCount} new volume-level character writes to Character after ${profileGeneratedCount} dedicated character-profile LLM calls; skipped ${skippedCount} candidates that already exist in Character. Outline JSON remains in Volume.narrativePlan and Chapter.craftBrief, and chapter minor_temporary characters are not written as Character records.`,
    };
  }

  private buildCharacterCreateData(candidate: VolumeCharacterPlan['newCharacterCandidates'][number], profile: CharacterProfileCard, preview: OutlinePreviewOutput, context: ToolContext): Prisma.CharacterCreateInput {
    return {
      project: { connect: { id: context.projectId } },
      name: candidate.name,
      roleType: candidate.roleType,
      personalityCore: profile.detailedProfile.personalityCore,
      motivation: this.formatCharacterMotivation(profile),
      speechStyle: this.formatCharacterSpeechStyle(profile),
      backstory: this.formatCharacterBackstory(candidate, profile),
      growthArc: this.formatCharacterGrowthArc(profile),
      scope: 'volume',
      activeFromChapter: candidate.firstAppearChapter,
      source: 'agent_outline',
      metadata: this.buildCharacterMetadata(candidate, profile, preview, context),
    };
  }

  private buildCharacterMetadata(candidate: VolumeCharacterPlan['newCharacterCandidates'][number], profile: CharacterProfileCard, preview: OutlinePreviewOutput, context: ToolContext): Prisma.InputJsonObject {
    return {
      sourceTool: this.name,
      agentRunId: context.agentRunId,
      volumeNo: preview.volume.volumeNo,
      candidateId: candidate.candidateId,
      simpleCandidate: this.buildSimpleCandidateMetadata(candidate),
      narrativeFunction: candidate.narrativeFunction,
      conflictWith: candidate.conflictWith,
      relationshipAnchors: candidate.relationshipAnchors,
      expectedArc: candidate.expectedArc,
      approvalStatus: 'approved',
      characterProfile: profile as unknown as Prisma.InputJsonObject,
    };
  }

  private async generateProfilesForNewCandidates(
    candidates: VolumeCharacterCandidate[],
    preview: OutlinePreviewOutput,
    context: ToolContext,
    existingCharacters: ExistingCharacter[],
    characterPlan: VolumeCharacterPlan,
  ): Promise<Map<string, CharacterProfileCard>> {
    const profiles = new Map<string, CharacterProfileCard>();
    if (!candidates.length) return profiles;
    if (!this.llm) {
      throw new BadRequestException('persist_volume_character_candidates requires LLM to expand approved character candidates before writing Character records.');
    }

    for (const [index, candidate] of candidates.entries()) {
      await context.updateProgress?.({
        phase: 'calling_llm',
        phaseMessage: `正在扩展角色卡：${candidate.name}`,
        progressCurrent: index + 1,
        progressTotal: candidates.length,
        timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      });
      const response = await this.llm.chatJson<unknown>(
        this.buildCharacterProfileMessages(candidate, preview, existingCharacters, characterPlan),
        {
          appStep: CHARACTER_PROFILE_APP_STEP,
          timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
          retries: 1,
          temperature: 0.2,
          jsonSchema: this.buildCharacterProfileJsonSchema(candidate),
          maxTokens: 6000,
        },
      );
      recordToolLlmUsage(context, CHARACTER_PROFILE_APP_STEP, response.result);
      profiles.set(candidate.candidateId, this.normalizeCharacterProfile(response.data, candidate, preview));
    }

    await context.updateProgress?.({
      phase: 'persisting',
      phaseMessage: '角色卡扩展完成，正在写入已审批角色',
      progressCurrent: candidates.length,
      progressTotal: candidates.length,
      timeoutMs: 120_000,
    });
    return profiles;
  }

  private buildCharacterProfileMessages(
    candidate: VolumeCharacterCandidate,
    preview: OutlinePreviewOutput,
    existingCharacters: ExistingCharacter[],
    characterPlan: VolumeCharacterPlan,
  ): LlmChatMessage[] {
    const payload = this.buildCharacterProfilePromptPayload(candidate, preview, existingCharacters, characterPlan);
    return [
      {
        role: 'system',
        content: [
          'You create long-term reusable character cards for a Chinese web-novel project.',
          'Expand exactly one approved simple volume-level character candidate into a complete structured character profile.',
          'Keep candidate.name and candidate.roleType exactly unchanged. Do not merge it into an existing character and do not invent a different target character.',
          'Use the provided outline context: genre/world/mainline conflict when present, volume goals, existing characters, candidate narrative function, relationship anchors, and chapter appearance plan.',
          'The profile must be concrete enough for future outline, drafting, dialogue, foreshadow, and relationship work. Avoid generic placeholders and empty slogans.',
          'Return only one JSON object matching the schema. No Markdown, no commentary, no arrays outside the target JSON object.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          'Create the full character card for this approved volume candidate. Borrow the spirit of a professional novel-character-generator workflow, but fit it to this project context and the exact schema.',
          'Required creative coverage: one-line positioning, detailed profile, character arc, relationship design, voice profile, story usage, usable foreshadows, conflict engines, three debut scene suggestions, and three late twist possibilities.',
          'The simple candidate came from an outline preview and is intentionally brief. Do not treat missing details as permission to write placeholders; infer concrete details from the project context and return structured fields.',
          '',
          'Context payload:',
          this.stringifyForPrompt(payload, 24_000),
        ].join('\n'),
      },
    ];
  }

  private buildCharacterProfilePromptPayload(
    candidate: VolumeCharacterCandidate,
    preview: OutlinePreviewOutput,
    existingCharacters: ExistingCharacter[],
    characterPlan: VolumeCharacterPlan,
  ): Record<string, unknown> {
    const narrativePlan = this.asRecord(preview.volume.narrativePlan);
    return {
      targetCandidate: candidate,
      volume: {
        volumeNo: preview.volume.volumeNo,
        title: preview.volume.title,
        synopsis: preview.volume.synopsis,
        objective: preview.volume.objective,
        chapterCount: preview.volume.chapterCount,
      },
      narrativeContext: {
        globalMainlineStage: narrativePlan.globalMainlineStage,
        volumeMainline: narrativePlan.volumeMainline,
        dramaticQuestion: narrativePlan.dramaticQuestion,
        startState: narrativePlan.startState,
        endState: narrativePlan.endState,
        mainlineMilestones: narrativePlan.mainlineMilestones,
        subStoryLines: narrativePlan.subStoryLines,
        storyUnits: narrativePlan.storyUnits,
        foreshadowPlan: narrativePlan.foreshadowPlan,
        endingHook: narrativePlan.endingHook,
        handoffToNextVolume: narrativePlan.handoffToNextVolume,
      },
      existingCharacters: existingCharacters.map((character) => this.compactExistingCharacter(character)),
      existingCharacterArcs: characterPlan.existingCharacterArcs,
      relationshipArcs: characterPlan.relationshipArcs,
      roleCoverage: characterPlan.roleCoverage,
      chapterOutlinePreview: (preview.chapters ?? []).slice(0, 24).map((chapter) => ({
        chapterNo: chapter.chapterNo,
        title: chapter.title,
        objective: chapter.objective,
        conflict: chapter.conflict,
        hook: chapter.hook,
        outline: chapter.outline,
      })),
    };
  }

  private normalizeCharacterProfile(data: unknown, candidate: VolumeCharacterCandidate, preview: OutlinePreviewOutput): CharacterProfileCard {
    const record = this.asRecord(data);
    const name = this.requiredText(record.name, 'characterProfile.name');
    if (this.normalizeName(name) !== this.normalizeName(candidate.name)) {
      throw new BadRequestException(`characterProfile.name must match approved candidate name ${candidate.name}.`);
    }
    const roleType = this.requiredRoleType(record.roleType, 'characterProfile.roleType');
    if (roleType !== candidate.roleType) {
      throw new BadRequestException(`characterProfile.roleType must match approved candidate roleType ${candidate.roleType}.`);
    }

    const detailedProfile = this.asRecord(record.detailedProfile);
    const characterArc = this.asRecord(record.characterArc);
    const relationships = this.asRecord(record.relationships);
    const voiceProfile = this.asRecord(record.voiceProfile);
    const storyUsage = this.asRecord(record.storyUsage);
    const chapterCount = Number(preview.volume.chapterCount);

    return {
      name,
      roleType,
      oneLinePositioning: this.requiredText(record.oneLinePositioning, 'characterProfile.oneLinePositioning'),
      detailedProfile: {
        age: this.requiredText(detailedProfile.age, 'characterProfile.detailedProfile.age'),
        identity: this.requiredText(detailedProfile.identity, 'characterProfile.detailedProfile.identity'),
        appearanceKeywords: this.requiredStringArray(detailedProfile.appearanceKeywords, 'characterProfile.detailedProfile.appearanceKeywords', 3),
        personalityCore: this.requiredText(detailedProfile.personalityCore, 'characterProfile.detailedProfile.personalityCore'),
        surfaceGoal: this.requiredText(detailedProfile.surfaceGoal, 'characterProfile.detailedProfile.surfaceGoal'),
        deepNeed: this.requiredText(detailedProfile.deepNeed, 'characterProfile.detailedProfile.deepNeed'),
        coreFear: this.requiredText(detailedProfile.coreFear, 'characterProfile.detailedProfile.coreFear'),
        majorFlaw: this.requiredText(detailedProfile.majorFlaw, 'characterProfile.detailedProfile.majorFlaw'),
        hiddenSecret: this.requiredText(detailedProfile.hiddenSecret, 'characterProfile.detailedProfile.hiddenSecret'),
        moralBoundary: this.requiredText(detailedProfile.moralBoundary, 'characterProfile.detailedProfile.moralBoundary'),
      },
      characterArc: {
        initialState: this.requiredText(characterArc.initialState, 'characterProfile.characterArc.initialState'),
        falseBelief: this.requiredText(characterArc.falseBelief, 'characterProfile.characterArc.falseBelief'),
        keyBlow: this.requiredText(characterArc.keyBlow, 'characterProfile.characterArc.keyBlow'),
        turningPoint: this.requiredText(characterArc.turningPoint, 'characterProfile.characterArc.turningPoint'),
        finalChange: this.requiredText(characterArc.finalChange, 'characterProfile.characterArc.finalChange'),
        failedEnding: this.requiredText(characterArc.failedEnding, 'characterProfile.characterArc.failedEnding'),
        growthEnding: this.requiredText(characterArc.growthEnding, 'characterProfile.characterArc.growthEnding'),
      },
      relationships: {
        withProtagonist: this.requiredText(relationships.withProtagonist, 'characterProfile.relationships.withProtagonist'),
        withAntagonist: this.requiredText(relationships.withAntagonist, 'characterProfile.relationships.withAntagonist'),
        withWorldForces: this.requiredText(relationships.withWorldForces, 'characterProfile.relationships.withWorldForces'),
        conflictMakers: this.requiredStringArray(relationships.conflictMakers, 'characterProfile.relationships.conflictMakers'),
        misunderstandingMakers: this.requiredStringArray(relationships.misunderstandingMakers, 'characterProfile.relationships.misunderstandingMakers'),
        foreshadowLinks: this.requiredStringArray(relationships.foreshadowLinks, 'characterProfile.relationships.foreshadowLinks'),
      },
      voiceProfile: {
        commonSentencePatterns: this.requiredStringArray(voiceProfile.commonSentencePatterns, 'characterProfile.voiceProfile.commonSentencePatterns', 2),
        rhythm: this.requiredText(voiceProfile.rhythm, 'characterProfile.voiceProfile.rhythm'),
        emotionalExposure: this.requiredText(voiceProfile.emotionalExposure, 'characterProfile.voiceProfile.emotionalExposure'),
        addressHabits: this.requiredStringArray(voiceProfile.addressHabits, 'characterProfile.voiceProfile.addressHabits'),
        forbiddenExpressions: this.requiredStringArray(voiceProfile.forbiddenExpressions, 'characterProfile.voiceProfile.forbiddenExpressions'),
        sampleDialogues: this.requiredStringArray(voiceProfile.sampleDialogues, 'characterProfile.voiceProfile.sampleDialogues', 5),
      },
      storyUsage: {
        plotDrivers: this.requiredStringArray(storyUsage.plotDrivers, 'characterProfile.storyUsage.plotDrivers'),
        foreshadowSuitability: this.requiredStringArray(storyUsage.foreshadowSuitability, 'characterProfile.storyUsage.foreshadowSuitability'),
        suggestedAppearanceChapters: this.requiredChapterArray(storyUsage.suggestedAppearanceChapters, 'characterProfile.storyUsage.suggestedAppearanceChapters', chapterCount),
        possibleProblems: this.requiredStringArray(storyUsage.possibleProblems, 'characterProfile.storyUsage.possibleProblems'),
        laterPayoffSettings: this.requiredStringArray(storyUsage.laterPayoffSettings, 'characterProfile.storyUsage.laterPayoffSettings'),
      },
      usableForeshadows: this.requiredStringArray(record.usableForeshadows, 'characterProfile.usableForeshadows', 2),
      conflictEngines: this.requiredStringArray(record.conflictEngines, 'characterProfile.conflictEngines', 2),
      debutSceneSuggestions: this.requiredStringArray(record.debutSceneSuggestions, 'characterProfile.debutSceneSuggestions', 3),
      lateTwistPossibilities: this.requiredStringArray(record.lateTwistPossibilities, 'characterProfile.lateTwistPossibilities', 3),
    };
  }

  private buildCharacterProfileJsonSchema(candidate: VolumeCharacterCandidate): { name: string; description: string; schema: Record<string, unknown>; strict: boolean } {
    const stringArraySchema = { type: 'array', items: { type: 'string' } };
    const integerArraySchema = { type: 'array', items: { type: 'integer' } };
    return {
      name: 'volume_character_profile_card',
      description: `Full reusable character card for approved volume candidate ${candidate.name}.`,
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'name',
          'roleType',
          'oneLinePositioning',
          'detailedProfile',
          'characterArc',
          'relationships',
          'voiceProfile',
          'storyUsage',
          'usableForeshadows',
          'conflictEngines',
          'debutSceneSuggestions',
          'lateTwistPossibilities',
        ],
        properties: {
          name: { type: 'string' },
          roleType: { type: 'string', enum: [...VOLUME_CHARACTER_ROLE_TYPES] },
          oneLinePositioning: { type: 'string' },
          detailedProfile: { $ref: '#/$defs/detailedProfile' },
          characterArc: { $ref: '#/$defs/characterArc' },
          relationships: { $ref: '#/$defs/relationships' },
          voiceProfile: { $ref: '#/$defs/voiceProfile' },
          storyUsage: { $ref: '#/$defs/storyUsage' },
          usableForeshadows: stringArraySchema,
          conflictEngines: stringArraySchema,
          debutSceneSuggestions: stringArraySchema,
          lateTwistPossibilities: stringArraySchema,
        },
        $defs: {
          detailedProfile: {
            type: 'object',
            additionalProperties: false,
            required: ['age', 'identity', 'appearanceKeywords', 'personalityCore', 'surfaceGoal', 'deepNeed', 'coreFear', 'majorFlaw', 'hiddenSecret', 'moralBoundary'],
            properties: {
              age: { type: 'string' },
              identity: { type: 'string' },
              appearanceKeywords: stringArraySchema,
              personalityCore: { type: 'string' },
              surfaceGoal: { type: 'string' },
              deepNeed: { type: 'string' },
              coreFear: { type: 'string' },
              majorFlaw: { type: 'string' },
              hiddenSecret: { type: 'string' },
              moralBoundary: { type: 'string' },
            },
          },
          characterArc: {
            type: 'object',
            additionalProperties: false,
            required: ['initialState', 'falseBelief', 'keyBlow', 'turningPoint', 'finalChange', 'failedEnding', 'growthEnding'],
            properties: {
              initialState: { type: 'string' },
              falseBelief: { type: 'string' },
              keyBlow: { type: 'string' },
              turningPoint: { type: 'string' },
              finalChange: { type: 'string' },
              failedEnding: { type: 'string' },
              growthEnding: { type: 'string' },
            },
          },
          relationships: {
            type: 'object',
            additionalProperties: false,
            required: ['withProtagonist', 'withAntagonist', 'withWorldForces', 'conflictMakers', 'misunderstandingMakers', 'foreshadowLinks'],
            properties: {
              withProtagonist: { type: 'string' },
              withAntagonist: { type: 'string' },
              withWorldForces: { type: 'string' },
              conflictMakers: stringArraySchema,
              misunderstandingMakers: stringArraySchema,
              foreshadowLinks: stringArraySchema,
            },
          },
          voiceProfile: {
            type: 'object',
            additionalProperties: false,
            required: ['commonSentencePatterns', 'rhythm', 'emotionalExposure', 'addressHabits', 'forbiddenExpressions', 'sampleDialogues'],
            properties: {
              commonSentencePatterns: stringArraySchema,
              rhythm: { type: 'string' },
              emotionalExposure: { type: 'string' },
              addressHabits: stringArraySchema,
              forbiddenExpressions: stringArraySchema,
              sampleDialogues: stringArraySchema,
            },
          },
          storyUsage: {
            type: 'object',
            additionalProperties: false,
            required: ['plotDrivers', 'foreshadowSuitability', 'suggestedAppearanceChapters', 'possibleProblems', 'laterPayoffSettings'],
            properties: {
              plotDrivers: stringArraySchema,
              foreshadowSuitability: stringArraySchema,
              suggestedAppearanceChapters: integerArraySchema,
              possibleProblems: stringArraySchema,
              laterPayoffSettings: stringArraySchema,
            },
          },
        },
      },
    };
  }

  private formatCharacterMotivation(profile: CharacterProfileCard): string {
    return [
      `表层目标：${profile.detailedProfile.surfaceGoal}`,
      `深层需求：${profile.detailedProfile.deepNeed}`,
      `核心恐惧：${profile.detailedProfile.coreFear}`,
      `道德边界：${profile.detailedProfile.moralBoundary}`,
    ].join('\n');
  }

  private formatCharacterSpeechStyle(profile: CharacterProfileCard): string {
    return [
      `常用句式：${profile.voiceProfile.commonSentencePatterns.join('；')}`,
      `说话节奏：${profile.voiceProfile.rhythm}`,
      `情绪外露：${profile.voiceProfile.emotionalExposure}`,
      `称呼习惯：${profile.voiceProfile.addressHabits.join('；')}`,
      `禁用表达：${profile.voiceProfile.forbiddenExpressions.join('；')}`,
      `对白样例：${profile.voiceProfile.sampleDialogues.join(' / ')}`,
    ].join('\n');
  }

  private formatCharacterBackstory(candidate: VolumeCharacterCandidate, profile: CharacterProfileCard): string {
    return [
      `身份：${profile.detailedProfile.identity}`,
      `外貌关键词：${profile.detailedProfile.appearanceKeywords.join('、')}`,
      candidate.backstorySeed ? `候选背景种子：${candidate.backstorySeed}` : undefined,
      `隐藏秘密：${profile.detailedProfile.hiddenSecret}`,
      `与世界观势力关系：${profile.relationships.withWorldForces}`,
      `后期可回收设定：${profile.storyUsage.laterPayoffSettings.join('；')}`,
    ].filter((item): item is string => Boolean(item)).join('\n');
  }

  private formatCharacterGrowthArc(profile: CharacterProfileCard): string {
    return [
      `初始状态：${profile.characterArc.initialState}`,
      `错误信念：${profile.characterArc.falseBelief}`,
      `关键打击：${profile.characterArc.keyBlow}`,
      `转折点：${profile.characterArc.turningPoint}`,
      `最终变化：${profile.characterArc.finalChange}`,
      `失败版本结局：${profile.characterArc.failedEnding}`,
      `成长版本结局：${profile.characterArc.growthEnding}`,
    ].join('\n');
  }

  private buildSimpleCandidateMetadata(candidate: VolumeCharacterCandidate): Prisma.InputJsonObject {
    return {
      candidateId: candidate.candidateId,
      name: candidate.name,
      roleType: candidate.roleType,
      scope: candidate.scope,
      narrativeFunction: candidate.narrativeFunction,
      personalityCore: candidate.personalityCore,
      motivation: candidate.motivation,
      backstorySeed: candidate.backstorySeed ?? null,
      conflictWith: candidate.conflictWith,
      relationshipAnchors: candidate.relationshipAnchors,
      firstAppearChapter: candidate.firstAppearChapter,
      expectedArc: candidate.expectedArc,
      approvalStatus: candidate.approvalStatus,
    };
  }

  private compactExistingCharacter(character: ExistingCharacter): Record<string, unknown> {
    return {
      name: character.name,
      alias: Array.isArray(character.alias) ? character.alias : [],
      roleType: character.roleType ?? null,
      personalityCore: character.personalityCore ?? null,
      motivation: character.motivation ?? null,
      speechStyle: character.speechStyle ?? null,
      backstory: character.backstory ?? null,
      growthArc: character.growthArc ?? null,
      source: character.source ?? null,
    };
  }

  private async findExistingCharacters(
    client: { character: { findMany: (args: Prisma.CharacterFindManyArgs) => Promise<ExistingCharacter[]> } },
    projectId: string,
  ): Promise<ExistingCharacter[]> {
    return client.character.findMany({
      where: { projectId },
      select: {
        id: true,
        name: true,
        alias: true,
        roleType: true,
        personalityCore: true,
        motivation: true,
        speechStyle: true,
        backstory: true,
        growthArc: true,
        source: true,
        metadata: true,
      },
    });
  }

  private buildCharacterCatalog(characters: ExistingCharacter[]) {
    const byName = new Map<string, ExistingCharacter>();
    const aliases: Record<string, string[]> = {};
    for (const character of characters) this.addCharacterToCatalog(character, { byName, aliases });
    return { byName, aliases };
  }

  private addCharacterToCatalog(character: ExistingCharacter, catalog: { byName: Map<string, ExistingCharacter>; aliases: Record<string, string[]> }) {
    catalog.byName.set(this.normalizeName(character.name), character);
    const aliases = Array.isArray(character.alias)
      ? character.alias.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [];
    if (aliases.length) catalog.aliases[character.name] = aliases;
    for (const alias of aliases) catalog.byName.set(this.normalizeName(alias), character);
  }

  private findCharacter(name: string, catalog: { byName: Map<string, ExistingCharacter> }): ExistingCharacter | undefined {
    return catalog.byName.get(this.normalizeName(name));
  }

  private relationshipKey(characterAName: string, characterBName: string, relationType: string): string {
    return [...[characterAName, characterBName].map((name) => this.normalizeName(name)).sort(), this.normalizeName(relationType)].join('|');
  }

  private requiredRoleType(value: unknown, label: string): VolumeCharacterCandidate['roleType'] {
    const roleType = this.requiredText(value, label);
    if (!(VOLUME_CHARACTER_ROLE_TYPES as readonly string[]).includes(roleType)) {
      throw new BadRequestException(`${label} is invalid: ${roleType}`);
    }
    return roleType as VolumeCharacterCandidate['roleType'];
  }

  private requiredStringArray(value: unknown, label: string, minItems = 1): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${label} must be a string array.`);
    }
    const items = value.map((item) => this.text(item)).filter(Boolean);
    if (items.length < minItems) {
      throw new BadRequestException(`${label} must contain at least ${minItems} non-empty item(s).`);
    }
    return items;
  }

  private requiredChapterArray(value: unknown, label: string, chapterCount: number): number[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${label} must be an integer array.`);
    }
    const items = value.map((item) => Number(item));
    if (!items.length || items.some((item) => !Number.isInteger(item) || item < 1 || item > chapterCount)) {
      throw new BadRequestException(`${label} must contain chapter numbers within 1..${chapterCount}.`);
    }
    return items;
  }

  private requiredText(value: unknown, label: string): string {
    const item = this.text(value);
    if (!item) throw new BadRequestException(`${label} is required.`);
    return item;
  }

  private text(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
  }

  private stringifyForPrompt(value: unknown, maxChars: number): string {
    const text = JSON.stringify(value, null, 2);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n...[context truncated]`;
  }

  private normalizeName(value: string): string {
    return value.trim().toLocaleLowerCase();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
