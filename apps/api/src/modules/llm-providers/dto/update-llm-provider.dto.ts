import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

/** DTO for updating an existing LLM Provider (all fields optional) */
export class UpdateLlmProviderDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  baseUrl?: string;

  @IsOptional()
  @IsString()
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  defaultModel?: string;

  @IsOptional()
  extraConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
