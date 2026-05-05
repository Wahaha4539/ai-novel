import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListChapterPatternsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  patternType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
