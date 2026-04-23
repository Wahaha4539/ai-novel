import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateVolumeDto } from './dto/create-volume.dto';
import { UpdateVolumeDto } from './dto/update-volume.dto';
import { ReorderVolumesDto } from './dto/reorder-volumes.dto';
import { VolumesService } from './volumes.service';

@Controller()
export class VolumesController {
  constructor(private readonly volumesService: VolumesService) {}

  @Get('projects/:projectId/volumes')
  list(@Param('projectId') projectId: string) {
    return this.volumesService.listByProject(projectId);
  }

  @Post('projects/:projectId/volumes')
  create(@Param('projectId') projectId: string, @Body() dto: CreateVolumeDto) {
    return this.volumesService.create(projectId, dto);
  }

  @Get('projects/:projectId/volumes/:volumeId')
  getOne(@Param('projectId') projectId: string, @Param('volumeId') volumeId: string) {
    return this.volumesService.getOne(projectId, volumeId);
  }

  @Patch('projects/:projectId/volumes/:volumeId')
  update(
    @Param('projectId') projectId: string,
    @Param('volumeId') volumeId: string,
    @Body() dto: UpdateVolumeDto,
  ) {
    return this.volumesService.update(projectId, volumeId, dto);
  }

  @Delete('projects/:projectId/volumes/:volumeId')
  remove(@Param('projectId') projectId: string, @Param('volumeId') volumeId: string) {
    return this.volumesService.remove(projectId, volumeId);
  }

  @Patch('projects/:projectId/volumes/reorder')
  reorder(@Param('projectId') projectId: string, @Body() dto: ReorderVolumesDto) {
    return this.volumesService.reorder(projectId, dto.volumeIds);
  }
}
