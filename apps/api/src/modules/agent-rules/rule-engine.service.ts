import { Injectable } from '@nestjs/common';
import { AgentPolicyConfig, BUILTIN_HARD_RULES, BUILTIN_POLICY_CONFIG } from './builtin-rules';

/** RuleEngine 暴露可执行策略和硬规则文本，供 Planner Prompt、Policy 校验和审计展示共用。 */
@Injectable()
export class RuleEngineService {
  listHardRules(): string[] {
    return BUILTIN_HARD_RULES.map((rule) => rule.text);
  }

  /** 返回当前 Agent Runtime 使用的硬策略，避免 Planner/Executor 各自硬编码上限和风险判定。 */
  getPolicy(): AgentPolicyConfig {
    return BUILTIN_POLICY_CONFIG;
  }
}