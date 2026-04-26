import { IsObject, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateAgentPlanDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @MinLength(2)
  message!: string;

  @IsOptional()
  @IsObject()
  context?: { currentChapterId?: string; [key: string]: unknown };

  @IsOptional()
  attachments?: unknown[];
}

export class ReplanAgentRunDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  message?: string;
}