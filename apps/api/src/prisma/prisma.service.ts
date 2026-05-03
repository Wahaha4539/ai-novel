import { INestApplication, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const DATABASE_STARTUP_RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000] as const;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function maskSensitiveQueryParam(key: string, value: string): string {
  const normalizedKey = key.toLowerCase();
  return /password|secret|token|key/.test(normalizedKey) ? '***' : value;
}

function getDatabaseConnectionSummary(databaseUrl = process.env.DATABASE_URL): string {
  if (!databaseUrl) return 'DATABASE_URL=<未设置>';

  try {
    const url = new URL(databaseUrl);
    const databaseName = decodeURIComponent(url.pathname.replace(/^\//, '')) || '<空>';
    const query = Array.from(url.searchParams.entries())
      .map(([key, value]) => `${key}=${maskSensitiveQueryParam(key, value)}`)
      .join('&') || '<无>';

    // 只输出定位连接问题需要的信息，避免把用户名、密码写入日志。
    return `host=${url.hostname || '<空>'}, port=${url.port || '5432(默认)'}, database=${databaseName}, query=${query}`;
  } catch (error) {
    return `DATABASE_URL=<格式无效：${getErrorMessage(error)}>`;
  }
}

/**
 * Shared Prisma client for the API runtime.
 *
 * Connects during Nest startup and retries short-lived database/proxy outages before
 * dependent modules run their own initialization queries.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  /** Opens the Prisma connection pool before other modules query the database. */
  async onModuleInit() {
    this.logger.log(`数据库连接配置：${getDatabaseConnectionSummary()}`);
    await this.connectWithStartupRetry();
  }

  /** Registers a Nest shutdown hook so Prisma connections close with the application. */
  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }

  /**
   * Attempts a bounded startup connection with backoff.
   *
   * Side effects: opens Prisma's connection pool and logs retry warnings without
   * exposing the DATABASE_URL password.
   */
  private async connectWithStartupRetry(): Promise<void> {
    const maxAttempts = DATABASE_STARTUP_RETRY_DELAYS_MS.length + 1;
    let lastError: unknown = new Error('数据库连接失败');

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.$connect();
        if (attempt > 1) this.logger.log(`数据库连接成功，第 ${attempt}/${maxAttempts} 次尝试。`);
        return;
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;

        const delayMs = DATABASE_STARTUP_RETRY_DELAYS_MS[attempt - 1];
        // 远程 PostgreSQL 或本机代理偶发抖动时，立即失败会中断整个 Nest 启动流程。
        this.logger.warn(`数据库连接失败，第 ${attempt}/${maxAttempts} 次：${getErrorMessage(error)}。${delayMs}ms 后重试。`);
        await delay(delayMs);
      }
    }

    throw lastError;
  }
}
