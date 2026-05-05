import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';

export class ListPacingBeatsQueryDto {
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
  @MaxLength(80)
  beatType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
