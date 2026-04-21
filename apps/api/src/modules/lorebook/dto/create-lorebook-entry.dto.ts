import { IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateLorebookEntryDto {
  @IsString()
  @MaxLength(255)
  title!: string;

  @IsString()
  @MaxLength(50)
  entryType!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  summary?: string;

  @IsOptional()
  @IsArray()
  tags?: string[];
}
