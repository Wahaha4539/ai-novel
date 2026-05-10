import * as http from 'node:http';
import * as https from 'node:https';

export interface LlmHttpResponse {
  status: number;
  bodyText: string;
  streamDiagnostics?: LlmStreamDiagnostics;
}

export interface LlmStreamDiagnostics {
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

export interface LlmStreamProgress extends LlmStreamDiagnostics {
  event: 'headers' | 'chunk' | 'content' | 'done';
  elapsedMs: number;
}

export function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<LlmHttpResponse> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`Unsupported LLM endpoint protocol: ${endpoint.protocol}`);
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const client = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const req = client.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': payload.byteLength,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          finish(() => resolve({ status: res.statusCode ?? 0, bodyText: Buffer.concat(chunks).toString('utf8') }));
        });
        res.on('error', (error) => finish(() => reject(error)));
        res.on('aborted', () => finish(() => reject(new Error('LLM response aborted'))));
      },
    );

    const timeout = setTimeout(() => {
      const error = new Error(`LLM request exceeded ${Math.round(timeoutMs / 1000)}s`);
      error.name = 'TimeoutError';
      req.destroy(error);
    }, timeoutMs);
    timeout.unref?.();

    req.on('error', (error) => finish(() => reject(error)));
    req.write(payload);
    req.end();

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    }
  });
}

export function postJsonStream(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  idleTimeoutMs: number,
  onProgress?: (progress: LlmStreamProgress) => void,
): Promise<LlmHttpResponse> {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error(`Unsupported LLM endpoint protocol: ${endpoint.protocol}`);
  }

  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const client = endpoint.protocol === 'https:' ? https : http;
  const startedAt = Date.now();
  const diagnostics: LlmStreamDiagnostics = {
    streamed: true,
    chunkCount: 0,
    eventCount: 0,
    contentChunkCount: 0,
    streamedContentChars: 0,
    doneReceived: false,
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let resRef: http.IncomingMessage | undefined;
    let rawBody = '';
    let eventBuffer = '';
    let content = '';
    let reasoningContent = '';
    let model: string | undefined;
    let id: unknown;
    let usage: unknown;
    let idleTimedOut = false;

    const req = client.request(
      {
        protocol: endpoint.protocol,
        hostname: endpoint.hostname,
        port: endpoint.port || undefined,
        path: `${endpoint.pathname}${endpoint.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': payload.byteLength,
        },
      },
      (res) => {
        resRef = res;
        emitProgress('headers');
        resetIdleTimer();
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          resetIdleTimer();
          diagnostics.chunkCount += 1;
          const elapsedMs = Date.now() - startedAt;
          diagnostics.firstChunkAtMs ??= elapsedMs;
          diagnostics.lastChunkAtMs = elapsedMs;
          rawBody += chunk;
          diagnostics.rawStreamTail = tail(rawBody);
          emitProgress('chunk');

          if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) return;
          eventBuffer += chunk.replace(/\r\n/g, '\n');
          processBufferedEvents();
        });
        res.on('end', () => {
          processBufferedEvents(true);
          const status = res.statusCode ?? 0;
          const bodyText = status >= 200 && status < 300 && diagnostics.eventCount > 0
            ? JSON.stringify({
              id,
              model,
              usage,
              choices: [{
                finish_reason: diagnostics.finishReason ?? (diagnostics.doneReceived ? 'stop' : undefined),
                message: {
                  content,
                  ...(reasoningContent && !content ? { reasoning_content: reasoningContent } : {}),
                },
              }],
            })
            : rawBody;
          emitProgress('done');
          finish(() => resolve({ status, bodyText, streamDiagnostics: { ...diagnostics } }));
        });
        res.on('error', (error) => finish(() => reject(attachDiagnostics(error))));
        res.on('aborted', () => finish(() => reject(attachDiagnostics(idleTimedOut ? buildIdleTimeoutError() : new Error('LLM response aborted')))));
      },
    );

    resetIdleTimer();
    req.on('error', (error) => finish(() => reject(attachDiagnostics(error))));
    req.write(payload);
    req.end();

    function processBufferedEvents(flush = false) {
      let boundary = eventBuffer.indexOf('\n\n');
      while (boundary >= 0) {
        const eventText = eventBuffer.slice(0, boundary);
        eventBuffer = eventBuffer.slice(boundary + 2);
        handleSseEvent(eventText);
        boundary = eventBuffer.indexOf('\n\n');
      }
      if (flush && eventBuffer.trim()) {
        handleSseEvent(eventBuffer);
        eventBuffer = '';
      }
    }

    function handleSseEvent(eventText: string) {
      const data = eventText
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!data) return;
      diagnostics.eventCount += 1;
      if (data === '[DONE]') {
        diagnostics.doneReceived = true;
        return;
      }

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(data) as unknown;
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
      } catch {
        return;
      }

      if (typeof payload.model === 'string') model = payload.model;
      if (payload.id !== undefined) id = payload.id;
      if (payload.usage !== undefined) usage = payload.usage;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      for (const choiceValue of choices) {
        const choice = choiceValue && typeof choiceValue === 'object' ? choiceValue as Record<string, unknown> : {};
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) diagnostics.finishReason = choice.finish_reason;
        const delta = choice.delta && typeof choice.delta === 'object'
          ? choice.delta as Record<string, unknown>
          : choice.message && typeof choice.message === 'object'
            ? choice.message as Record<string, unknown>
            : {};
        appendDelta(delta.content, 'content');
        appendDelta(delta.reasoning_content ?? delta.reasoningContent, 'reasoning');
      }
    }

    function appendDelta(value: unknown, target: 'content' | 'reasoning') {
      if (typeof value !== 'string' || !value) return;
      if (target === 'content') content += value;
      else reasoningContent += value;
      const combined = content || reasoningContent;
      diagnostics.contentChunkCount += 1;
      diagnostics.streamedContentChars = combined.length;
      diagnostics.contentTail = tail(combined);
      diagnostics.firstContentAtMs ??= Date.now() - startedAt;
      emitProgress('content');
    }

    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        const error = buildIdleTimeoutError();
        req.destroy(error);
        resRef?.destroy(error);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    }

    function buildIdleTimeoutError() {
      const error = new Error(`LLM stream idle timeout after ${Math.round(idleTimeoutMs / 1000)}s without new data`);
      error.name = 'TimeoutError';
      (error as Error & { code?: string }).code = 'LLM_STREAM_IDLE_TIMEOUT';
      return error;
    }

    function emitProgress(event: LlmStreamProgress['event']) {
      onProgress?.({ ...diagnostics, event, elapsedMs: Date.now() - startedAt });
    }

    function attachDiagnostics<T extends Error>(error: T): T {
      (error as T & { streamDiagnostics?: LlmStreamDiagnostics }).streamDiagnostics = { ...diagnostics };
      return error;
    }

    function finish(action: () => void) {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      action();
    }
  });
}

function tail(text: string): string {
  return text.length > 4_000 ? text.slice(-4_000) : text;
}
