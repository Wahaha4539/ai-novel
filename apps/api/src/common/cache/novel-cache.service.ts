import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { RedisClientType, createClient } from 'redis';
import { StructuredLogger } from '../logging/structured-logger';

type JsonValue = Record<string, unknown> | Array<unknown>;

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
export class NovelCacheService implements OnModuleDestroy {
  private readonly logger = new StructuredLogger(NovelCacheService.name);
  private readonly redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0';
  private readonly projectSnapshotTtlSeconds = Math.max(
    1,
    Number(process.env.CACHE_PROJECT_SNAPSHOT_TTL_SECONDS ?? 300),
  );
  private readonly chapterContextTtlSeconds = Math.max(
    1,
    Number(process.env.CACHE_CHAPTER_CONTEXT_TTL_SECONDS ?? 300),
  );
  private readonly recallResultTtlSeconds = Math.max(
    1,
    Number(process.env.CACHE_RECALL_RESULT_TTL_SECONDS ?? 120),
  );
  private redisClient: RedisClientType | null = null;

  async onModuleDestroy() {
    if (this.redisClient?.isOpen) {
      await this.redisClient.quit();
    }
  }

  async setProjectSnapshot(projectId: string, snapshot: Record<string, unknown>) {
    await this.setJson(this.projectSnapshotKey(projectId), snapshot, this.projectSnapshotTtlSeconds);
    this.logger.log('cache.project_snapshot.updated', {
      projectId,
      ttlSeconds: this.projectSnapshotTtlSeconds,
    });
  }

  async deleteProjectSnapshot(projectId: string) {
    await this.deleteKeys([this.projectSnapshotKey(projectId)]);
    this.logger.log('cache.project_snapshot.invalidated', { projectId });
  }

  async setChapterContext(projectId: string, chapterId: string, context: Record<string, unknown>) {
    await this.setJson(this.chapterContextKey(projectId, chapterId), context, this.chapterContextTtlSeconds);
    this.logger.log('cache.chapter_context.updated', {
      projectId,
      chapterId,
      ttlSeconds: this.chapterContextTtlSeconds,
    });
  }

  async deleteChapterContext(projectId: string, chapterId: string) {
    await this.deleteKeys([this.chapterContextKey(projectId, chapterId)]);
    this.logger.log('cache.chapter_context.invalidated', { projectId, chapterId });
  }

  async deleteProjectChapterContexts(projectId: string) {
    const deleted = await this.deleteByPattern(this.chapterContextPattern(projectId));
    this.logger.log('cache.chapter_context.project_invalidated', {
      projectId,
      deletedKeys: deleted,
    });
  }

  async deleteProjectRecallResults(projectId: string) {
    const deleted = await this.deleteByPattern(this.recallResultPattern(projectId));
    this.logger.log('cache.recall_result.project_invalidated', {
      projectId,
      deletedKeys: deleted,
      ttlSeconds: this.recallResultTtlSeconds,
    });
  }

  private projectSnapshotKey(projectId: string) {
    return `ai_novel:project:${projectId}:snapshot`;
  }

  private chapterContextKey(projectId: string, chapterId: string) {
    return `ai_novel:project:${projectId}:chapter:${chapterId}:context`;
  }

  private chapterContextPattern(projectId: string) {
    return `ai_novel:project:${projectId}:chapter:*:context`;
  }

  private recallResultPattern(projectId: string) {
    return `ai_novel:project:${projectId}:recall:*`;
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
        this.logger.error('cache.redis_error', error, {
          redisUrl: sanitizeRedisUrl(this.redisUrl),
        });
      });
    }

    if (!this.redisClient.isOpen) {
      await this.redisClient.connect();
    }

    return this.redisClient;
  }

  private async setJson(key: string, value: JsonValue | Record<string, unknown>, ttlSeconds: number) {
    const redis = await this.getRedisClient();
    await redis.set(key, JSON.stringify(value), {
      EX: ttlSeconds,
    });
  }

  private async deleteKeys(keys: string[]) {
    if (keys.length === 0) {
      return;
    }

    const redis = await this.getRedisClient();
    await redis.del(keys);
  }

  private async deleteByPattern(pattern: string) {
    const redis = await this.getRedisClient();
    const pendingBatch: string[] = [];
    let deleted = 0;

    for await (const key of redis.scanIterator({
      MATCH: pattern,
      COUNT: 100,
    })) {
      pendingBatch.push(String(key));
      if (pendingBatch.length >= 100) {
        deleted += await redis.del(pendingBatch);
        pendingBatch.length = 0;
      }
    }

    if (pendingBatch.length > 0) {
      deleted += await redis.del(pendingBatch);
    }

    return deleted;
  }
}