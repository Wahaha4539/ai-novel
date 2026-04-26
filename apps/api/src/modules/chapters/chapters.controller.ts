import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
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

  /** Manually mark a chapter as completed without running AI generation. */
  @Patch('chapters/:chapterId/complete')
  markComplete(@Param('chapterId') chapterId: string, @Body() dto: { actualWordCount?: number }) {
    return this.chaptersService.markCompletedManually(chapterId, dto.actualWordCount);
  }

  /** Return the latest (isCurrent) draft for a chapter */
  @Get('chapters/:chapterId/drafts')
  getLatestDraft(@Param('chapterId') chapterId: string) {
    return this.chaptersService.getLatestDraft(chapterId);
  }

  /** Return all draft versions for a chapter */
  @Get('chapters/:chapterId/drafts/all')
  listDrafts(@Param('chapterId') chapterId: string) {
    return this.chaptersService.listDrafts(chapterId);
  }
}
