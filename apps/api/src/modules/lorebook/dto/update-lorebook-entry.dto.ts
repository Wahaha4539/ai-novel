import { IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ALLOWED_LOREBOOK_ENTRY_TYPES } from '../lorebook-entry-types';

export class UpdateLorebookEntryDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @IsIn(ALLOWED_LOREBOOK_ENTRY_TYPES)
  entryType?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @IsOptional()
  @IsArray()
  triggerKeywords?: string[];

  @IsOptional()
  @IsArray()
  relatedEntityIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
