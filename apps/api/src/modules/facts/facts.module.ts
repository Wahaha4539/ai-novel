import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { LlmModule } from '../llm/llm.module';
import { FactExtractorService } from './fact-extractor.service';

@Module({
  imports: [PrismaModule, LlmModule],
  providers: [FactExtractorService],
  exports: [FactExtractorService],
})
export class FactsModule {}