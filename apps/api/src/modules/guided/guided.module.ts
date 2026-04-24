import { Module } from '@nestjs/common';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { GuidedController } from './guided.controller';
import { GuidedService } from './guided.service';
import { LlmService } from './llm.service';

@Module({
  imports: [LlmProvidersModule],
  controllers: [GuidedController],
  providers: [GuidedService, LlmService],
  exports: [GuidedService, LlmService],
})
export class GuidedModule {}
