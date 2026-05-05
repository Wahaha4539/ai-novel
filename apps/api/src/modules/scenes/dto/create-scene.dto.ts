import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min, ValidateIf } from 'class-validator';

export class CreateSceneDto {
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
  sceneNo?: number;

  @IsString()
  @MaxLength(255)
  title!: string;

  @IsOptional()
  @IsString()
  locationName?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @IsString({ each: true })
  participants?: string[];

  @IsOptional()
  @IsString()
  purpose?: string;

  @IsOptional()
  @IsString()
  conflict?: string;

  @IsOptional()
  @IsString()
  emotionalTone?: string;

  @IsOptional()
  @IsString()
  keyInformation?: string;

  @IsOptional()
  @IsString()
  result?: string;

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
