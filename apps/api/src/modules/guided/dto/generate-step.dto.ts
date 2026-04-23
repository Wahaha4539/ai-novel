import { IsInt, IsOptional, IsString } from 'class-validator';

export class GenerateStepDto {
  @IsString()
  currentStep!: string;

  /** Optional user instructions/preferences to guide the generation */
  @IsOptional()
  @IsString()
  userHint?: string;

  /** Accumulated project context from prior steps */
  @IsOptional()
  @IsString()
  projectContext?: string;

  /** Summary of the current step's chat conversation (user decisions made during Q&A) */
  @IsOptional()
  @IsString()
  chatSummary?: string;

  /** Target volume number for per-volume chapter generation (guided_chapter step) */
  @IsOptional()
  @IsInt()
  volumeNo?: number;
}

