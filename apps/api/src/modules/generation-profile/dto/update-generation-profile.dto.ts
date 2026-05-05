import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, Min, ValidateIf } from 'class-validator';

export class UpdateGenerationProfileDto {
  @IsOptional()
  @IsInt()
  @Min(200)
  defaultChapterWordCount?: number | null;

  @IsOptional()
  @IsBoolean()
  autoContinue?: boolean | null;

  @IsOptional()
  @IsBoolean()
  autoSummarize?: boolean | null;

  @IsOptional()
  @IsBoolean()
  autoUpdateCharacterState?: boolean | null;

  @IsOptional()
  @IsBoolean()
  autoUpdateTimeline?: boolean | null;

  @IsOptional()
  @IsBoolean()
  autoValidation?: boolean | null;

  @IsOptional()
  @IsBoolean()
  allowNewCharacters?: boolean | null;

  @IsOptional()
  @IsBoolean()
  allowNewLocations?: boolean | null;

  @IsOptional()
  @IsBoolean()
  allowNewForeshadows?: boolean | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  preGenerationChecks?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  promptBudget?: Record<string, unknown>;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  metadata?: Record<string, unknown>;
}
