import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateLorebookEntryDto } from './dto/create-lorebook-entry.dto';

@Injectable()
export class LorebookService {
  constructor(private readonly prisma: PrismaService) {}

  async create(projectId: string, dto: CreateLorebookEntryDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.lorebookEntry.create({
      data: {
        projectId,
        title: dto.title,
        entryType: dto.entryType,
        content: dto.content,
        summary: dto.summary,
        tags: dto.tags ?? [],
      },
    });
  }

  list(projectId: string, q?: string) {
    return this.prisma.lorebookEntry.findMany({
      where: {
        projectId,
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: 'insensitive' } },
                { content: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
    });
  }
}
