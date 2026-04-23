import { IsArray, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class ChatMessageDto {
  @IsString()
  role!: 'ai' | 'user';

  @IsString()
  content!: string;
}

export class GuidedChatDto {
  @IsString()
  currentStep!: string;

  @IsString()
  userMessage!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  @IsOptional()
  chatHistory?: ChatMessageDto[];

  @IsOptional()
  @IsString()
  projectContext?: string;
}
