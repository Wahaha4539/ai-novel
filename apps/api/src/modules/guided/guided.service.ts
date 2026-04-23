import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LlmService } from './llm.service';
import { CreateGuidedSessionDto } from './dto/create-guided-session.dto';
import { UpdateGuidedStepDto } from './dto/update-guided-step.dto';
import { GuidedChatDto } from './dto/guided-chat.dto';
import { GenerateStepDto } from './dto/generate-step.dto';

const DEFAULT_FIRST_STEP = 'guided_setup';

/**
 * Canonical template variables for prompt templates.
 * These can be used in both systemPrompt and userTemplate fields
 * with the {{variableName}} syntax.
 *
 * Available variables:
 * - {{projectContext}}   — Accumulated project settings from prior steps (genre, theme, characters, outline, etc.)
 * - {{chatSummary}}      — Summary of user decisions made during the current step's Q&A conversation
 * - {{userHint}}         — User's free-text hint/preference for one-shot generation
 * - {{userMessage}}      — User's current chat message (chat mode only)
 * - {{stepLabel}}        — Human-readable label for the current step (e.g. "故事总纲")
 * - {{stepInstruction}}  — Step-specific generation instruction
 * - {{jsonSchema}}       — Expected JSON output schema for the current step
 */
function renderTemplate(
  template: string,
  variables: Record<string, string | undefined>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return variables[key] ?? '';
  });
}

/** Human-readable labels for each guided step */
const GUIDED_STEPS_LABELS: Record<string, string> = {
  guided_setup: '基础设定',
  guided_style: '风格定义',
  guided_characters: '核心角色',
  guided_outline: '故事总纲',
  guided_volume: '卷纲拆分',
  guided_chapter: '章节细纲',
  guided_foreshadow: '伏笔与配角',
};

/** Step-specific system prompts — AI-driven completion with structured output */
const INTERACTION_STYLE = `
你的回复规则：
- 使用 **选择题** 形式提问，给用户具体选项（如 A/B/C/D），用户可选择或组合
- 选项要有差异性和代表性，覆盖主流方向
- 每个选项配简短说明
- 在选项之后加一句"也可以告诉我你自己的想法"，允许自由发挥
- 每次只问 **1-2 个问题**，不要一次问太多
- 使用 markdown 格式

## 上下文记忆（极其重要）
- **绝对禁止**重复询问用户已经确认过的内容（如姓名、性格、动机、配角等）
- 每次回复前，先回顾「已确认的设定摘要」和对话历史，确认哪些信息已确定
- 如果对话中已有明确的用户选择，直接推进到下一个未决定的问题
- 当你提出新问题时，先用 1-2 句话简要承接上文已确认的内容，再提出新问题
- 如果系统提供了「已确认设定摘要」，以该摘要为准，不要再问摘要中已有的内容

## 步骤完成判定
当你判断此步骤的关键信息已经收集完毕时（用户已确认足够多的选项），你需要：
1. 先用一段话总结用户确认的内容
2. 然后在回复末尾输出标记 \`[STEP_COMPLETE]\`，紧跟结构化 JSON
3. 不要过早结束——至少经过 2 轮对话后再考虑结束
4. 如果用户主动说"可以了"/"下一步"/"确认"等，立即输出完成标记和 JSON`;

