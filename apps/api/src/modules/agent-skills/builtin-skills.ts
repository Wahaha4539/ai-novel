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
    taskTypes: ['general', 'chapter_write', 'multi_chapter_write', 'chapter_polish', 'chapter_revision', 'chapter_passage_revision', 'chapter_craft_brief', 'chapter_progress_card', 'character_consistency_check', 'worldbuilding_expand', 'story_bible_expand', 'scene_card_planning', 'plot_consistency_check', 'continuity_check', 'timeline_plan', 'ai_quality_review', 'memory_review', 'project_import_preview', 'outline_design', 'guided_step_consultation', 'guided_step_generate', 'guided_step_finalize'],
    description: 'Agent-Centric MVP 默认技能，用于先跑通结构化计划、审批、创作引导上下文和工具执行闭环。',
    defaultTools: ['resolve_chapter', 'resolve_character', 'collect_chapter_context', 'collect_task_context', 'character_consistency_check', 'plot_consistency_check', 'generate_continuity_preview', 'validate_continuity_changes', 'persist_continuity_changes', 'generate_timeline_preview', 'align_chapter_timeline_preview', 'validate_timeline_preview', 'persist_timeline_events', 'ai_quality_review', 'inspect_project_context', 'generate_volume_outline_preview', 'generate_story_units_preview', 'persist_story_units', 'generate_outline_preview', 'generate_chapter_outline_preview', 'merge_chapter_outline_previews', 'validate_outline', 'persist_outline', 'persist_volume_outline', 'persist_volume_character_candidates', 'generate_worldbuilding_preview', 'validate_worldbuilding', 'persist_worldbuilding', 'generate_story_bible_preview', 'validate_story_bible', 'persist_story_bible', 'generate_chapter_craft_brief_preview', 'validate_chapter_craft_brief', 'persist_chapter_craft_brief', 'list_scene_cards', 'generate_scene_cards_preview', 'validate_scene_cards', 'persist_scene_cards', 'update_scene_card', 'write_chapter', 'rewrite_chapter', 'write_chapter_series', 'polish_chapter', 'revise_chapter_passage_preview', 'apply_chapter_passage_revision', 'fact_validation', 'echo_report', 'report_result'],
    checklist: ['Plan 阶段不写正式业务表', '自然语言章节/角色引用先走 resolver', '创作引导场景优先使用 guided_step_* taskType', 'Act 阶段只执行已审批计划', '所有步骤必须记录 Trace', '章节写作/修改要保留用户的禁改项和风格约束'],
  },
  {
    name: 'humanizer-polish',
    taskTypes: ['chapter_polish', 'chapter_revision'],
    description: '基于 blader/humanizer 的项目内润色技能，用于章节去 AI 味、表达减法、声音校准和最后一遍 anti-AI pass。',
    defaultTools: ['resolve_chapter', 'collect_chapter_context', 'polish_chapter', 'fact_validation', 'auto_repair_chapter', 'extract_chapter_facts', 'rebuild_memory', 'review_memory', 'report_result'],
    checklist: [
      '只做表达层润色，不改变剧情事实、叙事视角、人物关系、时间线或关键事件结果',
      '保留用户禁改项、风格样本和角色语气；没有样本时使用自然克制的小说叙述',
      '内部先诊断 AI 痕迹，再执行 anti-AI pass；诊断和评分不得进入正文输出',
      '优先删减空泛拔高、宣传腔、三段式排比、总结腔、感官堆叠和角色同声同气',
      '润色写入必须走 polish_chapter，并在审批后执行；用户要求从头重写时改用 rewrite_chapter',
    ],
  },
];
