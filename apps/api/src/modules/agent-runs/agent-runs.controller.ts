import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { CreateAgentPlanDto } from './dto/create-agent-plan.dto';
import { ExecuteAgentRunDto } from './dto/execute-agent-run.dto';

@Controller()
export class AgentRunsController {
  constructor(private readonly agentRuns: AgentRunsService) {}

  @Post('agent-runs/plan')
  createPlan(@Body() dto: CreateAgentPlanDto) {
    return this.agentRuns.createPlan(dto);
  }

  // 更具体的 audit 路由必须放在 :id 路由前，避免被动态参数路由抢先匹配。
  @Get('agent-runs/:id/audit')
  auditTrail(@Param('id') id: string) {
    return this.agentRuns.auditTrail(id);
  }

  @Get('agent-runs/:id')
  get(@Param('id') id: string) {
    return this.agentRuns.get(id);
  }

  @Get('projects/:projectId/agent-runs')
  listByProject(@Param('projectId') projectId: string) {
    return this.agentRuns.listByProject(projectId);
  }

  @Post('agent-runs/:id/act')
  act(@Param('id') id: string, @Body() dto: ExecuteAgentRunDto) {
    return this.agentRuns.act(id, dto);
  }

  @Post('agent-runs/:id/approve-step')
  approveStep(@Param('id') id: string, @Body() dto: ExecuteAgentRunDto) {
    return this.agentRuns.approveStep(id, dto);
  }

  @Post('agent-runs/:id/retry')
  retry(@Param('id') id: string, @Body() dto: ExecuteAgentRunDto) {
    return this.agentRuns.retry(id, dto);
  }

  @Post('agent-runs/:id/replan')
  replan(@Param('id') id: string, @Body() dto: { message?: string }) {
    return this.agentRuns.replan(id, dto);
  }

  @Post('agent-runs/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.agentRuns.cancel(id);
  }
}