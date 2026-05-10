export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  appStep?: string;
  temperature?: number;
  /** Kept for older call sites and diagnostics; the gateway no longer sends max_tokens. */
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Use OpenAI-compatible SSE streaming. Streaming keeps the request alive while
   * chunks continue to arrive; streamIdleTimeoutMs is the no-progress timeout.
   */
  stream?: boolean;
  streamIdleTimeoutMs?: number;
  onStreamProgress?: (progress: LlmChatStreamProgress) => void | Promise<void>;
  retries?: number;
  tools?: unknown[];
  jsonMode?: boolean;
  jsonSchema?: {
    name: string;
    description?: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface LlmChatStreamProgress {
  event: 'headers' | 'chunk' | 'content' | 'done';
  elapsedMs: number;
  streamed: boolean;
  chunkCount: number;
  eventCount: number;
  contentChunkCount: number;
  streamedContentChars: number;
  firstChunkAtMs?: number;
  firstContentAtMs?: number;
  lastChunkAtMs?: number;
  doneReceived: boolean;
  finishReason?: unknown;
  contentTail?: string;
  rawStreamTail?: string;
}

export type LlmChatStreamDiagnostics = Omit<LlmChatStreamProgress, 'event' | 'elapsedMs'>;

export interface LlmChatResult {
  text: string;
  model: string;
  usage?: Record<string, number>;
  elapsedMs?: number;
  rawPayloadSummary: Record<string, unknown>;
  streamDiagnostics?: LlmChatStreamDiagnostics;
}

export interface LlmEmbeddingOptions {
  appStep?: string;
  timeoutMs?: number;
  retries?: number;
}

export interface LlmEmbeddingResult {
  vectors: number[][];
  model: string;
  usage?: Record<string, number>;
  rawPayloadSummary: Record<string, unknown>;
}
