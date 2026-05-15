import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { CacheModule } from './common/cache/cache.module';
import { RequestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { AgentRunsModule } from './modules/agent-runs/agent-runs.module';
import { ChaptersModule } from './modules/chapters/chapters.module';
import { ChapterPatternsModule } from './modules/chapter-patterns/chapter-patterns.module';
import { CharactersModule } from './modules/characters/characters.module';
import { GenerationProfileModule } from './modules/generation-profile/generation-profile.module';
import { GenerationModule } from './modules/generation/generation.module';
import { GuidedModule } from './modules/guided/guided.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LlmProvidersModule } from './modules/llm-providers/llm-providers.module';
import { LlmModule } from './modules/llm/llm.module';
import { LorebookModule } from './modules/lorebook/lorebook.module';
import { MemoryModule } from './modules/memory/memory.module';
import { PacingBeatsModule } from './modules/pacing-beats/pacing-beats.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { PromptTemplatesModule } from './modules/prompt-templates/prompt-templates.module';
import { QualityReportsModule } from './modules/quality-reports/quality-reports.module';
import { RelationshipsModule } from './modules/relationships/relationships.module';
import { ScenesModule } from './modules/scenes/scenes.module';
import { ScoringModule } from './modules/scoring/scoring.module';
import { TimelineEventsModule } from './modules/timeline-events/timeline-events.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { ValidationModule } from './modules/validation/validation.module';
import { VolumesModule } from './modules/volumes/volumes.module';
import { WritingRulesModule } from './modules/writing-rules/writing-rules.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    CacheModule,
    AgentRunsModule,
    ProjectsModule,
    ChaptersModule,
    ChapterPatternsModule,
    CharactersModule,
    GenerationProfileModule,
    VolumesModule,
    LorebookModule,
    JobsModule,
    GenerationModule,
    GuidedModule,
    LlmProvidersModule,
    LlmModule,
    PromptTemplatesModule,
    QualityReportsModule,
    WritingRulesModule,
    RelationshipsModule,
    ScenesModule,
    ScoringModule,
    PacingBeatsModule,
    TimelineEventsModule,
    UploadsModule,
    ValidationModule,
    MemoryModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
