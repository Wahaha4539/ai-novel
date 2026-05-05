import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';

export class UpdateSceneDto {
  @IsOptional()
  @IsUUID()
  volumeId?: string | null;

  @IsOptional()
  @IsUUID()
  chapterId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sceneNo?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  locationName?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  participants?: string[];

  @IsOptional()
  @IsString()
  purpose?: string | null;

  @IsOptional()
  @IsString()
  conflict?: string | null;

  @IsOptional()
  @IsString()
  emotionalTone?: string | null;

  @IsOptional()
  @IsString()
  keyInformation?: string | null;

  @IsOptional()
  @IsString()
  result?: string | null;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  relatedForeshadowIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  metadata?: Record<string, unknown>;
}
