import { IsArray, IsIn, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';
import { QUALITY_REPORT_SOURCE_TYPES, QUALITY_REPORT_VERDICTS } from './list-quality-reports-query.dto';

export class CreateQualityReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  chapterId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  draftId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  agentRunId?: string | null;

  @IsIn(QUALITY_REPORT_SOURCE_TYPES)
  sourceType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  sourceId?: string | null;

  @IsString()
  @MaxLength(80)
  reportType!: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  scores?: Record<string, unknown>;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  issues?: unknown[];

  @IsIn(QUALITY_REPORT_VERDICTS)
  verdict!: string;

  @IsOptional()
  @IsString()
  summary?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  metadata?: Record<string, unknown>;
}
