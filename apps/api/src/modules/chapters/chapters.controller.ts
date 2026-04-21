import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreateChapterDto } from './dto/create-chapter.dto';
import { ChaptersService } from './chapters.service';

@Controller()
export class ChaptersController {
  constructor(private readonly chaptersService: ChaptersService) {}

  @Post('projects/:projectId/chapters')
  create(@Param('projectId') projectId: string, @Body() dto: CreateChapterDto) {
    return this.chaptersService.create(projectId, dto);
  }

  @Get('projects/:projectId/chapters')
  list(@Param('projectId') projectId: string) {
    return this.chaptersService.listByProject(projectId);
  }

  @Get('chapters/:chapterId')
  getDetail(@Param('chapterId') chapterId: string) {
    return this.chaptersService.getById(chapterId);
  }
}
