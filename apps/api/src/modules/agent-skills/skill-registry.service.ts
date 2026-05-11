import { Injectable } from '@nestjs/common';
import { AgentSkill, BUILTIN_SKILLS } from './builtin-skills';

/** 管理内置创作技能，Planner 根据 taskType 选择最匹配的方法论。 */
@Injectable()
export class SkillRegistryService {
  list(): AgentSkill[] {
    return BUILTIN_SKILLS;
  }

  select(taskType?: string): AgentSkill {
    const targetTaskType = taskType ?? 'general';
    const matches = BUILTIN_SKILLS.filter((skill) => skill.taskTypes.includes(targetTaskType));
    return matches.sort((left, right) => left.taskTypes.length - right.taskTypes.length)[0] ?? BUILTIN_SKILLS[0];
  }
}
