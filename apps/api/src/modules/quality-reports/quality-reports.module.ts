import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { AiQualityReviewService } from './ai-quality-review.service';
import { QualityReportsController } from './quality-reports.controller';
import { QualityReportsService } from './quality-reports.service';

@Module({
  imports: [LlmModule],
  controllers: [QualityReportsController],
  providers: [QualityReportsService, AiQualityReviewService],
  exports: [QualityReportsService, AiQualityReviewService],
})
export class QualityReportsModule {}
