import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

export class DeleteChaptersDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  chapterIds!: string[];
}
