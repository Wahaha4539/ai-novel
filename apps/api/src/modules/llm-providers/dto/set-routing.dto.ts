import { IsString, IsOptional, IsUUID, MaxLength } from 'class-validator';

/** DTO for setting a step → provider routing */
export class SetRoutingDto {
  @IsUUID()
  providerId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  modelOverride?: string;

  @IsOptional()
  paramsOverride?: Record<string, unknown>;
}
