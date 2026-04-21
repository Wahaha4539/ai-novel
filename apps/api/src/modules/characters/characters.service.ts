import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCharacterDto } from './dto/create-character.dto';

@Injectable()
export class CharactersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(projectId: string, dto: CreateCharacterDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.character.create({
      data: {
        projectId,
        name: dto.name,
        roleType: dto.roleType,
        personalityCore: dto.personalityCore,
        motivation: dto.motivation,
        speechStyle: dto.speechStyle,
      },
    });
  }

  listByProject(projectId: string) {
    return this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
