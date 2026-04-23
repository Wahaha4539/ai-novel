import { Module } from '@nestjs/common';
import { CacheModule } from './common/cache/cache.module';
import { ChaptersModule } from './modules/chapters/chapters.module';
import { CharactersModule } from './modules/characters/characters.module';
import { GenerationModule } from './modules/generation/generation.module';
import { GuidedModule } from './modules/guided/guided.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LorebookModule } from './modules/lorebook/lorebook.module';
import { MemoryModule } from './modules/memory/memory.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { PromptTemplatesModule } from './modules/prompt-templates/prompt-templates.module';
import { ValidationModule } from './modules/validation/validation.module';
import { VolumesModule } from './modules/volumes/volumes.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    ProjectsModule,
    ChaptersModule,
    CharactersModule,
    VolumesModule,
    LorebookModule,
    JobsModule,
    GenerationModule,
    GuidedModule,
    PromptTemplatesModule,
    ValidationModule,
    MemoryModule,
  ],
})
export class AppModule {}
