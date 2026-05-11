import { IsString } from 'class-validator';

export class UpdateChapterDraftDto {
  @IsString()
  content!: string;
}
