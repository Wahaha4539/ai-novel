import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export const WRITING_RULE_SEVERITIES = ['info', 'warning', 'error'] as const;

export class CreateWritingRuleDto {
  @IsString()
  @MaxLength(80)
  ruleType!: string;

  @IsString()
  @MaxLength(255)
  title!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  @IsIn(WRITING_RULE_SEVERITIES)
  severity?: 'info' | 'warning' | 'error';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  appliesFromChapterNo?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  appliesToChapterNo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
