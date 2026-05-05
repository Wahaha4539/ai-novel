import { IsArray, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateCreativeProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  audienceType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  platformTarget?: string | null;

  @IsOptional()
  @IsArray()
  sellingPoints?: string[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  pacingPreference?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetWordCount?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  chapterWordCount?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  contentRating?: string | null;

  @IsOptional()
  @IsObject()
  centralConflict?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  generationDefaults?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  validationDefaults?: Record<string, unknown>;
}
