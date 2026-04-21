import { Module } from '@nestjs/common';
import { ChaptersModule } from '../chapters/chapters.module';
import { JobsModule } from '../jobs/jobs.module';
import { GenerationController } from './generation.controller';
import { GenerationQueueService } from './generation-queue.service';
import { GenerationService } from './generation.service';

@Module({
  imports: [ChaptersModule, JobsModule],
  controllers: [GenerationController],
  providers: [GenerationService, GenerationQueueService],
})
export class GenerationModule {}
