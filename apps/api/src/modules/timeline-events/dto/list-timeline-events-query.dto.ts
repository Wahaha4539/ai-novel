import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class ListTimelineEventsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  chapterNo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  eventStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  knownBy?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
