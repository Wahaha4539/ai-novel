import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { MemoryService } from './memory.service';

@Controller()
export class MemoryController {
  constructor(private readonly memoryService: MemoryService) {}

  @Get('projects/:projectId/memory/search')
  search(@Param('projectId') projectId: string, @Query('q') q?: string) {
    return this.memoryService.search(projectId, q);
  }

  @Post('projects/:projectId/memory/rebuild')
  rebuild(@Param('projectId') projectId: string) {
    return this.memoryService.rebuild(projectId);
  }
}
