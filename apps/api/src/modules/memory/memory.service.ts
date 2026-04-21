import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  search(projectId: string, query?: string) {
    return this.prisma.memoryChunk.findMany({
      where: {
        projectId,
        ...(query
          ? {
              OR: [
                { content: { contains: query, mode: 'insensitive' } },
                { summary: { contains: query, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ importanceScore: 'desc' }, { createdAt: 'desc' }],
    });
  }

  rebuild(projectId: string) {
    const sourceId = randomUUID();
    return this.prisma.memoryChunk
      .create({
        data: {
          projectId,
          sourceType: 'system',
          sourceId,
          memoryType: 'summary',
          content: '项目记忆已触发重建（MVP 占位逻辑）。',
          summary: 'memory rebuild placeholder',
          tags: ['system', 'rebuild'],
          importanceScore: 50,
          recencyScore: 100,
        },
      })
      .then((chunk) => ({
        accepted: true,
        projectId,
        createdChunkId: chunk.id,
        message: '已触发记忆重建占位流程',
      }));
  }
}