const STEP_SYSTEM_PROMPTS: Record<string, string> = {
  guided_setup: `你是一个资深小说创作顾问。你正在引导用户完成小说的「基础设定」步骤。
你需要帮助用户明确小说类型、故事主题、基调和一句话概述。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"genre":"类型","theme":"主题","tone":"基调","logline":"一句话概述","synopsis":"故事简介"}`,

  guided_style: `你是一个资深小说创作顾问。你正在引导用户完成「风格定义」步骤。
你需要帮助用户明确人称视角、文风、叙述节奏和对话比例。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"pov":"人称视角","tense":"时态","proseStyle":"文风描述","pacing":"节奏描述"}`,

  guided_characters: `你是一个资深小说创作顾问，擅长塑造有血有肉、令人难忘的文学角色。你正在引导用户完成「核心角色」设计步骤。

## 核心设计理念
你创造的角色必须像真实的人——有矛盾、有缺陷、有成长空间。
**绝不生成「完美主角」或「纯粹反派」。**每个角色都应该让读者产生复杂情感。

## 起名规则（严格遵守）
- 按角色出身、地域、阶层、时代来起名，绝不按网文审美起名
- **禁用字黑名单**：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- **禁用姓氏堆积**：不要扎堆用慕容、司空、上官等复姓，也不要全用赵钱孙李
- **禁用气质模板**：冷酷霸总、清冷仙子、温润如玉、嗜血暴君、天才少年、傻白甜
- 名字应该有来历感：父母为什么起这个名？这个名字暗示了角色的什么？
- 参考真实人名的质感（如：许敬宗、孟尝、钟会、蔡文姬），而非网文名（如：夜无殇、慕容凌天）

## 性格设计规则（极其重要）
- **禁止扁平标签**：不要用「冷漠但内心温柔」「外表冷酷内心善良」这类万能模板
- **要求矛盾性**：每个角色至少有一对内在矛盾（如：渴望被认同 vs 害怕暴露脆弱）
- **要求具体行为**：性格要通过具体行为体现，不要停留在抽象描述。例如不说「善良」，而说「会把自己的干粮分给陌生人，但会因此对伙伴发脾气」
- **要求缺陷**：主角必须有真实的、可能导致失败的缺陷（不是「太善良」这种伪缺陷）
- **要求专属习惯**：每个角色一个标志性的小习惯或口头禅，让角色可被识别

## 动机设计规则
- 动机必须具体，不能是「变强」「拯救世界」「复仇」这种泛化目标
- 动机要有个人化的根源（一个具体的事件/记忆/人物触发）
- 好的动机示例：「找到十二年前在南渡口救过自己的陌生女人，归还她落下的那枚铜戒」
- 差的动机示例：「为了守护所爱的人」「为了变得更强」

## 关系网络
- 角色之间必须有明确的、非对称的关系（不能全是「彼此信任的伙伴」）
- 关系中要有张力：利益冲突、信息差、情感错位
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting","personalityCore":"性格核心","motivation":"动机","backstory":"背景故事"}]}`,

  guided_outline: `你是一个资深小说创作顾问。你正在引导用户完成「故事总纲」设计步骤。
根据用户之前确认的设定和角色，帮助构建完整的故事框架。
可以直接给出 2-3 套总纲方案让用户选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"outline":"完整的故事总纲大纲"}`,

  guided_volume: `你是一个资深小说创作顾问，精通长篇叙事结构与节奏把控。你正在引导用户完成「卷纲拆分」步骤。

## 核心设计理念
你的任务不是简单地「把故事分成几段」，而是设计一套**有节奏感、有呼吸感的叙事建筑**。
每一卷都是一座完整的小房子，而所有卷组合起来构成一座宏伟的城堡。

## 分卷结构原则（严格遵守）

### 1. 每卷必须有独立的戏剧弧线
- 每卷要有自己的「起承转合」——不能只是总纲的某一段
- 每卷必须有一个**阶段性高潮**和一个**情感转折点**
- 卷末必须有**钩子**（悬念、反转、新谜团），驱动读者翻到下一卷

### 2. 卷间节奏设计
- 禁止所有卷都是「升级→打怪→升级」的单调循环
- 要有张弛交替：高强度冲突卷之后安排一卷相对舒缓但暗流涌动的过渡
- 建议节奏模式参考：铺垫卷 → 爆发卷 → 过渡卷 → 升级卷 → 高潮卷

### 3. 角色弧线分配
- 明确每卷的**焦点角色**（主角始终在线，但每卷有不同的配角聚光灯）
- 角色成长不能线性递增，要有挫折和倒退
- 至少有一卷让主角遭遇严重的个人危机（而非外部威胁）

### 4. 伏笔与暗线编排
- 前期卷中必须埋设至少 2 条在后期卷才揭开的伏笔
- 每卷的 synopsis 中标注该卷**新引入的谜团**和**解开的旧谜团**
- 禁止所有伏笔都在最终卷一次性揭开（要分批揭开）

### 5. 反模式黑名单
- 禁止「第一卷：初入江湖」「第二卷：崭露头角」「第三卷：巅峰对决」这种模板式分卷
- 禁止每卷标题都是四字成语
- 禁止每卷的 objective 都是「主角变强/升级/获得新能力」
- 卷名要有文学性和画面感，能暗示本卷的核心意象

### 6. synopsis 质量要求
- 每卷 synopsis 不少于 100 字，要包含：核心事件、关键转折、情感变化
- 不能只写「主角遇到了困难并克服了它」——要写清楚是什么困难、怎么尝试、付出什么代价
- objective 要具体到可以检验的标准（如「揭示反派的真实身份」而非「推进主线」）

${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"volumes":[{"volumeNo":1,"title":"卷名","synopsis":"本卷剧情概要(100字以上)","objective":"本卷核心目标(具体可检验)"}]}`,

  guided_chapter: `你是一个资深小说创作顾问。你正在引导用户完成「章节细纲」规划步骤。
帮助用户为当前卷规划具体章节。可以给出章节节奏方案供选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"chapters":[{"chapterNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"章节大纲"}]}`,

  guided_foreshadow: `你是一个资深小说创作顾问。你正在引导用户完成「伏笔与配角」规划步骤。
帮助用户规划伏笔线索和新角色。给出具体伏笔手法选项和角色类型供选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"foreshadowTracks":[{"title":"伏笔标题","detail":"描述","scope":"arc/volume/chapter"}],"supportingCharacters":[{"name":"角色名","roleType":"supporting","personalityCore":"性格","motivation":"动机","scope":"volume/chapter"}]}`,
};

