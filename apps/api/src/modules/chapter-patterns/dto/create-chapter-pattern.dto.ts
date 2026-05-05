import { IsArray, IsObject, IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class CreateChapterPatternDto {
  @IsString()
  @MaxLength(80)
  patternType!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  applicableScenes?: string[];

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  structure?: Record<string, unknown>;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  pacingAdvice?: Record<string, unknown>;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  emotionalAdvice?: Record<string, unknown>;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  conflictAdvice?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  metadata?: Record<string, unknown>;
}
