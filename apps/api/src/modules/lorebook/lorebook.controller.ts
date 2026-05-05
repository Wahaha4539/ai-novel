import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateLorebookEntryDto } from './dto/create-lorebook-entry.dto';
import { ListLorebookQueryDto } from './dto/list-lorebook-query.dto';
import { UpdateLorebookEntryDto } from './dto/update-lorebook-entry.dto';
import { LorebookService } from './lorebook.service';

@Controller()
export class LorebookController {
  constructor(private readonly lorebookService: LorebookService) {}

  @Post('projects/:projectId/lorebook')
  create(@Param('projectId') projectId: string, @Body() dto: CreateLorebookEntryDto) {
    return this.lorebookService.create(projectId, dto);
  }

  @Get('projects/:projectId/lorebook')
  list(@Param('projectId') projectId: string, @Query() query: ListLorebookQueryDto) {
    return this.lorebookService.list(projectId, query);
  }

  @Get('projects/:projectId/lorebook/search')
  search(@Param('projectId') projectId: string, @Query('q') q?: string) {
    return this.lorebookService.list(projectId, { q });
  }

  @Patch('projects/:projectId/lorebook/:entryId')
  update(@Param('projectId') projectId: string, @Param('entryId') entryId: string, @Body() dto: UpdateLorebookEntryDto) {
    return this.lorebookService.update(projectId, entryId, dto);
  }

  @Delete('projects/:projectId/lorebook/:entryId')
  remove(@Param('projectId') projectId: string, @Param('entryId') entryId: string) {
    return this.lorebookService.remove(projectId, entryId);
  }
}