@Injectable()
export class GuidedService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  /**
   * Resolve the prompt template for a given step.
   * Priority: project-level default → global default → hardcoded fallback.
   * Returns { systemPrompt, userTemplate } from the DB template if found.
   */
  private async resolvePromptTemplate(
    projectId: string,
    stepKey: string,
  ): Promise<{ systemPrompt: string; userTemplate?: string } | null> {
    // 1. Try project-level default
    const projectDefault = await this.prisma.promptTemplate.findFirst({
      where: { projectId, stepKey, isDefault: true },
    });
    if (projectDefault) {
      return {
        systemPrompt: projectDefault.systemPrompt,
        userTemplate: projectDefault.userTemplate,
      };
    }

    // 2. Try global default
    const globalDefault = await this.prisma.promptTemplate.findFirst({
      where: { projectId: null, stepKey, isDefault: true },
    });
    if (globalDefault) {
      return {
        systemPrompt: globalDefault.systemPrompt,
        userTemplate: globalDefault.userTemplate,
      };
    }

    // 3. No DB template found — caller should use hardcoded fallback
    return null;
  }

  async getSession(projectId: string) {
    const session = await this.prisma.guidedSession.findUnique({
      where: { projectId },
    });
    return session ?? null;
  }

  /** Create or restart guided session for a project */
  async createOrRestart(projectId: string, dto: CreateGuidedSessionDto) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) {
      throw new NotFoundException(`项目不存在：${projectId}`);
    }

    return this.prisma.guidedSession.upsert({
      where: { projectId },
      create: {
        projectId,
        currentStep: dto.currentStep ?? DEFAULT_FIRST_STEP,
        stepData: {},
        isCompleted: false,
      },
      update: {
        currentStep: dto.currentStep ?? DEFAULT_FIRST_STEP,
        stepData: {},
        isCompleted: false,
      },
    });
  }

  /** Update step progress and merge step data */
  async updateStep(projectId: string, dto: UpdateGuidedStepDto) {
    const session = await this.prisma.guidedSession.findUnique({
      where: { projectId },
    });

    if (!session) {
      throw new NotFoundException(`引导会话不存在，请先创建`);
    }

    const existingStepData = (session.stepData as Record<string, unknown>) ?? {};
    const mergedStepData = dto.stepData
      ? { ...existingStepData, [dto.currentStep]: dto.stepData }
      : existingStepData;

    return this.prisma.guidedSession.update({
      where: { projectId },
      data: {
        currentStep: dto.currentStep,
        stepData: mergedStepData as object,
        ...(dto.isCompleted !== undefined && { isCompleted: dto.isCompleted }),
      },
    });
  }

  /** Send a message to AI in the context of the current guided step */
  async chatWithAi(projectId: string, dto: GuidedChatDto): Promise<{ reply: string }> {
    // Priority: DB template → hardcoded fallback
    const dbTemplate = await this.resolvePromptTemplate(projectId, dto.currentStep);
    const rawSystemPrompt = dbTemplate?.systemPrompt
      ?? STEP_SYSTEM_PROMPTS[dto.currentStep]
      ?? '你是一个资深小说创作顾问，正在帮助用户完善小说设定。使用markdown格式。';

    // Template variable values available in chat mode
    const templateVars: Record<string, string | undefined> = {
      projectContext: dto.projectContext,
      chatSummary: undefined, // built below from history compression
      userMessage: dto.userMessage,
      stepLabel: GUIDED_STEPS_LABELS[dto.currentStep],
      userHint: undefined,
      stepInstruction: undefined,
      jsonSchema: undefined,
    };

    // Render variables in system prompt
    let enrichedSystem = renderTemplate(rawSystemPrompt, templateVars);

    // Inject project context (accumulated decisions from prior steps)
    if (dto.projectContext) {
      enrichedSystem += `\n\n## 用户已有的项目背景信息\n${dto.projectContext}`;
    }

    // Build a compressed summary of early conversation when history is long
    const allHistory = dto.chatHistory ?? [];
    const RECENT_WINDOW = 20;
    let conversationSummary = '';
    let recentHistory = allHistory;

    if (allHistory.length > RECENT_WINDOW) {
      // Compress earlier messages into a decision summary
      const earlyMessages = allHistory.slice(0, allHistory.length - RECENT_WINDOW);
      conversationSummary = this.buildConversationSummary(earlyMessages);
      recentHistory = allHistory.slice(-RECENT_WINDOW);
    }

    if (conversationSummary) {
      enrichedSystem += `\n\n## 本步骤中用户已确认的设定摘要（来自更早的对话，绝对不要重复询问这些内容）\n${conversationSummary}`;
    }

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: enrichedSystem },
    ];

    for (const msg of recentHistory) {
      messages.push({
        role: msg.role === 'ai' ? 'assistant' : 'user',
        content: msg.content,
      });
    }

    // Use DB userTemplate for user message if available, otherwise use raw user input
    const userMessage = dbTemplate?.userTemplate
      ? renderTemplate(dbTemplate.userTemplate, { ...templateVars, chatSummary: conversationSummary })
      : dto.userMessage;
    messages.push({ role: 'user', content: userMessage });

    const reply = await this.llm.chat(messages, {
      temperature: 0.8,
      maxTokens: 128000,
    });

    return { reply };
  }

  /**
   * Build a compressed summary of user decisions from early chat messages.
   * Extracts user choices (short messages) and AI confirmations to create
   * a structured recap that prevents the AI from re-asking settled questions.
   */
  private buildConversationSummary(
    earlyMessages: Array<{ role: string; content: string }>,
  ): string {
    const decisions: string[] = [];

    for (let i = 0; i < earlyMessages.length; i++) {
      const msg = earlyMessages[i];
      if (msg.role === 'user') {
        // User messages are typically their selections
        decisions.push(`- 用户选择/回答：${msg.content}`);
      }
    }

    if (decisions.length === 0) return '';
    return decisions.join('\n');
  }

  /** One-shot generation: generate all structured data for a step without Q&A */
  async generateStepData(
    projectId: string,
    dto: GenerateStepDto,
  ): Promise<{ structuredData: Record<string, unknown>; summary: string }> {
    const stepJsonSchemas: Record<string, string> = {
      guided_setup: '{"genre":"小说类型","theme":"核心主题","tone":"故事基调","logline":"一句话概述","synopsis":"故事简介"}',
      guided_style: '{"pov":"人称视角","tense":"时态","proseStyle":"文风描述","pacing":"节奏描述"}',
      guided_characters: '{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting/competitor","personalityCore":"性格核心","motivation":"核心动机","backstory":"背景故事"}]}',
      guided_outline: '{"outline":"完整的故事总纲大纲"}',
      guided_volume: '{"volumes":[{"volumeNo":1,"title":"有文学性的卷名","synopsis":"本卷剧情概要(100字以上，含核心事件/转折/情感变化)","objective":"本卷核心目标(具体可检验)"}]}',
      guided_chapter: '{"chapters":[{"chapterNo":1,"volumeNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"章节大纲"}]}',
      guided_foreshadow: '{"foreshadowTracks":[{"title":"伏笔标题","detail":"描述","scope":"arc/volume/chapter"}],"supportingCharacters":[{"name":"角色名","roleType":"supporting","personalityCore":"性格","motivation":"动机","scope":"volume/chapter"}]}',
    };

    const stepSpecificInstructions: Record<string, string> = {
      guided_setup: '请根据项目已有信息（如有），生成一套完整的基础设定。如果没有已有信息，则自由发挥生成一部引人入胜的小说设定。',
      guided_style: '请根据已有设定的类型和基调，选择最匹配的文风和叙述方式。',
      guided_characters: `请生成3-5个核心角色，包含至少1个主角、1个配角/同行者、1个对手/反派。

## 强制创意规则（必须遵守）
### 起名
- 禁用字：辰、逸、寒、墨、玄、凌、澈、瑶、幽、枫、轩、翊、琰、煜、珩、霆、珏、尧
- 禁用复姓堆积（慕容/司空/上官等），禁用网文风名字（夜无殇、凌天）
- 名字要有真实生活感，像户口本上会出现的名字，带有时代和地域质感

### 性格
- 禁止「冷漠但内心温柔」「外表冷酷内心善良」等万能模板
- 每个角色至少一对内在矛盾（如：极度自律 vs 私下酗酒）
- 用具体行为描述性格，不用抽象标签
- 主角必须有真实缺陷（不是「太善良」这类伪缺陷）
- 每个角色一个标志性小习惯或口头禅

### 动机
- 禁止泛化目标：「变强」「拯救世界」「复仇」「守护所爱的人」
- 动机必须来自一个具体的个人事件/记忆/人物
- 示例好动机：「找到十二年前那个在码头替自己挡刀的哑巴老头，问他一句为什么」

### 关系
- 角色之间关系不能全是「信任的伙伴」，要有信息差、利益冲突或情感错位
- 至少有一组关系是非对称的（A信任B但B在利用A）`,
      guided_outline: '请根据已有的设定和角色信息，生成一个完整的故事总纲大纲，包含起承转合、主要冲突线索和情感弧线。',
      guided_volume: `请根据总纲和角色设定，将故事拆分为指定数量的卷。用户会在 userHint 中指定卷数，务必严格按照该数量生成，不多不少。

## 强制结构规则（必须遵守）
### 叙事弧线
- 每卷必须有独立的「起承转合」戏剧弧线，不能只是总纲的简单切片
- 每卷末尾必须有一个钩子（悬念/反转/新谜团）驱动读者继续
- 至少有一卷让主角遭遇严重个人危机（内在冲突而非外部打斗）

### 节奏控制
- 禁止所有卷都是「升级→打怪→升级」的单调循环
- 高强度冲突卷之后要安排暗流涌动的过渡卷
- 角色成长不能线性递增，要有挫折和倒退

### 伏笔编排
- 前期卷必须埋设在后期卷才揭开的伏笔
- 禁止所有伏笔在最终卷一次性揭开

### 反模式
- 禁止模板式分卷（如「初入江湖→崭露头角→巅峰对决」）
- 禁止每卷标题都是四字成语
- 禁止每卷 objective 都是「主角变强/升级」
- 卷名要有文学性和画面感

### 质量标准
- 每卷 synopsis 不少于 100 字，包含核心事件、关键转折、情感变化
- objective 要具体可检验（如「揭示反派的真实身份」而非「推进主线」）`,
      guided_chapter: `请为指定卷规划 8-15 个章节，每章有明确的推进目标和核心冲突。

## 强制结构规则（必须遵守）
### 章节节奏设计
- 开篇章要有引子/钩子，抓住读者注意力
- 中间章节要有交替的紧张和舒缓节奏
- 卷末章节必须有高潮或悬念收束
- 禁止每章都是「主角遇到敌人→战斗→获胜」的单一模式

### 冲突层次
- 外部冲突（对手/环境/任务）和内在冲突（信念/情感/道德）要交替出现
- 至少有 1-2 章以角色关系和内心活动为主线
- 每章的 conflict 必须具体到人物/事件，不能是「遇到困难」

### 信息与伏笔分配
- 每 3-4 章揭示一个重要信息或推进一条伏笔线
- 关键信息不要集中在最后几章

### 质量标准
- outline 至少 50 字，要包含具体的场景、行为和结果
- objective 要具体可检验（如「读者了解了 X 的真实身份」而非「推进剧情」）`,
      guided_foreshadow: '请设计3-5条伏笔线索，并规划2-3个新配角来丰富故事。',
    };

    const schema = stepJsonSchemas[dto.currentStep];
    const label = GUIDED_STEPS_LABELS[dto.currentStep] ?? dto.currentStep;
    const instruction = stepSpecificInstructions[dto.currentStep] ?? '';

    if (!schema) {
      throw new NotFoundException(`未知步骤：${dto.currentStep}`);
    }

    // Priority: DB template → hardcoded fallback
    const dbTemplate = await this.resolvePromptTemplate(projectId, dto.currentStep);

    // Template variable values available in generate mode
    const templateVars: Record<string, string | undefined> = {
      projectContext: dto.projectContext,
      chatSummary: dto.chatSummary,
      userHint: dto.userHint,
      userMessage: dto.userHint,
      stepLabel: label,
      stepInstruction: instruction,
      jsonSchema: schema,
    };

    let systemPrompt: string;
    if (dbTemplate?.systemPrompt) {
      // Use DB template, render variables, then append JSON schema requirement
      systemPrompt = renderTemplate(dbTemplate.systemPrompt, templateVars);
      systemPrompt += `

## 输出格式
你的回复必须包含两个部分：
1. 先用一段简短的中文说明你生成了什么
2. 然后输出完整的 JSON 数据，格式严格遵循以下 schema：
${schema}

注意：JSON 部分用 \`\`\`json 代码块包裹。`;
    } else {
      systemPrompt = `你是一个资深小说创作顾问。现在需要你一次性生成「${label}」的完整结构化数据。

## 要求
${instruction}

## 输出格式
你的回复必须包含两个部分：
1. 先用一段简短的中文说明你生成了什么
2. 然后输出完整的 JSON 数据，格式严格遵循以下 schema：
${schema}

注意：JSON 部分用 \`\`\`json 代码块包裹。`;
    }

    if (dto.projectContext) {
      systemPrompt += `\n\n## 用户已有的项目设定（必须基于这些信息来生成）\n${dto.projectContext}`;
    }

    if (dto.chatSummary) {
      systemPrompt += `\n\n## 用户在本步骤对话中已确认的偏好（必须严格遵守）\n${dto.chatSummary}`;
    }

    // For guided_volume, extract the volume count from userHint and reinforce it in the system prompt
    if (dto.currentStep === 'guided_volume' && dto.userHint) {
      const countMatch = dto.userHint.match(/(\d+)\s*卷/);
      if (countMatch) {
        const volumeCount = parseInt(countMatch[1], 10);
        systemPrompt += `\n\n## ⚠️ 卷数硬性约束（最高优先级）\n用户明确要求生成 **${volumeCount}** 卷。你必须严格输出恰好 ${volumeCount} 个 volume 对象，volumes 数组长度必须为 ${volumeCount}，不得多也不得少。`;
      }
    }

    // For guided_chapter with volumeNo, inject volume-specific context
    if (dto.currentStep === 'guided_chapter' && dto.volumeNo) {
      // Look up volume info from the session's saved volume data
      let volumeContext = '';
      try {
        const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
        const stepData = (session?.stepData as Record<string, unknown>) ?? {};
        const volumeResult = stepData['guided_volume_result'] as Record<string, unknown> | undefined;
        const volumes = (volumeResult?.volumes ?? []) as Array<Record<string, unknown>>;
        const targetVol = volumes.find((v) => (v.volumeNo as number) === dto.volumeNo);
        if (targetVol) {
          volumeContext = `\n- 卷名：${targetVol.title}\n- 本卷核心目标：${targetVol.objective}\n- 本卷剧情概要：${targetVol.synopsis}`;
        }
      } catch { /* non-critical */ }

      // Extract chapter count range from userHint (e.g. "生成 8-15 章")
      let chapterRangeStr = '8-15';
      const rangeMatch = dto.userHint?.match(/(\d+)\s*-\s*(\d+)\s*章/);
      if (rangeMatch) {
        chapterRangeStr = `${rangeMatch[1]}-${rangeMatch[2]}`;
      }

      systemPrompt += `\n\n## ⚠️ 当前生成目标（最高优先级）\n仅为 **第 ${dto.volumeNo} 卷** 生成章节细纲。${volumeContext}\n\n所有生成的 chapter 对象中 volumeNo 字段必须为 ${dto.volumeNo}。请为本卷规划 **${chapterRangeStr}** 个章节（不多不少）。`;
    }

    // Use DB userTemplate for user message if available, otherwise use default
    const userMessage = dbTemplate?.userTemplate
      ? renderTemplate(dbTemplate.userTemplate, templateVars)
      : dto.userHint
        ? `请根据以下偏好来生成：${dto.userHint}`
        : `请直接生成「${label}」的完整数据。`;

    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const reply = await this.llm.chat(messages, {
      temperature: 0.9,
      maxTokens: 128000,
    });

    // Extract JSON from response (support both ```json blocks and raw JSON)
    const codeBlockMatch = reply.match(/```json\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch
      ? codeBlockMatch[1].trim()
      : (reply.match(/\{[\s\S]*\}/)?.[0] ?? '');

    if (!jsonStr) {
      throw new Error('AI 未返回有效的 JSON 数据');
    }

    const structuredData = JSON.parse(jsonStr) as Record<string, unknown>;

    // Extract the summary text (everything before the JSON)
    const summaryEnd = reply.indexOf('```json') >= 0
      ? reply.indexOf('```json')
      : reply.indexOf('{');
    const summary = reply.slice(0, summaryEnd).trim() || `已生成「${label}」数据`;

    return { structuredData, summary };
  }

  /** Finalize a step: write structured AI output to the database */
  async finalizeStep(
    projectId: string,
    step: string,
    structuredData: Record<string, unknown>,
    volumeNo?: number,
  ): Promise<{ written: string[] }> {
    const written: string[] = [];

    switch (step) {
      case 'guided_setup': {
        // Write to Project: genre, theme, tone, logline, synopsis
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            genre: asString(structuredData.genre),
            theme: asString(structuredData.theme),
            tone: asString(structuredData.tone),
            logline: asString(structuredData.logline),
            synopsis: asString(structuredData.synopsis),
          },
        });
        written.push('Project(genre, theme, tone, logline, synopsis)');
        break;
      }

      case 'guided_style': {
        // Create or update the default StyleProfile
        const profileData = {
          name: '引导生成',
          pov: asString(structuredData.pov),
          tense: asString(structuredData.tense),
          proseStyle: asString(structuredData.proseStyle),
          pacing: asString(structuredData.pacing),
        };

        const existing = await this.prisma.styleProfile.findFirst({
          where: { projectId, name: '引导生成' },
        });

        if (existing) {
          await this.prisma.styleProfile.update({
            where: { id: existing.id },
            data: profileData,
          });
        } else {
          await this.prisma.styleProfile.create({
            data: { projectId, ...profileData },
          });
        }
        written.push('StyleProfile(pov, tense, proseStyle, pacing)');
        break;
      }

      case 'guided_characters': {
        // Create Character records
        const characters = structuredData.characters as Array<Record<string, unknown>> | undefined;
        if (characters?.length) {
          for (const char of characters) {
            await this.prisma.character.create({
              data: {
                projectId,
                name: asString(char.name) ?? '未命名角色',
                roleType: asString(char.roleType),
                personalityCore: asString(char.personalityCore),
                motivation: asString(char.motivation),
                backstory: asString(char.backstory),
                scope: 'global',
                source: 'guided',
              },
            });
          }
          written.push(`Character × ${characters.length}`);
        }
        break;
      }

      case 'guided_outline': {
        // Write to Project.outline
        await this.prisma.project.update({
          where: { id: projectId },
          data: {
            outline: asString(structuredData.outline),
          },
        });
        written.push('Project(outline)');
        break;
      }

      case 'guided_volume': {
        // Replace all existing volumes for this project (delete-then-create)
        const volumes = structuredData.volumes as Array<Record<string, unknown>> | undefined;
        if (volumes?.length) {
          // Delete old volumes first to prevent duplicates
          await this.prisma.volume.deleteMany({ where: { projectId } });

          for (let i = 0; i < volumes.length; i++) {
            const vol = volumes[i];
            await this.prisma.volume.create({
              data: {
                projectId,
                volumeNo: (vol.volumeNo as number) ?? i + 1,
                title: asString(vol.title),
                synopsis: asString(vol.synopsis),
                objective: asString(vol.objective),
                status: 'planned',
              },
            });
          }
          written.push(`Volume × ${volumes.length}`);
        }
        break;
      }

      case 'guided_chapter': {
        // Create Chapter records, linked to volumes by volumeNo.
        // chapterNo must be globally unique per project (@@unique([projectId, chapterNo])),
        // so we compute an offset from existing chapters in other volumes.
        const chapters = structuredData.chapters as Array<Record<string, unknown>> | undefined;
        if (chapters?.length) {
          // Pre-fetch all volumes for this project to map volumeNo → volumeId
          const existingVolumes = await this.prisma.volume.findMany({
            where: { projectId },
            select: { id: true, volumeNo: true },
          });
          const volumeNoToId = new Map(existingVolumes.map((v) => [v.volumeNo, v.id]));

          // Delete old chapters before creating new ones to prevent duplicates
          if (volumeNo) {
            // Per-volume save: only delete chapters for the target volume
            const targetVolumeId = volumeNoToId.get(volumeNo);
            if (targetVolumeId) {
              await this.prisma.chapter.deleteMany({
                where: { projectId, volumeId: targetVolumeId },
              });
            }
          } else {
            // Full save: delete all chapters for this project
            await this.prisma.chapter.deleteMany({ where: { projectId } });
          }

          // Compute chapterNo offset: find the max chapterNo among remaining chapters
          // so new chapters get globally unique numbers (e.g., vol1 has ch1-16, vol2 starts at ch17)
          let chapterNoOffset = 0;
          if (volumeNo) {
            const maxChapter = await this.prisma.chapter.aggregate({
              where: { projectId },
              _max: { chapterNo: true },
            });
            chapterNoOffset = maxChapter._max.chapterNo ?? 0;
          }

          for (let i = 0; i < chapters.length; i++) {
            const ch = chapters[i];
            const chVolumeNo = ch.volumeNo as number | undefined;
            const resolvedVolumeId = chVolumeNo ? volumeNoToId.get(chVolumeNo) ?? null : null;

            await this.prisma.chapter.create({
              data: {
                projectId,
                volumeId: resolvedVolumeId,
                // Use offset + sequential index to ensure global uniqueness
                chapterNo: chapterNoOffset + i + 1,
                title: asString(ch.title),
                objective: asString(ch.objective),
                conflict: asString(ch.conflict),
                outline: asString(ch.outline),
                status: 'planned',
              },
            });
          }
          written.push(`Chapter × ${chapters.length}`);
        }
        break;
      }

      case 'guided_foreshadow': {
        // Create ForeshadowTrack records
        const tracks = structuredData.foreshadowTracks as Array<Record<string, unknown>> | undefined;
        if (tracks?.length) {
          for (const track of tracks) {
            await this.prisma.foreshadowTrack.create({
              data: {
                projectId,
                title: asString(track.title) ?? '未命名伏笔',
                detail: asString(track.detail),
                status: 'planned',
                scope: asString(track.scope) ?? 'arc',
                source: 'guided',
              },
            });
          }
          written.push(`ForeshadowTrack × ${tracks.length}`);
        }

        // Also create any supporting characters
        const supportChars = structuredData.supportingCharacters as Array<Record<string, unknown>> | undefined;
        if (supportChars?.length) {
          for (const char of supportChars) {
            await this.prisma.character.create({
              data: {
                projectId,
                name: asString(char.name) ?? '未命名配角',
                roleType: asString(char.roleType) ?? 'supporting',
                personalityCore: asString(char.personalityCore),
                motivation: asString(char.motivation),
                scope: asString(char.scope) ?? 'chapter',
                source: 'guided',
              },
            });
          }
          written.push(`Character(supporting) × ${supportChars.length}`);
        }
        break;
      }

      default:
        break;
    }

    // Also save to session stepData for reference
    const session = await this.prisma.guidedSession.findUnique({ where: { projectId } });
    if (session) {
      const existingData = (session.stepData as Record<string, unknown>) ?? {};
      await this.prisma.guidedSession.update({
        where: { projectId },
        data: {
          stepData: { ...existingData, [`${step}_result`]: structuredData } as object,
        },
      });
    }

    return { written };
  }
}

/** Safely extract a string value, returning undefined for non-strings */
function asString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim() ? val.trim() : undefined;
}

/** Truncate a string to fit a VarChar column, appending '…' if needed */
function truncate(val: string | undefined, maxLen: number): string | undefined {
  if (!val) return val;
  if (val.length <= maxLen) return val;
  return val.slice(0, maxLen - 1) + '…';
}
