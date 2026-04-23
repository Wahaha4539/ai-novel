import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CreateGuidedSessionDto } from './dto/create-guided-session.dto';
import { UpdateGuidedStepDto } from './dto/update-guided-step.dto';
import { GuidedChatDto } from './dto/guided-chat.dto';
import { FinalizeStepDto } from './dto/finalize-step.dto';
import { GenerateStepDto } from './dto/generate-step.dto';
import { GuidedService } from './guided.service';

@Controller()
export class GuidedController {
  constructor(private readonly guidedService: GuidedService) {}

  @Get('projects/:projectId/guided-session')
  getSession(@Param('projectId') projectId: string) {
    return this.guidedService.getSession(projectId);
  }

  @Post('projects/:projectId/guided-session')
  createOrRestart(
    @Param('projectId') projectId: string,
    @Body() dto: CreateGuidedSessionDto,
  ) {
    return this.guidedService.createOrRestart(projectId, dto);
  }

  @Patch('projects/:projectId/guided-session/step')
  updateStep(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateGuidedStepDto,
  ) {
    return this.guidedService.updateStep(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/chat')
  chat(
    @Param('projectId') projectId: string,
    @Body() dto: GuidedChatDto,
  ) {
    return this.guidedService.chatWithAi(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/generate-step')
  generateStep(
    @Param('projectId') projectId: string,
    @Body() dto: GenerateStepDto,
  ) {
    return this.guidedService.generateStepData(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/finalize-step')
  finalizeStep(
    @Param('projectId') projectId: string,
    @Body() dto: FinalizeStepDto,
  ) {
    return this.guidedService.finalizeStep(
      projectId,
      dto.currentStep,
      dto.structuredData ?? {},
    );
  }
}
