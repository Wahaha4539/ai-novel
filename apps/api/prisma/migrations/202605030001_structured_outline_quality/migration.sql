-- Phase 3: structured outline data and execution-card quality gates.
ALTER TABLE "Volume"
  ADD COLUMN "narrativePlan" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "Chapter"
  ADD COLUMN "craftBrief" JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Keep existing database PromptTemplate rows aligned with the upgraded seed prompt.
-- Project-specific defaults are updated as well because PromptBuilder prefers them.
UPDATE "PromptTemplate"
   SET "systemPrompt" = "systemPrompt" || E'\n\n<EXECUTION_CARD_RULES>\n如果上下文包含【本章执行卡】或 Chapter.craftBrief，你必须把它当作本章执行契约，而不是可选参考。\n- 行动链：按关键行动节点推进场景，不能只在内心独白中概述。\n- 物证/线索：让关键物证或线索以可感知细节出现在正文中，并影响角色选择。\n- 对话潜台词：至少一处对话要通过试探、隐瞒、误导或回避表达隐藏目的。\n- 人物变化：正文结尾前必须落下认知、关系、立场或情绪的具体变化。\n- 不可逆后果：必须写出事实、关系、资源、地位、规则或危险的变化，后续章节不能轻易退回原状。\n</EXECUTION_CARD_RULES>',
       "updatedAt" = NOW()
 WHERE "stepKey" = 'write_chapter'
   AND "systemPrompt" IS NOT NULL
   AND "systemPrompt" NOT LIKE '%<EXECUTION_CARD_RULES>%';
