import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { BaseTool, ToolContext } from '../base-tool';

interface ResolveChapterInput {
  chapterId?: string;
  chapterNo?: number;
}

interface ResolveChapterOutput {
  chapterId: string;
  chapterNo: number;
  title: string | null;
  status: string;
  objective: string | null;
  conflict: string | null;
  outline: string | null;
  expectedWordCount: number | null;
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
  inputSchema = { type: 'object' as const, additionalProperties: false, properties: { chapterId: { type: 'string' as const, minLength: 1 }, chapterNo: { type: 'number' as const, minimum: 1 } } };
  outputSchema = {
    type: 'object' as const,
    required: ['chapterId', 'chapterNo', 'status'],
    properties: {
      chapterId: { type: 'string' as const, minLength: 1 },
      chapterNo: { type: 'number' as const, minimum: 1 },
      title: { type: ['string', 'null'] as const },
      status: { type: 'string' as const, minLength: 1 },
      objective: { type: ['string', 'null'] as const },
      conflict: { type: ['string', 'null'] as const },
      outline: { type: ['string', 'null'] as const },
      expectedWordCount: { type: ['number', 'null'] as const, minimum: 0 },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly prisma: PrismaService) {}

  async run(args: ResolveChapterInput, context: ToolContext): Promise<ResolveChapterOutput> {
    const chapterId = args.chapterId ?? context.chapterId;
    const chapterNo = typeof args.chapterNo === 'number' ? args.chapterNo : undefined;

    if (!chapterId && !chapterNo) {
      throw new BadRequestException('resolve_chapter 需要 chapterId 或 chapterNo');
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
      title: chapter.title,
      status: chapter.status,
      objective: chapter.objective,
      conflict: chapter.conflict,
      outline: chapter.outline,
      expectedWordCount: chapter.expectedWordCount,
    };
  }
}