import { BadRequestException, Injectable } from '@nestjs/common';
import { RuleEngineService } from '../agent-rules/rule-engine.service';
import { BaseTool, ToolContext } from '../agent-tools/base-tool';
import { AgentPlanStepSpec } from './agent-planner.service';

/** 执行硬策略校验，确保 Plan/Act 边界和审批规则不会被 Planner 输出绕过。 */
@Injectable()
export class AgentPolicyService {
  constructor(private readonly rules: RuleEngineService) {}

  /** 校验整份计划的执行上限，避免 Executor 静默截断步骤导致计划半执行。 */
  assertPlanExecutable(steps: AgentPlanStepSpec[]) {
    const { limits } = this.rules.getPolicy();
    if (steps.length > limits.maxSteps) throw new BadRequestException(`Agent Plan 步骤数超过上限：${limits.maxSteps}`);
  }

  assertAllowed(tool: BaseTool, context: ToolContext, plannedTools: string[]) {
    if (!tool.allowedModes.includes(context.mode)) throw new BadRequestException(`工具 ${tool.name} 不允许在 ${context.mode} 模式执行`);
    if (context.mode === 'plan' && tool.sideEffects.length > 0) throw new BadRequestException('Plan 模式禁止执行有副作用工具');
    if (context.mode === 'act' && !plannedTools.includes(tool.name)) throw new BadRequestException(`工具 ${tool.name} 不在已批准计划中`);
    if (tool.requiresApproval && !context.approved) throw new BadRequestException(`工具 ${tool.name} 需要用户审批`);

    const riskIds = this.detectRiskIds(tool);
    const confirmation = context.policy.confirmation as { confirmHighRisk?: boolean; confirmedRiskIds?: string[] } | undefined;
    const confirmedIds = new Set(confirmation?.confirmedRiskIds ?? []);
    const requiresSecondConfirm = riskIds.some((riskId) => this.rules.getPolicy().secondConfirmRiskIds.includes(riskId));
    if (context.mode === 'act' && requiresSecondConfirm && !confirmation?.confirmHighRisk && !riskIds.every((riskId) => confirmedIds.has(riskId))) {
      throw new BadRequestException(`工具 ${tool.name} 命中风险 ${riskIds.join(', ')}，需要二次确认`);
    }
  }

  /** 将 Tool 元数据映射为可审计风险 ID，供二次确认、事实覆盖保护和删除保护统一使用。 */
  private detectRiskIds(tool: BaseTool): string[] {
    const policy = this.rules.getPolicy();
    const sideEffects = tool.sideEffects.map((item) => item.toLowerCase());
    const risks = new Set<string>();
    if (tool.riskLevel === 'high') risks.add('high_risk');
    if (sideEffects.some((effect) => policy.destructiveSideEffects.some((keyword) => effect.includes(keyword)))) risks.add('destructive_side_effect');
    if (sideEffects.some((effect) => policy.factLayerSideEffects.some((keyword) => effect.includes(keyword)))) risks.add('fact_layer_write');
    if (sideEffects.some((effect) => effect.includes('delete') || effect.includes('remove'))) risks.add('delete_side_effect');
    return [...risks];
  }
}