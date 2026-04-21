import { Module } from '@nestjs/common';
import { ChaptersModule } from './modules/chapters/chapters.module';
import { CharactersModule } from './modules/characters/characters.module';
import { GenerationModule } from './modules/generation/generation.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LorebookModule } from './modules/lorebook/lorebook.module';
import { MemoryModule } from './modules/memory/memory.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { ValidationModule } from './modules/validation/validation.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    ProjectsModule,
    ChaptersModule,
    CharactersModule,
    LorebookModule,
    JobsModule,
    GenerationModule,
    ValidationModule,
    MemoryModule,
  ],
})
export class AppModule {}
