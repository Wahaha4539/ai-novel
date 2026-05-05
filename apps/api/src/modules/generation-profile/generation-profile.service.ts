import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { buildGenerationProfileDefaults } from './generation-profile.defaults';
import { UpdateGenerationProfileDto } from './dto/update-generation-profile.dto';

@Injectable()
export class GenerationProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async get(projectId: string) {
    await this.assertProjectExists(projectId);

    const profile = await this.prisma.generationProfile.findUnique({ where: { projectId } });
    return profile ?? buildGenerationProfileDefaults(projectId);
  }

  async update(projectId: string, dto: UpdateGenerationProfileDto) {
    await this.assertProjectExists(projectId);

    const profile = await this.prisma.generationProfile.upsert({
      where: { projectId },
      create: this.buildGenerationProfileData(projectId, dto),
      update: this.buildGenerationProfilePatch(dto),
    });

    await this.cacheService.deleteProjectRecallResults(projectId);
    return profile;
  }

  private async assertProjectExists(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) {
      throw new NotFoundException(`Project not found: ${projectId}`);
    }
  }

  private buildGenerationProfileData(projectId: string, dto: UpdateGenerationProfileDto): Prisma.GenerationProfileUncheckedCreateInput {
    return {
      projectId,
      defaultChapterWordCount: dto.defaultChapterWordCount,
      autoContinue: dto.autoContinue ?? false,
      autoSummarize: dto.autoSummarize ?? true,
      autoUpdateCharacterState: dto.autoUpdateCharacterState ?? true,
      autoUpdateTimeline: dto.autoUpdateTimeline ?? false,
      autoValidation: dto.autoValidation ?? true,
      allowNewCharacters: dto.allowNewCharacters ?? false,
      allowNewLocations: dto.allowNewLocations ?? true,
      allowNewForeshadows: dto.allowNewForeshadows ?? true,
      preGenerationChecks: this.normalizeStringArray(dto.preGenerationChecks, 'preGenerationChecks') as Prisma.InputJsonValue,
      promptBudget: this.normalizeJsonObject(dto.promptBudget, 'promptBudget') as Prisma.InputJsonValue,
      metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue,
    };
  }

  private buildGenerationProfilePatch(dto: UpdateGenerationProfileDto): Prisma.GenerationProfileUncheckedUpdateInput {
    return {
      ...(dto.defaultChapterWordCount !== undefined && { defaultChapterWordCount: dto.defaultChapterWordCount }),
      ...(dto.autoContinue !== undefined && { autoContinue: dto.autoContinue ?? false }),
      ...(dto.autoSummarize !== undefined && { autoSummarize: dto.autoSummarize ?? true }),
      ...(dto.autoUpdateCharacterState !== undefined && { autoUpdateCharacterState: dto.autoUpdateCharacterState ?? true }),
      ...(dto.autoUpdateTimeline !== undefined && { autoUpdateTimeline: dto.autoUpdateTimeline ?? false }),
      ...(dto.autoValidation !== undefined && { autoValidation: dto.autoValidation ?? true }),
      ...(dto.allowNewCharacters !== undefined && { allowNewCharacters: dto.allowNewCharacters ?? false }),
      ...(dto.allowNewLocations !== undefined && { allowNewLocations: dto.allowNewLocations ?? true }),
      ...(dto.allowNewForeshadows !== undefined && { allowNewForeshadows: dto.allowNewForeshadows ?? true }),
      ...(dto.preGenerationChecks !== undefined && { preGenerationChecks: this.normalizeStringArray(dto.preGenerationChecks, 'preGenerationChecks') as Prisma.InputJsonValue }),
      ...(dto.promptBudget !== undefined && { promptBudget: this.normalizeJsonObject(dto.promptBudget, 'promptBudget') as Prisma.InputJsonValue }),
      ...(dto.metadata !== undefined && { metadata: this.normalizeJsonObject(dto.metadata, 'metadata') as Prisma.InputJsonValue }),
    };
  }

  private normalizeStringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array of strings.`);
    }
    if (value.some((item) => typeof item !== 'string')) {
      throw new BadRequestException(`${field} must contain only strings.`);
    }
    return value.map((item) => item.trim()).filter(Boolean);
  }

  private normalizeJsonObject(value: unknown, field: string): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException(`${field} must be a JSON object.`);
    }
    return value as Record<string, unknown>;
  }
}
