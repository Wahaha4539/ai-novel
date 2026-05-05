import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const QUALITY_REPORT_SOURCE_TYPES = ['generation', 'validation', 'ai_review', 'auto_repair', 'manual'] as const;
export const QUALITY_REPORT_VERDICTS = ['pass', 'warn', 'fail'] as const;

export class ListQualityReportsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  chapterId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  draftId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  agentRunId?: string;

  @IsOptional()
  @IsIn(QUALITY_REPORT_SOURCE_TYPES)
  sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reportType?: string;

  @IsOptional()
  @IsIn(QUALITY_REPORT_VERDICTS)
  verdict?: string;
}
