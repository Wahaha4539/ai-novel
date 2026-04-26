import { Injectable } from '@nestjs/common';
import { LlmGatewayService } from '../../llm/llm-gateway.service';
import { BaseTool, ToolContext } from '../base-tool';
import { SourceTextAnalysisOutput } from './analyze-source-text.tool';

interface BuildImportPreviewInput {
  analysis?: SourceTextAnalysisOutput;
  instruction?: string;
}

export interface ImportPreviewOutput {
  projectProfile: { title?: string; genre?: string; theme?: string; tone?: string; logline?: string; synopsis?: string; outline?: string };
  characters: Array<{ name: string; roleType?: string; personalityCore?: string; motivation?: string; backstory?: string }>;
  lorebookEntries: Array<{ title: string; entryType: string; content: string; summary?: string; tags?: string[] }>;
  volumes: Array<{ volumeNo: number; title: string; synopsis?: string; objective?: string; chapterCount?: number }>;
  chapters: Array<{ chapterNo: number; volumeNo?: number; title: string; objective?: string; conflict?: string; hook?: string; outline?: string; expectedWordCount?: number }>;
  risks: string[];
}

/**
 * 导入预览构建工具：把原始文案整理成项目资料、角色、设定、卷和章节预览。
 * 输出只作为审批预览，不直接持久化。
 */
@Injectable()
export class BuildImportPreviewTool implements BaseTool<BuildImportPreviewInput, ImportPreviewOutput> {
  name = 'build_import_preview';
  description = '根据文案分析结果生成项目资料、角色、世界观和大纲导入预览。';
  inputSchema = { type: 'object' as const, properties: { analysis: { type: 'object' as const }, instruction: { type: 'string' as const } } };
  outputSchema = {
    type: 'object' as const,
    required: ['projectProfile', 'characters', 'lorebookEntries', 'volumes', 'chapters', 'risks'],
    properties: { projectProfile: { type: 'object' as const }, characters: { type: 'array' as const }, lorebookEntries: { type: 'array' as const }, volumes: { type: 'array' as const }, chapters: { type: 'array' as const }, risks: { type: 'array' as const, items: { type: 'string' as const } } },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];

  constructor(private readonly llm: LlmGatewayService) {}

  async run(args: BuildImportPreviewInput, _context: ToolContext): Promise<ImportPreviewOutput> {
    const analysis = args.analysis;
    const sourceText = analysis?.sourceText ?? args.instruction ?? '';
    const { data } = await this.llm.chatJson<ImportPreviewOutput>(
      [
        { role: 'system', content: '你是小说项目导入 Agent。只输出 JSON，字段包含 projectProfile、characters、lorebookEntries、volumes、chapters、risks。不要 Markdown。' },
        { role: 'user', content: `用户要求：${args.instruction ?? ''}\n关键词：${analysis?.keywords?.join(', ') ?? ''}\n原始文案：\n${sourceText.slice(0, 24000)}` },
      ],
      { appStep: 'planner', maxTokens: 8000, timeoutMs: 120_000, retries: 1 },
    );
    return this.normalize(data, sourceText);
  }

  private normalize(data: ImportPreviewOutput, sourceText: string): ImportPreviewOutput {
    return {
      projectProfile: { ...data.projectProfile, synopsis: data.projectProfile?.synopsis || sourceText.slice(0, 800) },
      characters: (data.characters ?? []).slice(0, 30).filter((item) => item.name),
      lorebookEntries: (data.lorebookEntries ?? []).slice(0, 50).filter((item) => item.title && item.content),
      volumes: (data.volumes ?? []).slice(0, 12).map((item, index) => ({ ...item, volumeNo: Number(item.volumeNo) || index + 1, title: item.title || `第 ${index + 1} 卷` })),
      chapters: (data.chapters ?? []).slice(0, 200).map((item, index) => ({ ...item, chapterNo: Number(item.chapterNo) || index + 1, title: item.title || `第 ${index + 1} 章`, expectedWordCount: item.expectedWordCount ?? 2500 })),
      risks: data.risks ?? [],
    };
  }

}