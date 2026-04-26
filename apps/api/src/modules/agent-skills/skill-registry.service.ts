import { Injectable } from '@nestjs/common';
import { AgentSkill, BUILTIN_SKILLS } from './builtin-skills';

/** 管理内置创作技能，Planner 根据 taskType 选择最匹配的方法论。 */
@Injectable()
export class SkillRegistryService {
  list(): AgentSkill[] {
    return BUILTIN_SKILLS;
  }

  select(taskType?: string): AgentSkill {
    return BUILTIN_SKILLS.find((skill) => skill.taskTypes.includes(taskType ?? 'general')) ?? BUILTIN_SKILLS[0];
  }
}