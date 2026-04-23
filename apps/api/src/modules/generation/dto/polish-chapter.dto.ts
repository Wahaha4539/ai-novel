import { IsOptional, IsString } from 'class-validator';

/** 章节润色请求 DTO */
export class PolishChapterDto {
  @IsOptional()
  @IsString()
  userInstruction?: string;
}
