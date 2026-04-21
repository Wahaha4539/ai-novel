import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CreateLorebookEntryDto } from './dto/create-lorebook-entry.dto';
import { LorebookService } from './lorebook.service';

@Controller()
export class LorebookController {
  constructor(private readonly lorebookService: LorebookService) {}

  @Post('projects/:projectId/lorebook')
  create(@Param('projectId') projectId: string, @Body() dto: CreateLorebookEntryDto) {
    return this.lorebookService.create(projectId, dto);
  }

  @Get('projects/:projectId/lorebook/search')
  search(@Param('projectId') projectId: string, @Query('q') q?: string) {
    return this.lorebookService.list(projectId, q);
  }
}
