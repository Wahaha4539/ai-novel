import { IsString, MinLength } from 'class-validator';

/** 聊天消息意图判定请求：只包含用户最新回复，由后端补齐 Run/Plan 上下文。 */
export class InterpretAgentMessageDto {
  @IsString()
  @MinLength(1)
  message!: string;
}