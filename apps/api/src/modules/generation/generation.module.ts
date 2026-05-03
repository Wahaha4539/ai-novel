import { Module } from '@nestjs/common';
import { FactsModule } from '../facts/facts.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ChaptersModule } from '../chapters/chapters.module';
import { JobsModule } from '../jobs/jobs.module';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { ValidationModule } from '../validation/validation.module';
import { ChapterAutoRepairService } from './chapter-auto-repair.service';
import { GenerateChapterService } from './generate-chapter.service';
import { GenerationController } from './generation.controller';
import { GenerationService } from './generation.service';
import { PolishChapterService } from './polish-chapter.service';
import { PostProcessChapterService } from './postprocess-chapter.service';
import { PromptBuilderService } from './prompt-builder.service';
import { RetrievalPlannerService } from './retrieval-planner.service';

@Module({
  imports: [PrismaModule, ChaptersModule, JobsModule, LlmModule, MemoryModule, FactsModule, ValidationModule],
  providers: [GenerationService, PostProcessChapterService, PolishChapterService, PromptBuilderService, GenerateChapterService, ChapterAutoRepairService, RetrievalPlannerService],
  exports: [PostProcessChapterService, PolishChapterService, PromptBuilderService, GenerateChapterService, ChapterAutoRepairService, RetrievalPlannerService],
  controllers: [GenerationController],
})
export class GenerationModule {}
