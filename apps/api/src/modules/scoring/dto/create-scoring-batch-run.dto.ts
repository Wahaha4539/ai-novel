import { ArrayMinSize, IsArray, IsIn, IsInt, IsObject, IsOptional, IsString, Min, ValidateIf } from 'class-validator';
import { PLATFORM_PROFILE_KEYS, SCORING_TARGET_TYPES, PlatformProfileKey, ScoringTargetType } from '../scoring-contracts';

export class CreateScoringBatchRunDto {
  @IsIn(SCORING_TARGET_TYPES)
  targetType!: ScoringTargetType;

  @IsOptional()
  @IsString()
  targetId?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  targetRef?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  draftId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  draftVersion?: number;

  @IsArray()
  @ArrayMinSize(1)
  @IsIn(PLATFORM_PROFILE_KEYS, { each: true })
  profileKeys!: PlatformProfileKey[];
}
