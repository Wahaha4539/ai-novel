import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { AgentRulesModule } from '../agent-rules/agent-rules.module';
import { AgentSkillsModule } from '../agent-skills/agent-skills.module';
import { AgentToolsModule } from '../agent-tools/agent-tools.module';
import { LlmModule } from '../llm/llm.module';
import { AgentExecutorService } from './agent-executor.service';
import { AgentPlannerService } from './agent-planner.service';
import { AgentPolicyService } from './agent-policy.service';
import { AgentRunsController } from './agent-runs.controller';
import { AgentRunsService } from './agent-runs.service';
import { AgentRuntimeService } from './agent-runtime.service';
import { AgentTraceService } from './agent-trace.service';

@Module({
  imports: [PrismaModule, AgentToolsModule, AgentSkillsModule, AgentRulesModule, LlmModule],
  controllers: [AgentRunsController],
  providers: [AgentRunsService, AgentRuntimeService, AgentPlannerService, AgentExecutorService, AgentPolicyService, AgentTraceService],
})
export class AgentRunsModule {}