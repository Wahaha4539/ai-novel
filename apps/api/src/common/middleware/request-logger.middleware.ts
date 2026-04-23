import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  use(req: any, res: any, next: () => void): void {
    const start = Date.now();
    const body = req.body && Object.keys(req.body).length > 0
      ? JSON.stringify(req.body)
      : '';

    res.on('finish', () => {
      const ms = Date.now() - start;
      const status = res.statusCode;
      const size = res.get?.('content-length') ?? '-';
      const line = `[HTTP] ${req.method} ${req.originalUrl} ${status} ${ms}ms ${size}b`;
      if (body) {
        const truncated = body.length > 200 ? body.slice(0, 200) + '…' : body;
        console.log(`${line} body=${truncated}`);
      } else {
        console.log(line);
      }
    });

    next();
  }
}
