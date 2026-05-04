import {
  AGENT_CREATIVE_DOCUMENT_EXTENSIONS,
  AgentCreativeDocumentAttachment,
  AgentCreativeDocumentExtension,
} from '../types/agent-attachment';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://127.0.0.1:3001/api';

export const CREATIVE_DOCUMENT_UPLOAD_ENDPOINT = `${API_BASE}/uploads/creative-document`;
export const CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
export const CREATIVE_DOCUMENT_ACCEPT = [
  '.md',
  '.txt',
  '.docx',
  '.pdf',
  'text/markdown',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/pdf',
].join(',');

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isAgentCreativeDocumentExtension(value: string): value is AgentCreativeDocumentExtension {
  return AGENT_CREATIVE_DOCUMENT_EXTENSIONS.includes(value.toLowerCase() as AgentCreativeDocumentExtension);
}

export function getCreativeDocumentExtension(fileName: string): AgentCreativeDocumentExtension | null {
  const extension = fileName.split('.').pop()?.toLowerCase();
  return extension && isAgentCreativeDocumentExtension(extension) ? extension : null;
}

function createAttachmentId() {
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  return `att_${randomId}`;
}

function readPath(source: JsonRecord, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function readString(source: JsonRecord, paths: string[][]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function readNumber(source: JsonRecord, paths: string[][]) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function extractUploadUrl(payload: JsonRecord) {
  return readString(payload, [
    ['data', 'url'],
    ['data', 'downloadLinkEncoded'],
    ['data', 'downloadLink'],
    ['data', 'downloadUrl'],
    ['data', 'download_url'],
    ['data', 'link'],
    ['data', 'fileUrl'],
    ['data', 'file_url'],
    ['data', 'file', 'url'],
    ['url'],
    ['downloadLinkEncoded'],
    ['downloadLink'],
    ['downloadUrl'],
    ['download_url'],
    ['link'],
    ['fileUrl'],
    ['file_url'],
    ['file', 'url'],
  ]);
}

function extractErrorMessage(payload: unknown, fallback: string) {
  if (!isRecord(payload)) return fallback;
  return readString(payload, [
    ['message'],
    ['msg'],
    ['error'],
    ['data', 'message'],
    ['data', 'msg'],
    ['data', 'error'],
  ]) ?? fallback;
}

async function readUploadPayload(response: Response) {
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
    throw new Error(extractErrorMessage(payload, `创意文档上传失败，请稍后重试（HTTP ${response.status}）。`));
  }
  if (!isRecord(payload)) {
    throw new Error('创意文档上传失败：临时文件服务返回了无法识别的数据。');
  }
  return payload;
}

function normalizeTmpfileResponse(file: File, payload: JsonRecord, extension: AgentCreativeDocumentExtension): AgentCreativeDocumentAttachment {
  const url = extractUploadUrl(payload);
  if (!url) {
    throw new Error('创意文档上传失败：临时文件服务没有返回下载链接。');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('创意文档上传失败：临时文件服务返回的下载链接无效。');
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('创意文档上传失败：临时文件服务返回的下载链接不是 HTTPS。');
  }

  return {
    id: readString(payload, [['data', 'id'], ['id']]) ?? createAttachmentId(),
    kind: 'creative_document',
    provider: 'tmpfile.link',
    fileName: file.name,
    extension,
    mimeType: readString(payload, [
      ['data', 'mimeType'],
      ['data', 'mimetype'],
      ['data', 'type'],
      ['mimeType'],
      ['mimetype'],
      ['type'],
    ]) ?? file.type,
    size: readNumber(payload, [['data', 'size'], ['size']]) ?? file.size,
    url,
    uploadedAt: new Date().toISOString(),
    expiresAt: readString(payload, [
      ['data', 'expiresAt'],
      ['data', 'expireAt'],
      ['data', 'expiredAt'],
      ['expiresAt'],
      ['expireAt'],
      ['expiredAt'],
    ]),
    uploadMeta: payload,
  };
}

export async function uploadCreativeDocument(file: File): Promise<AgentCreativeDocumentAttachment> {
  const extension = getCreativeDocumentExtension(file.name);
  if (!extension) {
    throw new Error('仅支持导入 .md、.txt、.docx、.pdf 格式的创意文档。');
  }

  if (file.size > CREATIVE_DOCUMENT_MAX_UPLOAD_SIZE_BYTES) {
    throw new Error('创意文档不能超过 20MB，请压缩或拆分后再导入。');
  }

  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(CREATIVE_DOCUMENT_UPLOAD_ENDPOINT, {
    method: 'POST',
    body: formData,
  });
  const payload = await readUploadPayload(response);
  return normalizeTmpfileResponse(file, payload, extension);
}
