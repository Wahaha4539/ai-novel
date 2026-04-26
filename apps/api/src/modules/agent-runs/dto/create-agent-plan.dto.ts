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

  /**
   * 调用方生成的幂等键；同一项目内重复提交同一个键时复用已有 AgentRun，
   * 避免前端超时重试导致重复规划和重复消耗 LLM 配额。
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  clientRequestId?: string;
}

export class ReplanAgentRunDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  message?: string;
}