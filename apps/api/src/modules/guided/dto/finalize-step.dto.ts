import { IsNumber, IsOptional, IsString } from 'class-validator';

export class FinalizeStepDto {
  @IsString()
  currentStep!: string;

  /** JSON-stringified structured data from AI, varies by step */
  @IsOptional()
  structuredData?: Record<string, unknown>;

  /** Optional: save chapters for a specific volume only */
  @IsOptional()
  @IsNumber()
  volumeNo?: number;
}
