import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  genre?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  theme?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tone?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  targetWordCount?: number;

  @IsOptional()
  @IsString()
  synopsis?: string;
}
