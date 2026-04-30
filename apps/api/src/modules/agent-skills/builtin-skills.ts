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
    taskTypes: ['general', 'chapter_write', 'multi_chapter_write', 'chapter_polish', 'chapter_revision', 'character_consistency_check', 'worldbuilding_expand', 'plot_consistency_check', 'memory_review', 'project_import_preview', 'outline_design'],
    description: 'Agent-Centric MVP 默认技能，用于先跑通结构化计划、审批和工具执行闭环。',
    defaultTools: ['resolve_chapter', 'resolve_character', 'collect_chapter_context', 'collect_task_context', 'character_consistency_check', 'plot_consistency_check', 'inspect_project_context', 'generate_worldbuilding_preview', 'validate_worldbuilding', 'persist_worldbuilding', 'write_chapter', 'write_chapter_series', 'polish_chapter', 'fact_validation', 'echo_report'],
    checklist: ['Plan 阶段不写正式业务表', '自然语言章节/角色引用先走 resolver', 'Act 阶段只执行已审批计划', '所有步骤必须记录 Trace', '章节写作/修改要保留用户的禁改项和风格约束'],
  },
];