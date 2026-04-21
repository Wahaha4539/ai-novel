import { Injectable, OnModuleInit } from '@nestjs/common';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { ChaptersService } from '../chapters/chapters.service';
import { JobsService } from '../jobs/jobs.service';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

@Injectable()
export class GenerationQueueService implements OnModuleInit {
  private readonly logger = new StructuredLogger(GenerationQueueService.name);
  private readonly pendingJobIds = new Set<string>();
  private readonly inFlightJobIds = new Set<string>();
  private readonly concurrency = Math.max(1, Number(process.env.GENERATION_QUEUE_CONCURRENCY ?? 1));
  private drainScheduled = false;

  constructor(
    private readonly jobsService: JobsService,
    private readonly chaptersService: ChaptersService,
  ) {}

  async onModuleInit() {
    const recoveredRunningJobs = await this.jobsService.markInterruptedJobsFailed();
    const queuedJobs = await this.jobsService.listQueuedJobs(50);
    queuedJobs.forEach((job) => this.pendingJobIds.add(job.id));

    this.logger.log('generation.queue.ready', {
      recoveredRunningJobs,
      pendingCount: this.pendingJobIds.size,
      concurrency: this.concurrency,
    });

    this.scheduleDrain();
  }

  enqueue(jobId: string) {
    this.pendingJobIds.add(jobId);
    this.logger.log('generation.job.enqueued', {
      jobId,
      pendingCount: this.pendingJobIds.size,
    });
    this.scheduleDrain();
  }

  private scheduleDrain() {
    if (this.drainScheduled) {
      return;
    }

    this.drainScheduled = true;
    setImmediate(() => {
      this.drainScheduled = false;
      void this.drain();
    });
  }

  private async drain() {
    while (this.pendingJobIds.size > 0 && this.inFlightJobIds.size < this.concurrency) {
      const nextJobId = this.pendingJobIds.values().next().value as string | undefined;
      if (!nextJobId) {
        return;
      }

      this.pendingJobIds.delete(nextJobId);
      this.inFlightJobIds.add(nextJobId);

      void this.processJob(nextJobId).finally(() => {
        this.inFlightJobIds.delete(nextJobId);
        if (this.pendingJobIds.size > 0) {
          this.scheduleDrain();
        }
      });
    }
  }

  private async processJob(jobId: string) {
    const job = await this.jobsService.claimQueuedJob(jobId, 'queued for background worker dispatch');
    if (!job) {
      this.logger.warn('generation.job.claim_skipped', { jobId });
      return;
    }

    const workerBaseUrl = process.env.WORKER_BASE_URL;
    const requestPayload = asRecord(job.requestPayload);
    const requestId = typeof requestPayload._requestId === 'string' ? requestPayload._requestId : undefined;
    const logContext = {
      requestId,
      jobId: job.id,
      projectId: job.projectId,
      chapterId: job.chapterId,
      targetId: job.targetId,
      jobType: job.jobType,
      targetType: job.targetType,
    };

    if (!workerBaseUrl) {
      const error = new Error('missing_worker_base_url');
      await this.jobsService.markFailed(job.id, error.message);
      this.logger.error('generation.job.failed', error, logContext);
      return;
    }

    try {
      this.logger.log('generation.job.dispatching', {
        ...logContext,
        stage: 'dispatch',
      });

      const response = await fetch(`${workerBaseUrl}/internal/jobs/generate-chapter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requestId,
          jobId: job.id,
          projectId: job.projectId,
          chapterId: job.chapterId ?? job.targetId,
          requestPayload,
        }),
      });

      if (!response.ok) {
        const responseText = await response.text();
        throw new Error(`worker 请求失败: ${response.status} ${responseText.slice(0, 1000)}`);
      }

      const result = (await response.json()) as {
        draftId: string;
        summary: string;
        retrievalPayload?: Record<string, unknown>;
        actualWordCount?: number;
      };

      if (result.draftId && job.chapterId) {
        await this.chaptersService.markDrafted(job.chapterId, result.actualWordCount ?? 0);
      }

      await this.jobsService.markCompleted(
        job.id,
        {
          draftId: result.draftId,
          summary: result.summary,
          actualWordCount: result.actualWordCount ?? null,
        },
        result.retrievalPayload ?? {},
      );

      this.logger.log('generation.job.completed', {
        ...logContext,
        stage: 'completed',
        draftId: result.draftId || null,
        actualWordCount: result.actualWordCount ?? null,
      });
    } catch (error) {
      await this.jobsService.markFailed(job.id, error instanceof Error ? error.message : 'unknown_worker_error');
      this.logger.error('generation.job.failed', error, {
        ...logContext,
        stage: 'failed',
      });
    }
  }
}