import type { LlmChatResult } from '../../llm/dto/llm-chat.dto';
import type { ToolContext, ToolLlmUsage } from '../base-tool';

export function recordToolLlmUsage(context: ToolContext, appStep: string, result?: Partial<LlmChatResult> | null) {
  if (!context.recordLlmUsage || !result) return;
  context.recordLlmUsage({
    appStep,
    ...(typeof result.model === 'string' && result.model.trim() ? { model: result.model.trim() } : {}),
    ...(isNumberRecord(result.usage) ? { usage: result.usage } : {}),
    ...(isRecord(result.rawPayloadSummary) ? { rawPayloadSummary: result.rawPayloadSummary } : {}),
    ...(typeof result.elapsedMs === 'number' && Number.isFinite(result.elapsedMs) ? { elapsedMs: Math.max(0, Math.round(result.elapsedMs)) } : {}),
  });
}

function isNumberRecord(value: unknown): value is NonNullable<ToolLlmUsage['usage']> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
