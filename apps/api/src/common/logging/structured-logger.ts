import { Logger } from '@nestjs/common';

type LogPayload = Record<string, unknown>;

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
    this.logger.log(this.stringify('info', event, payload));
  }

  warn(event: string, payload: LogPayload = {}) {
    this.logger.warn(this.stringify('warn', event, payload));
  }

  error(event: string, error: unknown, payload: LogPayload = {}) {
    this.logger.error(
      this.stringify('error', event, {
        ...payload,
        error: serializeError(error),
      }),
    );
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