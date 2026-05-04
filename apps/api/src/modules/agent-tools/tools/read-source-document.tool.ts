import { BadRequestException, Injectable } from '@nestjs/common';
import { BaseTool, ToolContext } from '../base-tool';
import type { ToolManifestV2 } from '../tool-manifest.types';

type SourceDocumentExtension = 'md' | 'txt' | 'docx' | 'pdf';

interface SourceDocumentAttachmentInput {
  id?: string;
  kind?: string;
  provider?: string;
  fileName?: string;
  extension?: SourceDocumentExtension | string;
  mimeType?: string;
  size?: number;
  url?: string;
}

interface ReadSourceDocumentInput {
  attachment?: SourceDocumentAttachmentInput;
  url?: string;
  fileName?: string;
  extension?: SourceDocumentExtension | string;
}

export interface ReadSourceDocumentOutput {
  sourceText: string;
  title?: string;
  fileName?: string;
  extension: string;
  length: number;
  truncated: boolean;
  excerpt: string;
  sourceUrl: string;
  diagnostics: {
    fetchStatus: 'succeeded' | 'failed';
    parseStatus: 'succeeded' | 'unsupported' | 'failed';
    warnings: string[];
  };
}

const SUPPORTED_EXTENSIONS = new Set<SourceDocumentExtension>(['md', 'txt', 'docx', 'pdf']);
const TEXT_EXTENSIONS = new Set<SourceDocumentExtension>(['md', 'txt']);
const MAX_SOURCE_TEXT_LENGTH = 80_000;
const EXCERPT_LENGTH = 1_200;

/**
 * 从创意文档附件 URL 读取正文。P0 只支持 UTF-8 文本型 .md/.txt，不写入业务数据。
 */
@Injectable()
export class ReadSourceDocumentTool implements BaseTool<ReadSourceDocumentInput, ReadSourceDocumentOutput> {
  name = 'read_source_document';
  description = '从 creative_document 附件的 HTTPS URL 下载并读取 .md/.txt 正文，供后续导入预览使用。';
  inputSchema = {
    type: 'object' as const,
    properties: {
      attachment: {
        type: 'object' as const,
        properties: {
          url: { type: 'string' as const },
          fileName: { type: 'string' as const },
          extension: { type: 'string' as const, enum: ['md', 'txt', 'docx', 'pdf'] },
        },
      },
      url: { type: 'string' as const },
      fileName: { type: 'string' as const },
      extension: { type: 'string' as const, enum: ['md', 'txt', 'docx', 'pdf'] },
    },
  };
  outputSchema = {
    type: 'object' as const,
    required: ['sourceText', 'extension', 'length', 'truncated', 'excerpt', 'sourceUrl', 'diagnostics'],
    properties: {
      sourceText: { type: 'string' as const },
      title: { type: 'string' as const },
      fileName: { type: 'string' as const },
      extension: { type: 'string' as const },
      length: { type: 'number' as const },
      truncated: { type: 'boolean' as const },
      excerpt: { type: 'string' as const },
      sourceUrl: { type: 'string' as const },
      diagnostics: { type: 'object' as const },
    },
  };
  allowedModes: Array<'plan' | 'act'> = ['plan', 'act'];
  riskLevel: 'low' = 'low';
  requiresApproval = false;
  sideEffects: string[] = [];
  manifest: ToolManifestV2 = {
    name: this.name,
    displayName: '读取创意文档',
    description: '从 creative_document 附件 URL 读取 .md/.txt 正文，供导入预览链路继续分析。',
    whenToUse: ['用户上传 creative_document 附件，并要求拆解/导入/生成项目设定、角色、世界观、大纲或卷纲。'],
    whenNotToUse: ['用户已经在消息中直接粘贴了完整正文，且不需要读取附件。'],
    inputSchema: this.inputSchema,
    outputSchema: this.outputSchema,
    parameterHints: {
      attachment: { source: 'context', description: '优先传入上下文中的第一个创意文档附件对象。', examples: ['{{context.attachments.0}}'] },
      url: { source: 'context', description: '没有传 attachment 时，可使用附件 URL。', examples: ['{{context.attachments.0.url}}'] },
      fileName: { source: 'context', description: '附件文件名，用于识别扩展名和标题。', examples: ['{{context.attachments.0.fileName}}'] },
      extension: { source: 'context', description: '附件扩展名，仅支持 md/txt/docx/pdf；P0 只解析 md/txt。', examples: ['{{context.attachments.0.extension}}'] },
    },
    examples: [
      {
        user: '根据上传的创意文档生成项目设定、角色和卷纲。',
        context: { attachments: [{ kind: 'creative_document', fileName: 'idea.md', extension: 'md', url: 'https://tmpfile.link/example.md' }] },
        plan: [
          { tool: 'read_source_document', args: { attachment: '{{context.attachments.0}}' } },
          { tool: 'analyze_source_text', args: { sourceText: '{{steps.read_source_document.output.sourceText}}' } },
        ],
      },
    ],
    allowedModes: this.allowedModes,
    riskLevel: this.riskLevel,
    requiresApproval: this.requiresApproval,
    sideEffects: this.sideEffects,
  };

