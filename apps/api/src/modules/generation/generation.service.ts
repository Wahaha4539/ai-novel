import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { ChaptersService } from '../chapters/chapters.service';
import { JobsService } from '../jobs/jobs.service';
import { GenerateChapterDto } from './dto/generate-chapter.dto';
import { PolishChapterDto } from './dto/polish-chapter.dto';
import { GenerationQueueService } from './generation-queue.service';

@Injectable()
export class GenerationService {
  private readonly logger = new StructuredLogger(GenerationService.name);

  constructor(
    private readonly chaptersService: ChaptersService,
    private readonly jobsService: JobsService,
    private readonly generationQueueService: GenerationQueueService,
  ) {}

  async generateChapter(chapterId: string, dto: GenerateChapterDto) {
    const chapter = await this.chaptersService.getById(chapterId);
    const requestId = randomUUID();
    const idempotencyKey = `write_chapter:${chapterId}`;
    const { job, created } = await this.jobsService.createOrReuse({
      projectId: chapter.projectId,
      jobType: 'write_chapter',
      targetType: 'chapter',
      targetId: chapterId,
      requestPayload: {
        ...dto,
        _requestId: requestId,
        _idempotencyKey: idempotencyKey,
        _enqueuedAt: new Date().toISOString(),
      },
    });

    const logContext = {
      requestId,
      jobId: job.id,
      projectId: chapter.projectId,
      chapterId,
      idempotencyKey,
      created,
      existingStatus: created ? undefined : job.status,
    };

    if (!created) {
      if (job.status === 'queued') {
        await this.generationQueueService.enqueue(job.id);
      }

      this.logger.warn('generation.job.reused', logContext);
      return job;
    }

    await this.generationQueueService.enqueue(job.id);
    this.logger.log('generation.job.accepted', {
      ...logContext,
      status: job.status,
    });

    return job;
  }

  /**
   * 触发章节润色 — 直接调用 Worker 的 polish-chapter 端点。
   * 不走队列，同步等待 Worker 返回润色结果。
   */
  async polishChapter(chapterId: string, dto: PolishChapterDto) {
    const chapter = await this.chaptersService.getById(chapterId);
    const workerBaseUrl = process.env.WORKER_BASE_URL ?? 'http://localhost:8000';

    this.logger.log('polish.job.dispatching', {
      chapterId,
      projectId: chapter.projectId,
    });

    const response = await fetch(`${workerBaseUrl}/internal/jobs/polish-chapter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: chapter.projectId,
        chapterId,
        userInstruction: dto.userInstruction,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Worker polish 请求失败: ${response.status} ${errorText.slice(0, 500)}`);
    }

    const result = await response.json();
    this.logger.log('polish.job.completed', {
      chapterId,
      projectId: chapter.projectId,
      polishedWordCount: result.polishedWordCount,
    });

    return result;
  }
}
