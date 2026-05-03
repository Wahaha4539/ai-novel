import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class GenerateChapterDto {
  @IsIn(['draft', 'rewrite'])
  mode!: 'draft' | 'rewrite';

  @IsOptional()
  @IsString()
  instruction?: string;

  @IsOptional()
  @IsInt()
  @Min(200)
  wordCount?: number;

  @IsOptional()
  @IsString()
  styleProfileId?: string;

  @IsOptional()
  @IsString()
  modelProfileId?: string;

  @IsOptional()
  @IsBoolean()
  includeLorebook?: boolean;

  @IsOptional()
  @IsBoolean()
  includeMemory?: boolean;

  @IsOptional()
  @IsBoolean()
  validateBeforeWrite?: boolean;

  @IsOptional()
  @IsBoolean()
  validateAfterWrite?: boolean;

  @IsOptional()
  @IsIn(['warning', 'blocker'])
  outlineQualityGate?: 'warning' | 'blocker';

  @IsOptional()
  @IsBoolean()
  stream?: boolean;
}
