import { PrismaClient } from '@prisma/client';
import { OUTLINE_SYSTEM_PROMPT, OUTLINE_USER_TEMPLATE } from './seed-prompts/outline';
import { WRITE_CHAPTER_SYSTEM_PROMPT, WRITE_CHAPTER_USER_TEMPLATE } from './seed-prompts/write-chapter';
import { POLISH_CHAPTER_SYSTEM_PROMPT, POLISH_CHAPTER_USER_TEMPLATE } from './seed-prompts/polish-chapter';
import {
  STYLE_CONCISE_SYSTEM_PROMPT, STYLE_CONCISE_USER_TEMPLATE,
  STYLE_CINEMATIC_SYSTEM_PROMPT, STYLE_CINEMATIC_USER_TEMPLATE,
  STYLE_GENERAL_SYSTEM_PROMPT, STYLE_GENERAL_USER_TEMPLATE,
} from './seed-prompts/writing-styles';

const prisma = new PrismaClient();

interface SeedTemplate {
  stepKey: string;
  name: string;
  description: string;
  systemPrompt: string;
  userTemplate: string;
  isDefault: boolean;
  tags: string[];
}

const DEFAULT_TEMPLATES: SeedTemplate[] = [
  // 1. 大纲生成
  {
    stepKey: 'generate_outline',
    name: '大纲生成（默认）',
    description: '专业级卷纲+细纲生成，支持多种结构模型（三幕式、费希特曲线等），含因果链、角色弧线、伏笔管理',
    systemPrompt: OUTLINE_SYSTEM_PROMPT,
    userTemplate: OUTLINE_USER_TEMPLATE,
    isDefault: true,
    tags: ['大纲', '卷纲', '结构'],
  },
  // 2. 章节生成
  {
    stepKey: 'write_chapter',
    name: '章节生成（默认）',
    description: '专业级章节正文写作，含MRU推进法、感官描写、对话技术、去AI味规则',
    systemPrompt: WRITE_CHAPTER_SYSTEM_PROMPT,
    userTemplate: WRITE_CHAPTER_USER_TEMPLATE,
    isDefault: true,
    tags: ['写作', '正文', '章节'],
  },
  // 3. 章节润色
  {
    stepKey: 'polish_chapter',
    name: '章节润色（默认）',
    description: '精细文本润色，去AI味、感官补足、对话打磨、节奏微调，保持剧情不变',
    systemPrompt: POLISH_CHAPTER_SYSTEM_PROMPT,
    userTemplate: POLISH_CHAPTER_USER_TEMPLATE,
    isDefault: true,
    tags: ['润色', '编辑', '去AI味'],
  },
  // 4. 写作风格 — 简洁
  {
    stepKey: 'writing_style',
    name: '简洁风格',
    description: '短句、高信息密度、精确描写，适合快节奏叙事',
    systemPrompt: STYLE_CONCISE_SYSTEM_PROMPT,
    userTemplate: STYLE_CONCISE_USER_TEMPLATE,
    isDefault: true,
    tags: ['风格', '简洁'],
  },
  // 5. 写作风格 — 画面感
  {
    stepKey: 'writing_style',
    name: '画面感风格',
    description: '镜头感叙事、五感描写、电影式场景切换',
    systemPrompt: STYLE_CINEMATIC_SYSTEM_PROMPT,
    userTemplate: STYLE_CINEMATIC_USER_TEMPLATE,
    isDefault: false,
    tags: ['风格', '画面', '镜头感'],
  },
  // 6. 写作风格 — 通用
  {
    stepKey: 'writing_style',
    name: '通用风格',
    description: '自然克制、节奏紧凑、因果完整，适用于大多数题材',
    systemPrompt: STYLE_GENERAL_SYSTEM_PROMPT,
    userTemplate: STYLE_GENERAL_USER_TEMPLATE,
    isDefault: false,
    tags: ['风格', '通用'],
  },
];

async function main() {
  console.log('🌱 Seeding default prompt templates...');

  for (const tpl of DEFAULT_TEMPLATES) {
    // Upsert: use (projectId=null, stepKey, name) as unique key
    const existing = await prisma.promptTemplate.findFirst({
      where: {
        projectId: null,
        stepKey: tpl.stepKey,
        name: tpl.name,
      },
    });

    if (existing) {
      await prisma.promptTemplate.update({
        where: { id: existing.id },
        data: {
          description: tpl.description,
          systemPrompt: tpl.systemPrompt,
          userTemplate: tpl.userTemplate,
          isDefault: tpl.isDefault,
          tags: tpl.tags,
        },
      });
      console.log(`  ✅ Updated: [${tpl.stepKey}] ${tpl.name}`);
    } else {
      await prisma.promptTemplate.create({
        data: {
          projectId: null,
          stepKey: tpl.stepKey,
          name: tpl.name,
          description: tpl.description,
          systemPrompt: tpl.systemPrompt,
          userTemplate: tpl.userTemplate,
          isDefault: tpl.isDefault,
          tags: tpl.tags,
        },
      });
      console.log(`  ✨ Created: [${tpl.stepKey}] ${tpl.name}`);
    }
  }

  console.log(`\n✅ Done! Seeded ${DEFAULT_TEMPLATES.length} prompt templates.`);
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
