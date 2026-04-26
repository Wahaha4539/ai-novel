export interface AgentSkill {
  name: string;
  taskTypes: string[];
  description: string;
  defaultTools: string[];
  checklist: string[];
}

export const BUILTIN_SKILLS: AgentSkill[] = [
  {
    name: 'creative-agent-mvp',
    taskTypes: ['general', 'chapter_write', 'chapter_polish', 'project_import_preview', 'outline_design'],
    description: 'Agent-Centric MVP 默认技能，用于先跑通结构化计划、审批和工具执行闭环。',
    defaultTools: ['echo_report'],
    checklist: ['Plan 阶段不写正式业务表', 'Act 阶段只执行已审批计划', '所有步骤必须记录 Trace'],
  },
];