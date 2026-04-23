import { IsBoolean, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateGuidedStepDto {
  @IsString()
  @MaxLength(50)
  currentStep!: string;

  @IsOptional()
  @IsObject()
  stepData?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;
}
