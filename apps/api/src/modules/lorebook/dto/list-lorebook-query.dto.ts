import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ListLorebookQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entryType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  tag?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
