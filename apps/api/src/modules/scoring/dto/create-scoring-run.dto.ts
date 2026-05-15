import { IsIn, IsInt, IsObject, IsOptional, IsString, Min, ValidateIf } from 'class-validator';
import { PLATFORM_PROFILE_KEYS, SCORING_TARGET_TYPES, PlatformProfileKey, ScoringTargetType } from '../scoring-contracts';

export class CreateScoringRunDto {
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

  @IsIn(PLATFORM_PROFILE_KEYS)
  profileKey!: PlatformProfileKey;
}