  async run(args: ReadSourceDocumentInput, _context: ToolContext): Promise<ReadSourceDocumentOutput> {
    const normalized = this.normalizeInput(args);
    const warnings: string[] = [];

    const response = await this.fetchDocument(normalized.url);
    const rawText = this.normalizeText(await response.text());
    const truncated = rawText.length > MAX_SOURCE_TEXT_LENGTH;
    const sourceText = truncated ? rawText.slice(0, MAX_SOURCE_TEXT_LENGTH) : rawText;
    if (truncated) warnings.push(`正文超过 ${MAX_SOURCE_TEXT_LENGTH} 字符，已截断供 Plan 阶段预览使用。`);
    if (!sourceText.trim()) warnings.push('文档正文为空或仅包含空白字符。');

    return {
      sourceText,
      title: this.titleFromFileName(normalized.fileName),
      fileName: normalized.fileName,
      extension: normalized.extension,
      length: rawText.length,
      truncated,
      excerpt: sourceText.slice(0, EXCERPT_LENGTH),
      sourceUrl: normalized.url,
      diagnostics: {
        fetchStatus: 'succeeded',
        parseStatus: 'succeeded',
        warnings,
      },
    };
  }

  private normalizeInput(args: ReadSourceDocumentInput) {
    const attachment = args.attachment;
    if (attachment?.kind && attachment.kind !== 'creative_document') throw new BadRequestException('read_source_document 只接受 creative_document 附件。');

    const url = this.nonEmptyString(attachment?.url) ?? this.nonEmptyString(args.url);
    if (!url) throw new BadRequestException('read_source_document 需要附件 URL。');
    this.assertHttpsUrl(url);

    const fileName = this.nonEmptyString(attachment?.fileName) ?? this.nonEmptyString(args.fileName);
    const extension = this.normalizeExtension(this.nonEmptyString(attachment?.extension) ?? this.nonEmptyString(args.extension) ?? this.extensionFromFileName(fileName));
    if (!extension) throw new BadRequestException('read_source_document 需要可识别的文件扩展名。');
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new BadRequestException('read_source_document 只支持 md/txt/docx/pdf 附件。');
    if (!TEXT_EXTENSIONS.has(extension)) throw new BadRequestException('P0 暂只支持读取 .md/.txt 创意文档，.docx/.pdf 将在后续任务中支持。');

    return { url, fileName, extension };
  }

  private async fetchDocument(url: string) {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'follow' });
    } catch (error) {
      throw new BadRequestException(`读取创意文档失败：${error instanceof Error ? error.message : '网络请求失败'}`);
    }
    if (!response.ok) throw new BadRequestException(`读取创意文档失败：HTTP ${response.status}`);
    return response;
  }

  private assertHttpsUrl(value: string) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') throw new BadRequestException('read_source_document 只接受 HTTPS URL。');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('read_source_document 需要合法 URL。');
    }
  }

  private nonEmptyString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private normalizeExtension(value?: string): SourceDocumentExtension | undefined {
    const normalized = value?.replace(/^\./, '').toLowerCase();
    return normalized && SUPPORTED_EXTENSIONS.has(normalized as SourceDocumentExtension) ? normalized as SourceDocumentExtension : undefined;
  }

  private extensionFromFileName(fileName?: string) {
    return fileName?.split('.').pop();
  }

  private normalizeText(value: string) {
    return value.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  }

  private titleFromFileName(fileName?: string) {
    return fileName?.replace(/\.[^.]+$/, '').trim() || undefined;
  }
}
