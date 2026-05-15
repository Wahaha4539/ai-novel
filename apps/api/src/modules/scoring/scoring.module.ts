import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { ScoringController } from './scoring.controller';
import { ScoringService } from './scoring.service';
import { ScoringTargetLoaderService } from './scoring-target-loader.service';

@Module({
  imports: [PrismaModule, LlmModule],
  controllers: [ScoringController],
  providers: [ScoringService, ScoringTargetLoaderService],
  exports: [ScoringService, ScoringTargetLoaderService],
})
export class ScoringModule {}
