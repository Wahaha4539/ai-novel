import { IsIn, IsOptional, IsString } from 'class-validator';
import { PLATFORM_PROFILE_KEYS, SCORING_TARGET_TYPES, PlatformProfileKey, ScoringTargetType } from '../scoring-contracts';

export class ScoringComparisonQueryDto {
  @IsIn(SCORING_TARGET_TYPES)
  targetType!: ScoringTargetType;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsString()
  draftId?: string;

  @IsOptional()
  @IsIn(PLATFORM_PROFILE_KEYS)
  baselineProfileKey?: PlatformProfileKey;
}

export class ScoringTrendQueryDto {
  @IsOptional()
  @IsIn(SCORING_TARGET_TYPES)
  targetType?: ScoringTargetType;

  @IsOptional()
  @IsIn(PLATFORM_PROFILE_KEYS)
  profileKey?: PlatformProfileKey;
}
