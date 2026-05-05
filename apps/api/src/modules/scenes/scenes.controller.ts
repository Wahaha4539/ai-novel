import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreateSceneDto } from './dto/create-scene.dto';
import { ListScenesQueryDto } from './dto/list-scenes-query.dto';
import { UpdateSceneDto } from './dto/update-scene.dto';
import { ScenesService } from './scenes.service';

@Controller()
export class ScenesController {
  constructor(private readonly scenesService: ScenesService) {}

  @Post('projects/:projectId/scenes')
  create(@Param('projectId') projectId: string, @Body() dto: CreateSceneDto) {
    return this.scenesService.create(projectId, dto);
  }

  @Get('projects/:projectId/scenes')
  list(@Param('projectId') projectId: string, @Query() query: ListScenesQueryDto) {
    return this.scenesService.list(projectId, query);
  }

  @Patch('projects/:projectId/scenes/:sceneId')
  update(
    @Param('projectId') projectId: string,
    @Param('sceneId') sceneId: string,
    @Body() dto: UpdateSceneDto,
  ) {
    return this.scenesService.update(projectId, sceneId, dto);
  }

  @Delete('projects/:projectId/scenes/:sceneId')
  remove(@Param('projectId') projectId: string, @Param('sceneId') sceneId: string) {
    return this.scenesService.remove(projectId, sceneId);
  }
}
