import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';

export const CREATIVE_DOCUMENT_UPLOAD_ENDPOINT = 'https://tmpfile.link/api/upload';
export const CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;

type CreativeDocumentExtension = 'md' | 'txt' | 'docx' | 'pdf';
type JsonRecord = Record<string, unknown>;

export interface UploadedCreativeDocumentFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const CREATIVE_DOCUMENT_EXTENSIONS = new Set<CreativeDocumentExtension>(['md', 'txt', 'docx', 'pdf']);

@Injectable()
export class UploadsService {
  async uploadCreativeDocument(file: UploadedCreativeDocumentFile) {
    this.assertSupportedCreativeDocument(file);

    const fileName = this.normalizeOriginalName(file.originalname);
    const formData = new FormData();
    const uploadFile = new Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
    formData.append('file', uploadFile, fileName);

    let response: Response;
    try {
      response = await fetch(CREATIVE_DOCUMENT_UPLOAD_ENDPOINT, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw new BadGatewayException(`临时文件服务上传失败：${error instanceof Error ? error.message : '网络请求失败'}`);
    }

    const payload = await this.readUploadPayload(response);
    return { ...payload, fileName };
  }

  private assertSupportedCreativeDocument(file: UploadedCreativeDocumentFile) {
    if (file.size > CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES) {
      throw new BadRequestException('创意文档不能超过 20MB，请压缩或拆分后再导入。');
    }

    const extension = this.extensionFromFileName(file.originalname);
    if (!extension || !CREATIVE_DOCUMENT_EXTENSIONS.has(extension)) {
      throw new BadRequestException('仅支持导入 .md、.txt、.docx、.pdf 格式的创意文档。');
    }
  }

  private async readUploadPayload(response: Response): Promise<JsonRecord> {
    const text = await response.text();
    let payload: unknown = {};

    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }

    if (!response.ok) {
      const message = this.extractErrorMessage(payload, `临时文件服务上传失败：HTTP ${response.status}`);
      throw new BadGatewayException(message);
    }
    if (!this.isRecord(payload)) {
      throw new BadGatewayException('临时文件服务返回了无法识别的数据。');
    }
    return payload;
  }

  private extractErrorMessage(payload: unknown, fallback: string) {
    if (!this.isRecord(payload)) return fallback;
    for (const key of ['message', 'msg', 'error']) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return fallback;
  }

  private normalizeOriginalName(fileName: string) {
    if (/[ÃÂ]|(?:ä|å|ç|è|é|æ|ã|ï)[\u0080-\u00ff]/.test(fileName)) {
      const decoded = Buffer.from(fileName, 'latin1').toString('utf8');
      if (decoded && !decoded.includes('\uFFFD')) return decoded;
    }
    return fileName;
  }

  private extensionFromFileName(fileName: string): CreativeDocumentExtension | undefined {
    const extension = fileName.split('.').pop()?.toLowerCase();
    return extension && CREATIVE_DOCUMENT_EXTENSIONS.has(extension as CreativeDocumentExtension)
      ? extension as CreativeDocumentExtension
      : undefined;
  }

  private isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }
}
