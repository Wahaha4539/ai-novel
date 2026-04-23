import { Injectable } from '@nestjs/common';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
}

@Injectable()
export class LlmService {

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor() {
    this.baseUrl = process.env.LLM_BASE_URL ?? 'http://localhost:8318/v1';
    this.apiKey = process.env.LLM_API_KEY ?? '';
    this.model = process.env.LLM_MODEL ?? 'gpt-5.4';
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    if (!this.apiKey) {
      throw new Error('缺少 LLM_API_KEY，无法调用 AI');
    }

    const url = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = JSON.stringify({
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.8,
      max_tokens: options?.maxTokens ?? 2000,
    });

    const t0 = Date.now();
    const msgPreview = messages.map((m) => `[${m.role}](${m.content.length}ch)`).join(' ');
    console.log(`[LLM] → ${this.model} msgs=${messages.length} temp=${options?.temperature ?? 0.8} ${msgPreview} body=${body}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`LLM 请求失败: ${response.status} ${detail.slice(0, 500)}`);
    }

    const payload = await response.json();
    const text = this.extractText(payload);

    if (!text) {
      throw new Error(`LLM 返回内容为空: ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const usage = payload.usage as Record<string, number> | undefined;
    const tokens = usage ? `in=${usage.prompt_tokens ?? '?'} out=${usage.completion_tokens ?? '?'}` : '';
    console.log(`[LLM] ← ${text.length}ch ${elapsed}s ${tokens}`);
    return text;
  }

  private extractText(payload: Record<string, unknown>): string {
    const choices = payload.choices as Array<Record<string, unknown>> | undefined;
    if (!choices?.length) return '';

    const message = choices[0].message as Record<string, unknown> | undefined;
    if (!message) return '';

    const content = message.content;
    if (typeof content === 'string') return content;

    if (Array.isArray(content)) {
      return content
        .filter(
          (item: Record<string, unknown>) =>
            typeof item === 'object' &&
            (item.type === 'text' || item.type === 'output_text') &&
            typeof item.text === 'string',
        )
        .map((item: Record<string, unknown>) => item.text as string)
        .join('');
    }

    return '';
  }
}
