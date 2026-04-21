import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreateChapterDto {
  @IsInt()
  @Min(1)
  chapterNo!: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
  conflict?: string;

  @IsOptional()
  @IsString()
  outline?: string;

  @IsOptional()
  @IsInt()
  @Min(200)
  expectedWordCount?: number;
}
