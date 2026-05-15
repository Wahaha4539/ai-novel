import { IsIn, IsOptional, IsString } from 'class-validator';
import { PLATFORM_PROFILE_KEYS, SCORING_TARGET_TYPES, PlatformProfileKey, ScoringTargetType } from '../scoring-contracts';

export class ListScoringRunsQueryDto {
  @IsOptional()
  @IsIn(SCORING_TARGET_TYPES)
  targetType?: ScoringTargetType;

  @IsOptional()
  @IsString()
  targetId?: string;

  @IsOptional()
  @IsIn(PLATFORM_PROFILE_KEYS)
  profileKey?: PlatformProfileKey;

  @IsOptional()
  @IsString()
  chapterId?: string;

  @IsOptional()
  @IsString()
  draftId?: string;
}
