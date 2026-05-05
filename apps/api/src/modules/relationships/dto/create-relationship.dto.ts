import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class CreateRelationshipDto {
  @IsOptional()
  @IsUUID()
  characterAId?: string;

  @IsOptional()
  @IsUUID()
  characterBId?: string;

  @IsString()
  @MaxLength(100)
  characterAName!: string;

  @IsString()
  @MaxLength(100)
  characterBName!: string;

  @IsString()
  @MaxLength(80)
  relationType!: string;

  @IsOptional()
  @IsString()
  publicState?: string;

  @IsOptional()
  @IsString()
  hiddenState?: string;

  @IsOptional()
  @IsString()
  conflictPoint?: string;

  @IsOptional()
  @IsString()
  emotionalArc?: string;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  turnChapterNos?: number[];

  @IsOptional()
  @IsString()
  finalState?: string;

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
