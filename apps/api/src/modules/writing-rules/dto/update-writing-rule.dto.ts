import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { WRITING_RULE_SEVERITIES } from './create-writing-rule.dto';

export class UpdateWritingRuleDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ruleType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  @IsIn(WRITING_RULE_SEVERITIES)
  severity?: 'info' | 'warning' | 'error';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  appliesFromChapterNo?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  appliesToChapterNo?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityRef?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
