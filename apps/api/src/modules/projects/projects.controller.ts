import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateCreativeProfileDto } from './dto/update-creative-profile.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  list() {
    return this.projectsService.list();
  }

  @Post()
  create(@Body() dto: CreateProjectDto) {
    return this.projectsService.create(dto);
  }

  @Get(':projectId')
  getDetail(@Param('projectId') projectId: string) {
    return this.projectsService.getDetail(projectId);
  }

  @Get(':projectId/creative-profile')
  getCreativeProfile(@Param('projectId') projectId: string) {
    return this.projectsService.getCreativeProfile(projectId);
  }

  @Patch(':projectId/creative-profile')
  updateCreativeProfile(@Param('projectId') projectId: string, @Body() dto: UpdateCreativeProfileDto) {
    return this.projectsService.updateCreativeProfile(projectId, dto);
  }

  @Patch(':projectId')
  update(@Param('projectId') projectId: string, @Body() dto: UpdateProjectDto) {
    return this.projectsService.update(projectId, dto);
  }

  @Delete(':projectId')
  remove(@Param('projectId') projectId: string) {
    return this.projectsService.remove(projectId);
  }
}
