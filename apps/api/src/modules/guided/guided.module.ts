import { Module } from '@nestjs/common';
import { GuidedController } from './guided.controller';
import { GuidedService } from './guided.service';
import { LlmService } from './llm.service';

@Module({
  controllers: [GuidedController],
  providers: [GuidedService, LlmService],
  exports: [GuidedService],
})
export class GuidedModule {}
