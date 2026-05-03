import './load-env';
import 'reflect-metadata';
import { execSync } from 'child_process';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from './common/logging/structured-logger';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

/** Kill any stale process occupying the given port (Windows only, dev mode) */
function freePort(port: number): void {
  if (process.platform !== 'win32') return;
  try {
    const out = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const pids = new Set(
      out.split('\n')
        .map((line) => line.trim().split(/\s+/).pop())
        .filter((pid): pid is string => !!pid && /^\d+$/.test(pid) && pid !== '0'),
    );
    for (const pid of pids) {
      // Don't kill ourselves
      if (Number(pid) === process.pid) continue;
      try {
        execSync(`taskkill /F /PID ${pid}`, { timeout: 3000 });
        console.log(`[Bootstrap] Killed stale process PID=${pid} on port ${port}`);
      } catch { /* already dead */ }
    }
  } catch { /* no process found — port is free */ }
}

async function bootstrap() {
  const logger = new StructuredLogger('Bootstrap');
  const port = Number(process.env.API_PORT ?? 3001);
  freePort(port);

  const app = await NestFactory.create(AppModule);
  const prisma = app.get(PrismaService);
  app.enableCors();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  await prisma.enableShutdownHooks(app);

  await app.listen(port);
  logger.log('api.started', {
    port,
    baseUrl: `http://localhost:${port}/api`,
  });
}

bootstrap();
