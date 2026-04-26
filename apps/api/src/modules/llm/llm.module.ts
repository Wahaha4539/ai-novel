import { Module } from '@nestjs/common';
import { LlmProvidersModule } from '../llm-providers/llm-providers.module';
import { EmbeddingGatewayService } from './embedding-gateway.service';
import { LlmGatewayService } from './llm-gateway.service';

@Module({ imports: [LlmProvidersModule], providers: [LlmGatewayService, EmbeddingGatewayService], exports: [LlmGatewayService, EmbeddingGatewayService] })
export class LlmModule {}