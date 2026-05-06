import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

interface ResolveChapterInput {
  chapterId?: string;
  chapterNo?: number;
  chapterRef?: string;
  currentChapterId?: string | null;
  currentChapterIndex?: number;
  currentVolumeId?: string;
}

interface ResolveChapterOutput {
  chapterId: string;
  chapterNo: number;
  index: number;
  title: string | null;
  status: string;
  objective: string | null;
  conflict: string | null;
  outline: string | null;
  expectedWordCount: number | null;
  confidence: number;
  alternatives: Array<{ chapterId: string; chapterNo: number; title: string | null; confidence: number }>;
  needsUserChoice: boolean;
}

/**
 * 章节解析工具：把用户自然语言里的章节编号或上下文 chapterId 解析为正式章节记录。
 * 输入为 chapterId 或 chapterNo；输出为后续章节写作 Tool 所需的稳定章节上下文。
 * 该工具只读数据库，无业务写入副作用，可在 Act 阶段安全执行并被 AgentStep 追踪。
 */
@Injectable()
export class ResolveChapterTool implements BaseTool<ResolveChapterInput, ResolveChapterOutput> {
  name = 'resolve_chapter';
  description = '根据 chapterId 或章节编号解析项目内章节，返回章节写作所需的基础上下文。';
  inputSchema = { type: 'object' as const, additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, chapterNo: { type: 'number' as const, minimum: 1 }, chapterRef: { type: 'string' as const, minLength: 1 }, currentChapterId: { type: ['string', 'null'] as const }, currentChapterIndex: { type: 'number' as const, minimum: 1 }, currentVolumeId: { type: 'string' as const, minLength: 1 } } };
  outputSchema = {
    type: 'object' as const,
    required: ['chapterId', 'chapterNo', 'status', 'confidence', 'alternatives', 'needsUserChoice'],
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      chapterNo: { type: 'number' as const, minimum: 1 },
      index: { type: 'number' as const, minimum: 1 },
      title: { type: ['string', 'null'] as const },
      status: { type: 'string' as const, minLength: 1 },
      objective: { type: ['string', 'null'] as const },
      conflict: { type: ['string', 'null'] as const },
      outline: { type: ['string', 'null'] as const },
      expectedWordCount: { type: ['number', 'null'] as const, minimum: 0 },
      confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
      alternatives: { type: 'array' as const },
      needsUserChoice: { type: 'boolean' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '解析章节引用',
    description: '把“当前章”“下一章”“第十二章”等自然语言章节引用解析为真实 chapterId。',
    whenToUse: ['用户提到“当前章/这一章/上一章/下一章”', '用户提到“第十二章/第 12 章/第一卷第三章”', '目标工具需要 chapterId 但上下文没有明确 ID'],
    whenNotToUse: ['AgentContext.session.currentChapterId 已明确且用户没有提到其他章节', '用户没有涉及章节级操作'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      chapterRef: { source: 'user_message', description: '用户原话中的章节引用，例如“第十二章”“下一章”。', examples: ['当前章', '下一章', '第十二章'] },
      currentChapterId: { source: 'context', description: '解析“上一章/下一章/这一章”时使用的当前章节 ID。' },
    },
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
    idPolicy: { forbiddenToInvent: ['chapterId'], allowedSources: ['context.session.currentChapterId', 'resolve_chapter.output.chapterId'] },
  };

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ResolveChapterInput, context: ToolContext): Promise<ResolveChapterOutput> {
    const explicitChapterId = args.chapterId ?? (args.chapterRef && this.looksLikeUuid(args.chapterRef) ? args.chapterRef : undefined);
    const currentChapterId = args.currentChapterId ?? context.chapterId;
    const chapterNo = typeof args.chapterNo === 'number' ? args.chapterNo : await this.resolveChapterNo(args.chapterRef, context.projectId, currentChapterId, args.currentChapterIndex);
    const chapterId = explicitChapterId ?? (!chapterNo && !args.chapterRef ? context.chapterId : undefined);

    if (!chapterId && !chapterNo) {
      throw new BadRequestException('resolve_chapter 需要 chapterId、chapterNo 或可解析的 chapterRef');
    }

    // 限定 projectId，避免 Agent 通过伪造 chapterId 读取其他项目章节。
    const chapter = await this.prisma.chapter.findFirst({
      where: chapterId ? { id: chapterId, projectId: context.projectId } : { chapterNo, projectId: context.projectId },
    });

    if (!chapter) {
      throw new NotFoundException(chapterId ? `章节不存在或不属于当前项目：${chapterId}` : `项目内不存在第 ${chapterNo} 章`);
    }

    return {
      chapterId: chapter.id,
      chapterNo: chapter.chapterNo,
      index: chapter.chapterNo,
      title: chapter.title,
      status: chapter.status,
      objective: chapter.objective,
      conflict: chapter.conflict,
      outline: chapter.outline,
      expectedWordCount: chapter.expectedWordCount,
      confidence: chapterId || args.chapterNo ? 1 : 0.92,
      alternatives: [],
      needsUserChoice: false,
    };
  }

  private async resolveChapterNo(chapterRef: string | undefined, projectId: string, currentChapterId?: string | null, currentChapterIndex?: number) {
    if (!chapterRef) return undefined;
    const normalized = chapterRef.replace(/\s+/g, '').trim();
    if (['当前章', '这一章', '本章'].includes(normalized)) return currentChapterIndex ?? await this.loadCurrentChapterNo(projectId, currentChapterId);
    if (['上一章', '前一章'].includes(normalized)) {
      const current = currentChapterIndex ?? await this.loadCurrentChapterNo(projectId, currentChapterId);
      return current ? Math.max(1, current - 1) : undefined;
    }
    if (['下一章', '后一章'].includes(normalized)) {
      const current = currentChapterIndex ?? await this.loadCurrentChapterNo(projectId, currentChapterId);
      return current ? current + 1 : undefined;
    }
    const arabic = normalized.match(/第?(\d+)章/);
    if (arabic) return Number(arabic[1]);
    const chinese = normalized.match(/第?([零〇一二两三四五六七八九十百千]+)章/);
    return chinese ? this.parseChineseNumber(chinese[1]) : undefined;
  }

  private async loadCurrentChapterNo(projectId: string, currentChapterId?: string | null) {
    if (!currentChapterId) return undefined;
    const chapter = await this.prisma.chapter.findFirst({ where: { id: currentChapterId, projectId }, select: { chapterNo: true } });
    return chapter?.chapterNo;
  }

  private parseChineseNumber(value: string) {
    const digits: Record<string, number> = { 零: 0, '〇': 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (value === '十') return 10;
    const tenIndex = value.indexOf('十');
    if (tenIndex >= 0) {
      const high = tenIndex === 0 ? 1 : digits[value[tenIndex - 1]] ?? 0;
      const low = tenIndex === value.length - 1 ? 0 : digits[value[tenIndex + 1]] ?? 0;
      return high * 10 + low;
    }
    return [...value].reduce((sum, char) => sum * 10 + (digits[char] ?? 0), 0) || undefined;
  }

  private looksLikeUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
