import * as http from 'node:http';
import * as https from 'node:https';

export interface LlmHttpResponse {
  status: number;
  bodyText: string;
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
