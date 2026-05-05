import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreatePacingBeatDto } from './dto/create-pacing-beat.dto';
import { ListPacingBeatsQueryDto } from './dto/list-pacing-beats-query.dto';
import { UpdatePacingBeatDto } from './dto/update-pacing-beat.dto';
import { PacingBeatsService } from './pacing-beats.service';

@Controller()
export class PacingBeatsController {
  constructor(private readonly pacingBeatsService: PacingBeatsService) {}

  @Post('projects/:projectId/pacing-beats')
  create(@Param('projectId') projectId: string, @Body() dto: CreatePacingBeatDto) {
    return this.pacingBeatsService.create(projectId, dto);
  }

  @Get('projects/:projectId/pacing-beats')
  list(@Param('projectId') projectId: string, @Query() query: ListPacingBeatsQueryDto) {
    return this.pacingBeatsService.list(projectId, query);
  }

  @Patch('projects/:projectId/pacing-beats/:beatId')
  update(
    @Param('projectId') projectId: string,
    @Param('beatId') beatId: string,
    @Body() dto: UpdatePacingBeatDto,
  ) {
    return this.pacingBeatsService.update(projectId, beatId, dto);
  }

  @Delete('projects/:projectId/pacing-beats/:beatId')
  remove(@Param('projectId') projectId: string, @Param('beatId') beatId: string) {
    return this.pacingBeatsService.remove(projectId, beatId);
  }
}
