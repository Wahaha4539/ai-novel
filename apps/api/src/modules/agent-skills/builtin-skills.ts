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
    taskTypes: ['general', 'chapter_write', 'multi_chapter_write', 'chapter_polish', 'chapter_revision', 'chapter_craft_brief', 'chapter_progress_card', 'character_consistency_check', 'worldbuilding_expand', 'story_bible_expand', 'scene_card_planning', 'plot_consistency_check', 'continuity_check', 'ai_quality_review', 'memory_review', 'project_import_preview', 'outline_design', 'guided_step_consultation', 'guided_step_generate', 'guided_step_finalize'],
    description: 'Agent-Centric MVP 默认技能，用于先跑通结构化计划、审批、创作引导上下文和工具执行闭环。',
    defaultTools: ['resolve_chapter', 'resolve_character', 'collect_chapter_context', 'collect_task_context', 'character_consistency_check', 'plot_consistency_check', 'generate_continuity_preview', 'validate_continuity_changes', 'persist_continuity_changes', 'ai_quality_review', 'inspect_project_context', 'generate_worldbuilding_preview', 'validate_worldbuilding', 'persist_worldbuilding', 'generate_story_bible_preview', 'validate_story_bible', 'persist_story_bible', 'generate_chapter_craft_brief_preview', 'validate_chapter_craft_brief', 'persist_chapter_craft_brief', 'list_scene_cards', 'generate_scene_cards_preview', 'validate_scene_cards', 'persist_scene_cards', 'update_scene_card', 'write_chapter', 'rewrite_chapter', 'write_chapter_series', 'polish_chapter', 'fact_validation', 'echo_report', 'report_result'],
    checklist: ['Plan 阶段不写正式业务表', '自然语言章节/角色引用先走 resolver', '创作引导场景优先使用 guided_step_* taskType', 'Act 阶段只执行已审批计划', '所有步骤必须记录 Trace', '章节写作/修改要保留用户的禁改项和风格约束'],
  },
];
