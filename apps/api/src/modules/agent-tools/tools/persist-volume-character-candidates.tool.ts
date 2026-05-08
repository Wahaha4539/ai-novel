import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../../common/cache/novel-cache.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import { ToolManifestV2 } from '../tool-manifest.types';
import { OutlinePreviewOutput } from './generate-outline-preview.tool';
import { assertVolumeCharacterPlan, VolumeCharacterPlan } from './outline-character-contracts';

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
  characterResults: CharacterWriteResult[];
  relationshipResults: RelationshipWriteResult[];
  approvalMessage: string;
}

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
    required: ['createdCount', 'updatedCount', 'skippedCount', 'relationshipCreatedCount', 'relationshipSkippedCount', 'characterResults', 'relationshipResults', 'approvalMessage'],
    properties: {
      createdCount: { type: 'number' as const, minimum: 0 },
      updatedCount: { type: 'number' as const, minimum: 0 },
      skippedCount: { type: 'number' as const, minimum: 0 },
      relationshipCreatedCount: { type: 'number' as const, minimum: 0 },
      relationshipSkippedCount: { type: 'number' as const, minimum: 0 },
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
    description: 'After explicit approval, writes explicitly selected volume-level character candidates into the official Character table. Set approvedCandidateIds/approvedCandidateNames, or approveAll=true only when the user approved every candidate. It does not persist chapter-only temporary characters and does not overwrite manual characters.',
    whenToUse: ['Use after validate_outline when the user explicitly approves turning selected volume character candidates into official characters.'],
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

  constructor(private readonly prisma: PrismaService, private readonly cacheService: NovelCacheService) {}

  async run(args: PersistVolumeCharacterCandidatesInput, context: ToolContext): Promise<PersistVolumeCharacterCandidatesOutput> {
    if (context.mode !== 'act') throw new BadRequestException('persist_volume_character_candidates must run in act mode.');
    if (!context.approved) throw new BadRequestException('persist_volume_character_candidates requires explicit user approval.');
    if (!args.preview?.volume?.narrativePlan) throw new BadRequestException('persist_volume_character_candidates requires an outline preview with volume.narrativePlan.characterPlan.');
    if (!this.hasExplicitCandidateSelection(args)) {
      throw new BadRequestException('persist_volume_character_candidates requires explicit approvedCandidateIds/approvedCandidateNames, or approveAll=true when the user approved every volume character candidate.');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const existingCharacters = await tx.character.findMany({
        where: { projectId: context.projectId },
        select: { id: true, name: true, alias: true, source: true, metadata: true },
      });
      const catalog = this.buildCharacterCatalog(existingCharacters);
      const characterPlan = assertVolumeCharacterPlan(this.asRecord(args.preview!.volume.narrativePlan).characterPlan, {
        chapterCount: Number(args.preview!.volume.chapterCount),
        existingCharacterNames: existingCharacters.map((character) => character.name),
        existingCharacterAliases: catalog.aliases,
        label: 'volume.narrativePlan.characterPlan',
      });
      const selectedCandidates = this.selectCandidates(characterPlan, args);
      const characterResults: CharacterWriteResult[] = [];

      for (const candidate of selectedCandidates) {
        const existing = this.findCharacter(candidate.name, catalog);
        if (!existing) {
          const created = await tx.character.create({
            data: this.buildCharacterCreateData(candidate, args.preview!, context),
          });
          const saved = { id: created.id, name: created.name, alias: created.alias, source: created.source, metadata: created.metadata };
          this.addCharacterToCatalog(saved, catalog);
          characterResults.push({ candidateId: candidate.candidateId, name: candidate.name, action: 'created', characterId: created.id });
          continue;
        }

        if (existing.source === 'agent_outline') {
          const updated = await tx.character.update({
            where: { id: existing.id },
            data: this.buildCharacterUpdateData(candidate, args.preview!, context, existing),
          });
          const saved = { id: updated.id, name: updated.name, alias: updated.alias, source: updated.source, metadata: updated.metadata };
          this.addCharacterToCatalog(saved, catalog);
          characterResults.push({ candidateId: candidate.candidateId, name: candidate.name, action: 'updated', characterId: updated.id });
        } else {
          characterResults.push({ candidateId: candidate.candidateId, name: candidate.name, action: 'skipped', characterId: existing.id, reason: 'existing_non_agent_character' });
        }
      }

      const relationshipResults = args.includeRelationshipArcs
        ? await this.persistRelationshipArcs(tx, characterPlan, catalog, context, args.preview!)
        : [];

      return this.buildOutput(characterResults, relationshipResults);
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

  private buildOutput(characterResults: CharacterWriteResult[], relationshipResults: RelationshipWriteResult[]): PersistVolumeCharacterCandidatesOutput {
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
      characterResults,
      relationshipResults,
      approvalMessage: `Approved ${createdCount + updatedCount} volume-level character writes to Character; skipped ${skippedCount}. Outline JSON remains in Volume.narrativePlan and Chapter.craftBrief, and chapter minor_temporary characters are not written as Character records.`,
    };
  }

  private buildCharacterCreateData(candidate: VolumeCharacterPlan['newCharacterCandidates'][number], preview: OutlinePreviewOutput, context: ToolContext): Prisma.CharacterCreateInput {
    return {
      project: { connect: { id: context.projectId } },
      name: candidate.name,
      roleType: candidate.roleType,
      personalityCore: candidate.personalityCore,
      motivation: candidate.motivation,
      backstory: candidate.backstorySeed,
      growthArc: candidate.expectedArc,
      scope: 'volume',
      activeFromChapter: candidate.firstAppearChapter,
      source: 'agent_outline',
      metadata: this.buildCharacterMetadata(candidate, preview, context),
    };
  }

  private buildCharacterUpdateData(candidate: VolumeCharacterPlan['newCharacterCandidates'][number], preview: OutlinePreviewOutput, context: ToolContext, existing: ExistingCharacter): Prisma.CharacterUpdateInput {
    return {
      roleType: candidate.roleType,
      personalityCore: candidate.personalityCore,
      motivation: candidate.motivation,
      backstory: candidate.backstorySeed,
      growthArc: candidate.expectedArc,
      scope: 'volume',
      activeFromChapter: candidate.firstAppearChapter,
      source: 'agent_outline',
      metadata: { ...this.asRecord(existing.metadata), ...this.buildCharacterMetadata(candidate, preview, context) } as Prisma.InputJsonValue,
    };
  }

  private buildCharacterMetadata(candidate: VolumeCharacterPlan['newCharacterCandidates'][number], preview: OutlinePreviewOutput, context: ToolContext): Prisma.InputJsonObject {
    return {
      sourceTool: this.name,
      agentRunId: context.agentRunId,
      volumeNo: preview.volume.volumeNo,
      candidateId: candidate.candidateId,
      narrativeFunction: candidate.narrativeFunction,
      conflictWith: candidate.conflictWith,
      relationshipAnchors: candidate.relationshipAnchors,
      expectedArc: candidate.expectedArc,
      approvalStatus: 'approved',
    };
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

  private normalizeName(value: string): string {
    return value.trim().toLocaleLowerCase();
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
}
