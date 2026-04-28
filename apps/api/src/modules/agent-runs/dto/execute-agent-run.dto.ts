import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

class AgentRunConfirmationDto {
  @IsOptional()
  @IsBoolean()
  confirmHighRisk?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
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
  // ValidationPipe 开启 whitelist + transform 时必须显式声明嵌套类型，
  // 否则 confirmation.confirmHighRisk 可能被当作普通对象字段剥离，导致后端反复等待二次确认。
  @Type(() => AgentRunConfirmationDto)
  @ValidateNested()
  confirmation?: AgentRunConfirmationDto;
}