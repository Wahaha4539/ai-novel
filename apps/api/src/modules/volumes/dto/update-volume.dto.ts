import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class UpdateVolumeDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  volumeNo?: number;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string;

  @IsOptional()
  @IsString()
  synopsis?: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  chapterCount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}
