import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';

interface GenerateOutlinePreviewInput {
  context?: Record<string, unknown>;
  instruction?: string;
  volumeNo?: number;
  chapterCount?: number;
}

export interface OutlinePreviewOutput {
  volume: { volumeNo: number; title: string; synopsis: string; objective: string; chapterCount: number };
  chapters: Array<{ chapterNo: number; title: string; objective: string; conflict: string; hook: string; outline: string; expectedWordCount: number }>;
  risks: string[];
}

/**
 * 大纲预览生成工具：请求 LLM 输出结构化 JSON，失败时直接报错，避免低质量骨架污染规划。
 * 输出仅作为预览传给后续审批，不直接写正式业务表。
 */
@Injectable()
export class GenerateOutlinePreviewTool implements BaseTool<GenerateOutlinePreviewInput, OutlinePreviewOutput> {
  name = 'generate_outline_preview';
  description = '根据项目上下文和用户目标生成卷/章节大纲预览，不写入正式业务表。';
  inputSchema = { type: 'object' as const, properties: { context: { type: 'object' as const }, instruction: { type: 'string' as const }, volumeNo: { type: 'number' as const }, chapterCount: { type: 'number' as const } } };
  outputSchema = { type: 'object' as const, required: ['volume', 'chapters', 'risks'], properties: { volume: { type: 'object' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const, items: { type: 'string' as const } } } };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: GenerateOutlinePreviewInput, _context: ToolContext): Promise<OutlinePreviewOutput> {
    const volumeNo = args.volumeNo ?? 1;
    const chapterCount = Math.min(80, Math.max(1, args.chapterCount ?? 10));
    const { data } = await this.llm.chatJson<OutlinePreviewOutput>(
      [
        { role: 'system', content: '你是小说大纲设计 Agent。只输出 JSON，不要 Markdown。字段必须包含 volume、chapters、risks。每章包含 chapterNo/title/objective/conflict/hook/outline/expectedWordCount。' },
        { role: 'user', content: `用户目标：${args.instruction ?? '生成章节大纲'}\n卷号：${volumeNo}\n章节数：${chapterCount}\n项目上下文：\n${JSON.stringify(args.context ?? {}, null, 2).slice(0, 20000)}` },
      ],
      { appStep: 'planner', maxTokens: Math.min(8000, chapterCount * 260 + 1200), timeoutMs: 120_000, retries: 1 },
    );
    return this.normalize(data, volumeNo, chapterCount);
  }

  private normalize(data: OutlinePreviewOutput, volumeNo: number, chapterCount: number): OutlinePreviewOutput {
    const chapters = (data.chapters ?? []).slice(0, chapterCount).map((item, index) => ({
      chapterNo: Number(item.chapterNo) || index + 1,
      title: this.text(item.title, `第 ${index + 1} 章`),
      objective: this.text(item.objective, '推进主线目标'),
      conflict: this.text(item.conflict, '制造角色选择压力'),
      hook: this.text(item.hook, '留下下一章悬念'),
      outline: this.text(item.outline, this.text(item.objective, '待扩写')),
      expectedWordCount: Number(item.expectedWordCount) || 2500,
    }));
    return { volume: { volumeNo, title: this.text(data.volume?.title, `第 ${volumeNo} 卷`), synopsis: this.text(data.volume?.synopsis, ''), objective: this.text(data.volume?.objective, ''), chapterCount: chapters.length }, chapters, risks: data.risks ?? [] };
  }

  /** 将 LLM 可能返回的非字符串字段收敛为字符串，避免后续 Tool 对 trim 等字符串方法崩溃。 */
  private text(value: unknown, fallback: string): string {
    if (typeof value === 'string') return value.trim() || fallback;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (value && typeof value === 'object') return JSON.stringify(value);
    return fallback;
  }

}