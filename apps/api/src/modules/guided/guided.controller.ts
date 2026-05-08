import { BadRequestException, Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
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
    console.log(`[Guided] POST create/restart pid=${projectId} step=${dto.currentStep ?? 'default'}`);
    return this.guidedService.createOrRestart(projectId, dto);
  }

  @Patch('projects/:projectId/guided-session/step')
  updateStep(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateGuidedStepDto,
  ) {
    console.log(`[Guided] PATCH step pid=${projectId} step=${dto.currentStep}`);
    return this.guidedService.updateStep(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/chat')
  chat(
    @Param('projectId') projectId: string,
    @Body() dto: GuidedChatDto,
  ) {
    console.log(`[Guided] POST chat pid=${projectId} step=${dto.currentStep} histLen=${dto.chatHistory?.length ?? 0}`);
    return this.guidedService.chatWithAi(projectId, dto);
  }

  @Post('projects/:projectId/guided-session/generate-step')
  generateStep(
    @Param('projectId') projectId: string,
    @Body() dto: GenerateStepDto,
  ) {
    console.log(`[Guided] POST generate pid=${projectId} step=${dto.currentStep}`);
    return this.guidedService.generateStepData(projectId, dto);
  }

  /**
   * @deprecated 兼容旧 guided UI 的直接写入路径。新功能必须通过 Agent
   * `guided_step_finalize` 计划，在审批后执行 `persist_guided_step_result`。
   */
  @Post('projects/:projectId/guided-session/finalize-step')
  finalizeStep(
    @Param('projectId') projectId: string,
    @Body() dto: FinalizeStepDto,
  ) {
    console.warn(`[Guided][blocked-deprecated-write] POST finalize pid=${projectId} step=${dto.currentStep} keys=[${Object.keys(dto.structuredData ?? {}).join(',')}] volumeNo=${dto.volumeNo ?? 'all'} requiredEntry=persist_guided_step_result`);
    throw new BadRequestException('旧 guided-session/finalize-step 直写入口已停用。请通过 Agent 的 guided_step_finalize 流程，在 validate_guided_step_preview 校验通过并获得用户审批后调用 persist_guided_step_result。');
  }
}
