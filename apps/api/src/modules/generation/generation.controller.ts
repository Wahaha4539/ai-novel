import { Body, Controller, Param, Post } from '@nestjs/common';
import { GenerateChapterDto } from './dto/generate-chapter.dto';
import { GenerationService } from './generation.service';

@Controller()
export class GenerationController {
  constructor(private readonly generationService: GenerationService) {}

  @Post('chapters/:chapterId/generate')
  generateChapter(@Param('chapterId') chapterId: string, @Body() dto: GenerateChapterDto) {
    return this.generationService.generateChapter(chapterId, dto);
  }
}
