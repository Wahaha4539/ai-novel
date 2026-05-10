import type { StructuredLogger } from '../../../common/logging/structured-logger';
import type { LlmChatOptions, LlmChatStreamProgress } from '../../llm/dto/llm-chat.dto';
import type { ToolContext } from '../base-tool';

export const TOOL_STREAM_PHASE_TIMEOUT_GRACE_MS = 30_000;
export const TOOL_STREAM_HEARTBEAT_INTERVAL_MS = 30_000;

export function streamPhaseTimeoutMs(idleTimeoutMs: number): number {
  return idleTimeoutMs + TOOL_STREAM_PHASE_TIMEOUT_GRACE_MS;
}

export function buildToolStreamProgressHeartbeat(options: {
  context: ToolContext;
  logger?: Pick<StructuredLogger, 'warn'>;
  loggerEvent?: string;
  phaseMessage: string;
  idleTimeoutMs: number;
  progressCurrent?: number;
  progressTotal?: number;
  metadata?: Record<string, unknown>;
  heartbeatIntervalMs?: number;
}): LlmChatOptions['onStreamProgress'] | undefined {
  let firstChunkSeen = false;
  let firstContentSeen = false;
  let lastHeartbeatAt = 0;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? TOOL_STREAM_HEARTBEAT_INTERVAL_MS;

  return (progress: LlmChatStreamProgress) => {
    const now = Date.now();
    const isFirstChunk = progress.event === 'chunk' && !firstChunkSeen;
    const isFirstContent = progress.event === 'content' && !firstContentSeen;
    if (isFirstChunk) firstChunkSeen = true;
    if (isFirstContent) firstContentSeen = true;
    const shouldHeartbeat = progress.event === 'headers'
      || isFirstChunk
      || isFirstContent
      || progress.event === 'done'
      || now - lastHeartbeatAt >= heartbeatIntervalMs;
    if (!shouldHeartbeat) return;

    lastHeartbeatAt = now;
    const streamState = progress.event === 'done'
      ? 'stream completed'
      : progress.streamedContentChars > 0
        ? `streaming ${progress.streamedContentChars} chars`
        : 'waiting for stream data';

    void options.context.heartbeat?.({
      phase: 'calling_llm',
      phaseMessage: `${options.phaseMessage} (${streamState})`,
      progressCurrent: options.progressCurrent,
      progressTotal: options.progressTotal,
      timeoutMs: streamPhaseTimeoutMs(options.idleTimeoutMs),
    }).catch((error) => {
      options.logger?.warn(options.loggerEvent ?? 'tool_stream_heartbeat_failed', {
        agentRunId: options.context.agentRunId,
        projectId: options.context.projectId,
        ...(options.metadata ?? {}),
        streamEvent: progress.event,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  };
}
