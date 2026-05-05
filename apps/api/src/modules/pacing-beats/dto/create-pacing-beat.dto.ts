import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreatePacingBeatDto {
  @IsOptional()
  @IsUUID()
  volumeId?: string;

  @IsOptional()
  @IsUUID()
  chapterId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNo?: number;

  @IsString()
  @MaxLength(80)
  beatType!: string;

  @IsOptional()
  @IsString()
  emotionalTone?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  emotionalIntensity?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  tensionLevel?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  payoffLevel?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  metadata?: Record<string, unknown>;
}
