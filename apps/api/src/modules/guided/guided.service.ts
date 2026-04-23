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

  guided_characters: `你是一个资深小说创作顾问。你正在引导用户完成「核心角色」设计步骤。
你需要帮助用户设计主角、重要配角和对手/反派的名字、性格和动机。
给出具体的名字/性格选项供参考。

## 起名规则（严格遵守）
- 按角色出身、地域、阶层、时代来起名，不按网文审美起名
- 避开高频字（如：辰、逸、寒、墨、玄、凌、澈、瑶、幽）和高频气质（冷酷霸总、清冷仙子）
- 名字要像这个世界里真实生活的人，不像某个小说平台里的角色
- 姓氏选择要合理，不要扎堆使用稀有姓或大姓，注意姓名搭配的时代感和地域感
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"characters":[{"name":"角色名","roleType":"protagonist/antagonist/supporting","personalityCore":"性格核心","motivation":"动机","backstory":"背景故事"}]}`,

  guided_outline: `你是一个资深小说创作顾问。你正在引导用户完成「故事总纲」设计步骤。
根据用户之前确认的设定和角色，帮助构建完整的故事框架。
可以直接给出 2-3 套总纲方案让用户选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"outline":"完整的故事总纲大纲"}`,

  guided_volume: `你是一个资深小说创作顾问。你正在引导用户完成「卷纲拆分」步骤。
帮助用户将总纲拆分为多个卷。给出不同的分卷方案供选择。
${INTERACTION_STYLE}
完成时输出的 JSON 格式：
\`[STEP_COMPLETE]\`{"volumes":[{"volumeNo":1,"title":"卷名","synopsis":"本卷剧情概要","objective":"本卷核心目标"}]}`,

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
      guided_volume: '{"volumes":[{"volumeNo":1,"title":"卷名","synopsis":"本卷剧情概要","objective":"本卷核心目标"}]}',
      guided_chapter: '{"chapters":[{"chapterNo":1,"title":"章节标题","objective":"本章目标","conflict":"核心冲突","outline":"章节大纲"}]}',
      guided_foreshadow: '{"foreshadowTracks":[{"title":"伏笔标题","detail":"描述","scope":"arc/volume/chapter"}],"supportingCharacters":[{"name":"角色名","roleType":"supporting","personalityCore":"性格","motivation":"动机","scope":"volume/chapter"}]}',
    };

    const stepSpecificInstructions: Record<string, string> = {
      guided_setup: '请根据项目已有信息（如有），生成一套完整的基础设定。如果没有已有信息，则自由发挥生成一部引人入胜的小说设定。',
      guided_style: '请根据已有设定的类型和基调，选择最匹配的文风和叙述方式。',
      guided_characters: '请生成3-5个核心角色，包含至少1个主角、1个配角/同行者、1个对手/反派。每个角色要有鲜明的性格特征、明确的动机和有深度的背景故事。',
      guided_outline: '请根据已有的设定和角色信息，生成一个完整的故事总纲大纲，包含起承转合、主要冲突线索和情感弧线。',
      guided_volume: '请根据总纲将故事拆分为3-5个卷，每个卷有清晰的剧情目标和阶段性高潮。',
      guided_chapter: '请为当前卷规划8-15个章节，每章有明确的推进目标和核心冲突。',
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
        // Create Volume records
        const volumes = structuredData.volumes as Array<Record<string, unknown>> | undefined;
        if (volumes?.length) {
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
        // Create Chapter records, optionally linked to volumes
        const chapters = structuredData.chapters as Array<Record<string, unknown>> | undefined;
        if (chapters?.length) {
          for (const ch of chapters) {
            await this.prisma.chapter.create({
              data: {
                projectId,
                volumeId: asString(ch.volumeId) ?? null,
                chapterNo: (ch.chapterNo as number) ?? 1,
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
