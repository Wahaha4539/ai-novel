import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RedisClientType, createClient } from 'redis';
import { StructuredLogger } from '../../common/logging/structured-logger';
import { ChaptersService } from '../chapters/chapters.service';
import { JobsService } from '../jobs/jobs.service';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const sanitizeRedisUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return 'invalid_redis_url';
  }
};

@Injectable()
export class GenerationQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new StructuredLogger(GenerationQueueService.name);
  private readonly concurrency = Math.max(1, Number(process.env.GENERATION_QUEUE_CONCURRENCY ?? 1));
  private readonly redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
  private readonly queueKey = 'generation:jobs:queue';
  private readonly pendingSetKey = 'generation:jobs:pending';
  private readonly workerLoops: Promise<void>[] = [];
  private redisClient: RedisClientType | null = null;
  private shuttingDown = false;

  constructor(
    private readonly jobsService: JobsService,
    private readonly chaptersService: ChaptersService,
  ) {}

  async onModuleInit() {
    await this.getRedisClient();
    const recoveredRunningJobs = await this.jobsService.markInterruptedJobsFailed();
    const queuedJobs = await this.jobsService.listQueuedJobs(50);
    const primedJobs = await this.primeQueuedJobs(queuedJobs.map((job) => job.id));

    this.logger.log('generation.queue.ready', {
      recoveredRunningJobs,
      pendingCount: primedJobs,
      concurrency: this.concurrency,
      backend: 'redis',
      redisUrl: sanitizeRedisUrl(this.redisUrl),
    });

    for (let index = 0; index < this.concurrency; index += 1) {
      this.workerLoops.push(this.runWorker(index + 1));
    }
  }

  async onModuleDestroy() {
    this.shuttingDown = true;

    await Promise.allSettled(this.workerLoops);

    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
  }

  async enqueue(jobId: string) {
    await this.enqueueJob(jobId);
    this.logger.log('generation.job.enqueued', {
      jobId,
      backend: 'redis',
    });
  }

  private async getRedisClient() {
    if (this.redisClient?.isOpen) {
      return this.redisClient;
    }

    if (!this.redisClient) {
      this.redisClient = createClient({
        url: this.redisUrl,
      });

      this.redisClient.on('error', (error) => {
        this.logger.error('generation.queue.redis_error', error, {
          backend: 'redis',
          redisUrl: sanitizeRedisUrl(this.redisUrl),
        });
      });
    }

    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }

    return this.redisClient;
  }

  private async primeQueuedJobs(jobIds: string[]) {
    const redis = await this.getRedisClient();
    await redis.del([this.queueKey, this.pendingSetKey]);

    let primedJobs = 0;
    for (const jobId of jobIds) {
      const enqueued = await this.enqueueJob(jobId);
      if (enqueued) {
        primedJobs += 1;
      }
    }

    return primedJobs;
  }

  private async enqueueJob(jobId: string) {
    const redis = await this.getRedisClient();
    const added = await redis.sAdd(this.pendingSetKey, jobId);
    if (added === 0) {
      this.logger.warn('generation.job.enqueue_skipped', {
        jobId,
        backend: 'redis',
        reason: 'already_pending',
      });
      return false;
    }

    try {
      await redis.rPush(this.queueKey, jobId);
      return true;
    } catch (error) {
      await redis.sRem(this.pendingSetKey, jobId);
      throw error;
    }
  }

  private async popNextJob() {
    const redis = await this.getRedisClient();
    const result = (await redis.sendCommand(['BLPOP', this.queueKey, '1'])) as string[] | null;
    if (!Array.isArray(result) || result.length < 2) {
      return null;
    }

    return result[1];
  }

  private async runWorker(workerIndex: number) {
    while (!this.shuttingDown) {
      try {
        const jobId = await this.popNextJob();
        if (!jobId) {
          continue;
        }

        await this.processJob(jobId, workerIndex);
      } catch (error) {
        if (this.shuttingDown) {
          return;
        }

        this.logger.error('generation.queue.worker_error', error, {
          backend: 'redis',
          workerIndex,
        });
      }
    }
  }

  private async processJob(jobId: string, workerIndex: number) {
    try {
      const job = await this.jobsService.claimQueuedJob(jobId, 'queued in redis for background worker dispatch');
      if (!job) {
        this.logger.warn('generation.job.claim_skipped', {
          jobId,
          backend: 'redis',
          workerIndex,
        });
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
        workerIndex,
        backend: 'redis',
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

        // Worker 接口只确认已接收任务，真正的 completed/failed 由 worker 后台任务回写数据库。
        // 这样 API→worker HTTP 连接中断不会把仍在运行的 worker 任务错误标记为失败。
        this.logger.log('generation.job.dispatched', {
          ...logContext,
          stage: 'dispatched',
        });
      } catch (error) {
        await this.jobsService.markFailed(job.id, error instanceof Error ? error.message : 'unknown_worker_error');
        this.logger.error('generation.job.failed', error, {
          ...logContext,
          stage: 'failed',
        });
      }
    } finally {
      const redis = await this.getRedisClient();
      await redis.sRem(this.pendingSetKey, jobId);
    }
  }
}