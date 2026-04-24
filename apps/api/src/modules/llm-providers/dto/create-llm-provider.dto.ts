import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

/** DTO for creating a new LLM Provider */
export class CreateLlmProviderDto {
  @IsString()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  providerType?: string;

  @IsString()
  @MaxLength(500)
  baseUrl!: string;

  @IsString()
  apiKey!: string;

  @IsString()
  @MaxLength(200)
  defaultModel!: string;

  @IsOptional()
  extraConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
