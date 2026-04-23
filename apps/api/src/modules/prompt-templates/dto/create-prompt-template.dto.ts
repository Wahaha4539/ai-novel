import { IsArray, IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class CreatePromptTemplateDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsString()
  @MaxLength(50)
  stepKey!: string;

  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsString()
  systemPrompt!: string;

  @IsString()
  userTemplate!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsString()
  effectPreview?: string;
}
