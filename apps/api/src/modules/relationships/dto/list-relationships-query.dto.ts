import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ListRelationshipsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  characterName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
