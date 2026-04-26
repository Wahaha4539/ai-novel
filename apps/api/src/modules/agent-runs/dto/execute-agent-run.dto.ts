import { IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';

class AgentRunConfirmationDto {
  @IsOptional()
  @IsBoolean()
  confirmHighRisk?: boolean;

  @IsOptional()
  @IsArray()
  confirmedRiskIds?: string[];
}

export class ExecuteAgentRunDto {
  @IsBoolean()
  approval!: boolean;

  @IsOptional()
  @IsArray()
  approvedStepNos?: number[];

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @ValidateNested()
  confirmation?: AgentRunConfirmationDto;
}