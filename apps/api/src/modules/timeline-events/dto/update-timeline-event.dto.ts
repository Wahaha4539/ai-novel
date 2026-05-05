import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class UpdateTimelineEventDto {
  @IsOptional()
  @IsUUID()
  chapterId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNo?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  eventTime?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  locationName?: string | null;

  @IsOptional()
  @IsArray()
  participants?: string[];

  @IsOptional()
  @IsString()
  cause?: string | null;

  @IsOptional()
  @IsString()
  result?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  impactScope?: string | null;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsArray()
  knownBy?: string[];

  @IsOptional()
  @IsArray()
  unknownBy?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  eventStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
