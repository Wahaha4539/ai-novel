import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChapterDto } from './dto/create-chapter.dto';

@Injectable()
export class ChaptersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(projectId: string, dto: CreateChapterDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.chapter.create({
      data: {
        projectId,
        chapterNo: dto.chapterNo,
        title: dto.title,
        objective: dto.objective,
        conflict: dto.conflict,
        outline: dto.outline,
        expectedWordCount: dto.expectedWordCount,
      },
    });
  }

  listByProject(projectId: string) {
    return this.prisma.chapter.findMany({
      where: { projectId },
      orderBy: { chapterNo: 'asc' },
    });
  }

  async getById(chapterId: string) {
    const chapter = await this.prisma.chapter.findUnique({
      where: { id: chapterId },
    });

    if (!chapter) {
      throw new NotFoundException(`章节不存在：${chapterId}`);
    }

    return chapter;
  }

  async markDrafted(chapterId: string, actualWordCount: number) {
    await this.getById(chapterId);
    return this.prisma.chapter.update({
      where: { id: chapterId },
      data: {
        status: 'drafted',
        actualWordCount,
      },
    });
  }
}
