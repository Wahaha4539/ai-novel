import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVolumeDto } from './dto/create-volume.dto';
import { UpdateVolumeDto } from './dto/update-volume.dto';

@Injectable()
export class VolumesService {
  constructor(private readonly prisma: PrismaService) {}

  async listByProject(projectId: string) {
    return this.prisma.volume.findMany({
      where: { projectId },
      orderBy: { volumeNo: 'asc' },
      include: {
        _count: { select: { chapters: true } },
      },
    });
  }

  async create(projectId: string, dto: CreateVolumeDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.volume.create({
      data: {
        projectId,
        volumeNo: dto.volumeNo,
        title: dto.title,
        synopsis: dto.synopsis,
        objective: dto.objective,
        chapterCount: dto.chapterCount,
      },
    });
  }

  async getOne(projectId: string, volumeId: string) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, projectId },
      include: {
        chapters: {
          orderBy: { chapterNo: 'asc' },
          select: { id: true, chapterNo: true, title: true, status: true },
        },
      },
    });

    if (!volume) {
      throw new NotFoundException(`卷不存在：${volumeId}`);
    }

    return volume;
  }

  async update(projectId: string, volumeId: string, dto: UpdateVolumeDto) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, projectId },
    });

    if (!volume) {
      throw new NotFoundException(`卷不存在：${volumeId}`);
    }

    return this.prisma.volume.update({
      where: { id: volumeId },
      data: {
        ...(dto.volumeNo !== undefined && { volumeNo: dto.volumeNo }),
        ...(dto.title !== undefined && { title: dto.title }),
        ...(dto.synopsis !== undefined && { synopsis: dto.synopsis }),
        ...(dto.objective !== undefined && { objective: dto.objective }),
        ...(dto.chapterCount !== undefined && { chapterCount: dto.chapterCount }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
  }

  async remove(projectId: string, volumeId: string) {
    const volume = await this.prisma.volume.findFirst({
      where: { id: volumeId, projectId },
    });

    if (!volume) {
      throw new NotFoundException(`卷不存在：${volumeId}`);
    }

    // Unlink chapters (set volumeId to null) before deleting the volume
    await this.prisma.chapter.updateMany({
      where: { volumeId },
      data: { volumeId: null },
    });

    await this.prisma.volume.delete({ where: { id: volumeId } });
    return { deleted: true, id: volumeId };
  }

  async reorder(projectId: string, volumeIds: string[]) {
    const updates = volumeIds.map((id, index) =>
      this.prisma.volume.updateMany({
        where: { id, projectId },
        data: { volumeNo: index + 1 },
      }),
    );

    await this.prisma.$transaction(updates);
    return this.listByProject(projectId);
  }
}
