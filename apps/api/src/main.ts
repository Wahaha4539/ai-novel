import 'dotenv/config';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { StructuredLogger } from './common/logging/structured-logger';
import { AppModule } from './app.module';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const logger = new StructuredLogger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const prisma = app.get(PrismaService);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  await prisma.enableShutdownHooks(app);

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port);
  logger.log('api.started', {
    port,
    baseUrl: `http://localhost:${port}/api`,
  });
}

bootstrap();
