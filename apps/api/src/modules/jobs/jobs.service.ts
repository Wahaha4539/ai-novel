import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type CreateJobInput = {
  projectId: string;
  jobType: 'write_chapter' | 'write_scene' | 'rewrite' | 'summarize' | 'validate';
  targetType: 'chapter' | 'scene' | 'draft';
  targetId: string;
  requestPayload: Record<string, unknown>;
};

const toJsonObject = (value: Record<string, unknown>): Prisma.InputJsonObject =>
  value as unknown as Prisma.InputJsonObject;

@Injectable()
export class JobsService {
  constructor(private readonly prisma: PrismaService) {}

  private findActiveJob(input: CreateJobInput) {
    return this.prisma.generationJob.findFirst({
      where: {
        projectId: input.projectId,
        jobType: input.jobType,
        targetType: input.targetType,
        targetId: input.targetId,
        status: { in: ['queued', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createOrReuse(input: CreateJobInput) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const activeJob = await tx.generationJob.findFirst({
              where: {
                projectId: input.projectId,
                jobType: input.jobType,
                targetType: input.targetType,
                targetId: input.targetId,
                status: { in: ['queued', 'running'] },
              },
              orderBy: { createdAt: 'desc' },
            });

            if (activeJob) {
              return { job: activeJob, created: false as const };
            }

            const job = await tx.generationJob.create({
              data: {
                projectId: input.projectId,
                chapterId: input.targetType === 'chapter' ? input.targetId : null,
                jobType: input.jobType,
                targetType: input.targetType,
                targetId: input.targetId,
                requestPayload: toJsonObject(input.requestPayload),
              },
            });

            return { job, created: true as const };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      } catch (error) {
        const isWriteConflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
        if (!isWriteConflict) {
          throw error;
        }

        const activeJob = await this.findActiveJob(input);
        if (activeJob) {
          return { job: activeJob, created: false as const };
        }

        if (attempt === maxAttempts) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, attempt * 50));
      }
    }

    throw new Error('create_or_reuse_exhausted');
  }

  create(input: CreateJobInput) {
    return this.prisma.generationJob.create({
      data: {
        projectId: input.projectId,
        chapterId: input.targetType === 'chapter' ? input.targetId : null,
        jobType: input.jobType,
        targetType: input.targetType,
        targetId: input.targetId,
        requestPayload: toJsonObject(input.requestPayload),
      },
    });
  }

  async getById(jobId: string) {
    const job = await this.prisma.generationJob.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      throw new NotFoundException(`任务不存在：${jobId}`);
    }

    return job;
  }

  listQueuedJobs(limit = 20) {
    return this.prisma.generationJob.findMany({
      where: { status: 'queued' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async markInterruptedJobsFailed() {
    const result = await this.prisma.generationJob.updateMany({
      where: {
        status: 'running',
        finishedAt: null,
      },
      data: {
        status: 'failed',
        errorMessage: 'job interrupted before completion',
        finishedAt: new Date(),
      },
    });

    return result.count;
  }

  async claimQueuedJob(jobId: string, promptSnapshot?: string) {
    const claimed = await this.prisma.generationJob.updateMany({
      where: {
        id: jobId,
        status: 'queued',
      },
      data: {
        status: 'running',
        promptSnapshot,
        startedAt: new Date(),
        errorMessage: null,
      },
    });

    if (claimed.count === 0) {
      return null;
    }

    return this.getById(jobId);
  }

  async markRunning(jobId: string, promptSnapshot?: string) {
    await this.getById(jobId);
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: 'running',
        promptSnapshot,
        startedAt: new Date(),
      },
    });
  }

  async markCompleted(jobId: string, responsePayload: Record<string, unknown>, retrievalPayload: Record<string, unknown>) {
    await this.getById(jobId);
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        responsePayload: toJsonObject(responsePayload),
        retrievalPayload: toJsonObject(retrievalPayload),
        errorMessage: null,
        finishedAt: new Date(),
      },
    });
  }

  async markFailed(jobId: string, errorMessage: string) {
    await this.getById(jobId);
    return this.prisma.generationJob.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        errorMessage,
        finishedAt: new Date(),
      },
    });
  }
}
