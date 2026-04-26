import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

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
  @IsInt({ each: true })
  @Min(1, { each: true })
  approvedStepNos?: number[];

  @IsOptional()
  @IsString()
  comment?: string;

  @IsOptional()
  @ValidateNested()
  confirmation?: AgentRunConfirmationDto;
}