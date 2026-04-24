import { Logger } from '@nestjs/common';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

type LogPayload = Record<string, unknown>;

const apiLogFile = process.env.API_LOG_FILE ?? join(process.cwd(), 'logs', 'api.log');

const appendJsonLine = (line: string) => {
  // 文件日志用于本地排查与长期留存；失败时回退到 Nest 控制台日志，避免影响业务流程。
  try {
    mkdirSync(dirname(apiLogFile), { recursive: true });
    appendFileSync(apiLogFile, `${line}\n`, { encoding: 'utf8' });
  } catch (error) {
    Logger.warn(`Failed to write api log file: ${String(error)}`, 'StructuredLogger');
  }
};

const serializeError = (error: unknown) => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }

  return error;
};

export class StructuredLogger {
  private readonly logger: Logger;

  constructor(
    private readonly component: string,
    private readonly service = 'api',
  ) {
    this.logger = new Logger(component);
  }

  log(event: string, payload: LogPayload = {}) {
    const line = this.stringify('info', event, payload);
    appendJsonLine(line);
    this.logger.log(line);
  }

  warn(event: string, payload: LogPayload = {}) {
    const line = this.stringify('warn', event, payload);
    appendJsonLine(line);
    this.logger.warn(line);
  }

  error(event: string, error: unknown, payload: LogPayload = {}) {
    const line = this.stringify('error', event, {
      ...payload,
      error: serializeError(error),
    });
    appendJsonLine(line);
    this.logger.error(line);
  }

  private stringify(level: 'info' | 'warn' | 'error', event: string, payload: LogPayload) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      service: this.service,
      component: this.component,
      level,
      event,
      ...payload,
    });
  }
}