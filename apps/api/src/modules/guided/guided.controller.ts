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
    console.log('[Guided] POST create/restart', { projectId, body: dto });
    return this.guidedService.createOrRestart(projectId, dto);
  }

  @Patch('projects/:projectId/guided-session/step')
  updateStep(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateGuidedStepDto,
  ) {
    console.log('[Guided] PATCH updateStep', { projectId, body: dto });
    return this.guidedService.updateStep(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/chat')
  chat(
    @Param('projectId') projectId: string,
    @Body() dto: GuidedChatDto,
  ) {
    console.log('[Guided] POST chat', { projectId, step: dto.currentStep, userMessage: dto.userMessage, historyLen: dto.chatHistory?.length ?? 0 });
    return this.guidedService.chatWithAi(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/generate-step')
  generateStep(
    @Param('projectId') projectId: string,
    @Body() dto: GenerateStepDto,
  ) {
    console.log('[Guided] POST generate-step', { projectId, body: dto });
    return this.guidedService.generateStepData(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/finalize-step')
  finalizeStep(
    @Param('projectId') projectId: string,
    @Body() dto: FinalizeStepDto,
  ) {
    console.log('[Guided] POST finalize-step', { projectId, step: dto.currentStep, dataKeys: Object.keys(dto.structuredData ?? {}) });
    return this.guidedService.finalizeStep(
      projectId,
      dto.currentStep,
      dto.structuredData ?? {},
    );
  }
}
