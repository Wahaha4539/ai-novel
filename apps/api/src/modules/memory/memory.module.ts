import { Module } from '@nestjs/common';
import { GuidedModule } from '../guided/guided.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { MemoryController } from './memory.controller';
import { MemoryReviewService } from './memory-review.service';
import { MemoryRebuildService } from './memory-rebuild.service';
import { MemoryService } from './memory.service';
import { LlmModule } from '../llm/llm.module';
import { MemoryWriterService } from './memory-writer.service';
import { RetrievalService } from './retrieval.service';

@Module({
  imports: [GuidedModule, PrismaModule, LlmModule],
  controllers: [MemoryController],
  providers: [MemoryService, MemoryRebuildService, MemoryReviewService, MemoryWriterService, RetrievalService],
  exports: [MemoryRebuildService, MemoryReviewService, MemoryWriterService, RetrievalService],
})
export class MemoryModule {}
