import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { CreatePromptTemplateDto } from './dto/create-prompt-template.dto';
import { UpdatePromptTemplateDto } from './dto/update-prompt-template.dto';
import { PromptTemplatesService } from './prompt-templates.service';

@Controller()
export class PromptTemplatesController {
  constructor(private readonly service: PromptTemplatesService) {}

  /** List global templates, optionally filtered by stepKey */
  @Get('prompt-templates')
  listGlobal(@Query('stepKey') stepKey?: string) {
    return this.service.listGlobal(stepKey);
  }

  /** List merged templates (global + project overrides) for a project */
  @Get('projects/:projectId/prompt-templates')
  listForProject(
    @Param('projectId') projectId: string,
    @Query('stepKey') stepKey?: string,
  ) {
    return this.service.listForProject(projectId, stepKey);
  }

  /** Create a new template (global if no projectId, project-level otherwise) */
  @Post('prompt-templates')
  create(@Body() dto: CreatePromptTemplateDto) {
    return this.service.create(dto);
  }

  @Patch('prompt-templates/:id')
  update(@Param('id') id: string, @Body() dto: UpdatePromptTemplateDto) {
    return this.service.update(id, dto);
  }

  @Patch('prompt-templates/:id/set-default')
  setDefault(@Param('id') id: string) {
    return this.service.setDefault(id);
  }

  @Delete('prompt-templates/:id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
