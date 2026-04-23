import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateGuidedSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  currentStep?: string;
}
