import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { FactExtractorService } from './fact-extractor.service';

@Module({
  imports: [PrismaModule, LlmModule, MemoryModule],
  providers: [FactExtractorService],
  exports: [FactExtractorService],
})
export class FactsModule {}