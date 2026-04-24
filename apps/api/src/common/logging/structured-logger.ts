import { Logger } from '@nestjs/common';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

type LogPayload = Record<string, unknown>;

const apiLogFile = process.env.API_LOG_FILE ?? join(process.cwd(), 'logs', 'api.log');
const apiErrorLogFile = process.env.API_ERROR_LOG_FILE ?? join(process.cwd(), 'logs', 'api-error.log');

const appendJsonLine = (filePath: string, line: string) => {
  // 文件日志用于本地排查与长期留存；失败时回退到 Nest 控制台日志，避免影响业务流程。
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${line}\n`, { encoding: 'utf8' });
  } catch (error) {
    Logger.warn(`Failed to write api log file ${filePath}: ${String(error)}`, 'StructuredLogger');
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
    appendJsonLine(apiLogFile, line);
    this.logger.log(line);
  }

  warn(event: string, payload: LogPayload = {}) {
    const line = this.stringify('warn', event, payload);
    appendJsonLine(apiLogFile, line);
    this.logger.warn(line);
  }

  error(event: string, error: unknown, payload: LogPayload = {}) {
    const line = this.stringify('error', event, {
      ...payload,
      error: serializeError(error),
    });
    appendJsonLine(apiLogFile, line);
    // 错误日志单独写入 error 文件，便于排查生成/润色/记忆链路失败。
    appendJsonLine(apiErrorLogFile, line);
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