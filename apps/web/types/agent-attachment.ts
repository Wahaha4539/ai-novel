export const AGENT_CREATIVE_DOCUMENT_EXTENSIONS = ['md', 'txt', 'docx', 'pdf'] as const;

export type AgentCreativeDocumentExtension = (typeof AGENT_CREATIVE_DOCUMENT_EXTENSIONS)[number];

export interface AgentCreativeDocumentAttachment {
  id: string;
  kind: 'creative_document';
  provider: 'tmpfile.link';
  fileName: string;
  extension: AgentCreativeDocumentExtension;
  mimeType?: string;
  size?: number;
  url: string;
  uploadedAt: string;
  expiresAt?: string;
  uploadMeta?: Record<string, unknown>;
}

