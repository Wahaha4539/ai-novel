export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatOptions {
  appStep?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  tools?: unknown[];
  jsonMode?: boolean;
}

export interface LlmChatResult {
  text: string;
  model: string;
  usage?: Record<string, number>;
  elapsedMs?: number;
  rawPayloadSummary: Record<string, unknown>;
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
