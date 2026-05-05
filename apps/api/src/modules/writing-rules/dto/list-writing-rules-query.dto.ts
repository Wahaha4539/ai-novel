import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { WRITING_RULE_SEVERITIES } from './create-writing-rule.dto';

export class ListWritingRulesQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  ruleType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @IsIn(WRITING_RULE_SEVERITIES)
  severity?: 'info' | 'warning' | 'error';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNo?: number;

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
  @MaxLength(200)
  q?: string;
}
