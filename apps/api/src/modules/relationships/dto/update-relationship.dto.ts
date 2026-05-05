import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class UpdateRelationshipDto {
  @IsOptional()
  @IsUUID()
  characterAId?: string | null;

  @IsOptional()
  @IsUUID()
  characterBId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  characterAName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  characterBName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  relationType?: string;

  @IsOptional()
  @IsString()
  publicState?: string | null;

  @IsOptional()
  @IsString()
  hiddenState?: string | null;

  @IsOptional()
  @IsString()
  conflictPoint?: string | null;

  @IsOptional()
  @IsString()
  emotionalArc?: string | null;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  turnChapterNos?: number[];

  @IsOptional()
  @IsString()
  finalState?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  sourceType?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
