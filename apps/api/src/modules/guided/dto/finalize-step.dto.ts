import { IsOptional, IsString } from 'class-validator';

export class FinalizeStepDto {
  @IsString()
  currentStep!: string;

  /** JSON-stringified structured data from AI, varies by step */
  @IsOptional()
  structuredData?: Record<string, unknown>;
}
