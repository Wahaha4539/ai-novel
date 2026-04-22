import { Injectable, NotFoundException } from '@nestjs/common';
import { NovelCacheService } from '../../common/cache/novel-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCharacterDto } from './dto/create-character.dto';
import { UpdateCharacterDto } from './dto/update-character.dto';

@Injectable()
export class CharactersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cacheService: NovelCacheService,
  ) {}

  async create(projectId: string, dto: CreateCharacterDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    const character = await this.prisma.character.create({
      data: {
        projectId,
        name: dto.name,
        roleType: dto.roleType,
        personalityCore: dto.personalityCore,
        motivation: dto.motivation,
        speechStyle: dto.speechStyle,
      },
    });

    await this.cacheService.deleteProjectChapterContexts(projectId);
    return character;
  }

  listByProject(projectId: string) {
    return this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async getOne(projectId: string, characterId: string) {
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, projectId },
    });

    if (!character) {
      throw new NotFoundException(`角色不存在：${characterId}`);
    }

    return character;
  }

  async update(projectId: string, characterId: string, dto: UpdateCharacterDto) {
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, projectId },
    });

    if (!character) {
      throw new NotFoundException(`角色不存在：${characterId}`);
    }

    const updated = await this.prisma.character.update({
      where: { id: characterId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.roleType !== undefined && { roleType: dto.roleType }),
        ...(dto.personalityCore !== undefined && { personalityCore: dto.personalityCore }),
        ...(dto.motivation !== undefined && { motivation: dto.motivation }),
        ...(dto.speechStyle !== undefined && { speechStyle: dto.speechStyle }),
        ...(dto.backstory !== undefined && { backstory: dto.backstory }),
        ...(dto.growthArc !== undefined && { growthArc: dto.growthArc }),
        ...(dto.isDead !== undefined && { isDead: dto.isDead }),
      },
    });

    await this.cacheService.deleteProjectChapterContexts(projectId);
    return updated;
  }

  async remove(projectId: string, characterId: string) {
    const character = await this.prisma.character.findFirst({
      where: { id: characterId, projectId },
    });

    if (!character) {
      throw new NotFoundException(`角色不存在：${characterId}`);
    }

    await this.prisma.character.delete({ where: { id: characterId } });
    await this.cacheService.deleteProjectChapterContexts(projectId);

    return { deleted: true, id: characterId };
  }
}
