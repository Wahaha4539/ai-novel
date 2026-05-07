const ALLOWED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'max', 'xhigh']);
const ALLOWED_THINKING_TYPES = new Set(['enabled', 'disabled']);

/**
 * Build provider-level chat/completions parameters that are safe to merge into
 * every request. Per-call controls such as max_tokens stay owned by callers.
 */
export function buildProviderChatParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const reasoningEffort = normalizeReasoningEffort(params.reasoning_effort ?? params.reasoningEffort);
  const thinking = normalizeThinking(params.thinking);

  if (reasoningEffort) output.reasoning_effort = reasoningEffort;
  if (thinking) output.thinking = thinking;

  return output;
}

function normalizeReasoningEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ALLOWED_REASONING_EFFORTS.has(normalized) ? normalized : undefined;
}

function normalizeThinking(value: unknown): { type: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const type = (value as Record<string, unknown>).type;
  if (typeof type !== 'string') return undefined;
  const normalized = type.trim().toLowerCase();
  return ALLOWED_THINKING_TYPES.has(normalized) ? { type: normalized } : undefined;
}
