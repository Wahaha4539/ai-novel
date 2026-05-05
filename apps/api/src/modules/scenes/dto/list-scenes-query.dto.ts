import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class ListScenesQueryDto {
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

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
