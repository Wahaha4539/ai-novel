import { BadRequestException, Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';

interface AnalyzeSourceTextInput {
  sourceText?: string;
}

export interface SourceTextAnalysisOutput {
  sourceText: string;
  length: number;
  paragraphs: string[];
  keywords: string[];
}

/**
 * 文案分析工具：将用户自然语言目标中的长文案拆成基础段落和关键词。
 * 该工具只做确定性文本整理，供后续 LLM 结构化预览使用。
 */
@Injectable()
export class AnalyzeSourceTextTool implements BaseTool<AnalyzeSourceTextInput, SourceTextAnalysisOutput> {
  name = 'analyze_source_text';
  description = '分析用户提供的小说文案，提取段落和关键词，不写入业务数据。';
  inputSchema = { type: 'object' as const, required: ['sourceText'], properties: { sourceText: { type: 'string' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['sourceText', 'length', 'paragraphs', 'keywords'],
    properties: { sourceText: { type: 'string' as const }, length: { type: 'number' as const }, paragraphs: { type: 'array' as const, items: { type: 'string' as const } }, keywords: { type: 'array' as const, items: { type: 'string' as const } } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  async run(args: AnalyzeSourceTextInput, _context: ToolContext): Promise<SourceTextAnalysisOutput> {
    const sourceText = args.sourceText?.trim();
    if (!sourceText) throw new BadRequestException('analyze_source_text 需要 sourceText');

    const paragraphs = sourceText
      .split(/\n{1,}|。|；|;/)
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 80);

    return { sourceText, length: sourceText.length, paragraphs, keywords: this.extractKeywords(sourceText) };
  }

  private extractKeywords(text: string): string[] {
    const candidates = text.match(/[\u4e00-\u9fffA-Za-z0-9]{2,12}/g) ?? [];
    const counts = new Map<string, number>();
    for (const item of candidates) counts.set(item, (counts.get(item) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
      .slice(0, 20)
      .map(([item]) => item);
  }
}