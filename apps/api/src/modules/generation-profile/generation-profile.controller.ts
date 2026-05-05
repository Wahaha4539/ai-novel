import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { UpdateGenerationProfileDto } from './dto/update-generation-profile.dto';
import { GenerationProfileService } from './generation-profile.service';

@Controller('projects/:projectId/generation-profile')
export class GenerationProfileController {
  constructor(private readonly generationProfileService: GenerationProfileService) {}

  @Get()
  get(@Param('projectId') projectId: string) {
    return this.generationProfileService.get(projectId);
  }

  @Patch()
  update(@Param('projectId') projectId: string, @Body() dto: UpdateGenerationProfileDto) {
    return this.generationProfileService.update(projectId, dto);
  }
}
