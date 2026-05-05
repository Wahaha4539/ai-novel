import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ChapterPatternsService } from './chapter-patterns.service';
import { CreateChapterPatternDto } from './dto/create-chapter-pattern.dto';
import { ListChapterPatternsQueryDto } from './dto/list-chapter-patterns-query.dto';
import { UpdateChapterPatternDto } from './dto/update-chapter-pattern.dto';

@Controller()
export class ChapterPatternsController {
  constructor(private readonly chapterPatternsService: ChapterPatternsService) {}

  @Post('projects/:projectId/chapter-patterns')
  create(@Param('projectId') projectId: string, @Body() dto: CreateChapterPatternDto) {
    return this.chapterPatternsService.create(projectId, dto);
  }

  @Get('projects/:projectId/chapter-patterns')
  list(@Param('projectId') projectId: string, @Query() query: ListChapterPatternsQueryDto) {
    return this.chapterPatternsService.list(projectId, query);
  }

  @Patch('projects/:projectId/chapter-patterns/:patternId')
  update(
    @Param('projectId') projectId: string,
    @Param('patternId') patternId: string,
    @Body() dto: UpdateChapterPatternDto,
  ) {
    return this.chapterPatternsService.update(projectId, patternId, dto);
  }

  @Delete('projects/:projectId/chapter-patterns/:patternId')
  remove(@Param('projectId') projectId: string, @Param('patternId') patternId: string) {
    return this.chapterPatternsService.remove(projectId, patternId);
  }
}
