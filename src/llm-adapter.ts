import { ChatMessage, AgentConfig } from './types.js';
import { truncateToTokens } from './tokenizer.js';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as path from 'path';
import { getCompressionPrompt } from './prompt.js';

export interface LlmAdapter {
  complete(messages: ChatMessage[], temperature?: number): Promise<string>;
  compressHistory?(history: ChatMessage[]): Promise<string>;
}

/**
 * Normalizes messages so that:
 * 1. Harness, AGENTS.md, and each loop message remain strictly separate messages (no merging).
 * 2. Every individual message is capped at max 4,000 tokens.
 */
export function enforceSeparate4kMessages(
  messages: ChatMessage[],
  maxTokensPerMessage: number = 4000
): ChatMessage[] {
  const result: ChatMessage[] = [];

  for (const msg of messages) {
    if (!msg.content || !msg.content.trim()) continue;

    // Truncate individual message content to 4000 tokens
    const cappedContent = truncateToTokens(msg.content, maxTokensPerMessage);

    result.push({
      role: msg.role,
      content: cappedContent,
    });
  }

  return result;
}

/**
 * OpenAI / OpenRouter / Gemini API adapter implementing LlmAdapter
 */
export class OpenAiLlmAdapter implements LlmAdapter {
  private client: OpenAI;
  private model: string;
  private debug: boolean;
  private debugLogPath?: string;

  constructor(config: AgentConfig) {
    this.model = config.model;
    this.debug = !!config.debug;
    this.debugLogPath =
      config.debugLogPath ||
      (this.debug ? path.join(config.workspaceDir, 'agent', 'openrouter-debug.jsonl') : undefined);

    const apiKey =
      config.apiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      process.env.OPENAI_API_KEY ||
      '';

    if (!apiKey) {
      throw new Error(
        'Missing API key. Set GEMINI_API_KEY, OPENROUTER_API_KEY, or LLM_API_KEY in environment or .env file.'
      );
    }

    this.client = new OpenAI({
      baseURL: config.baseUrl || 'https://openrouter.ai/api/v1',
      apiKey: apiKey,
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/code-agent',
        'X-Title': 'Pi Code Agent',
      },
    });

    if (this.debug && this.debugLogPath) {
      const dir = path.dirname(this.debugLogPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  public logDebug(entry: Record<string, any>): void {
    if (this.debug && this.debugLogPath) {
      try {
        const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
        fs.appendFileSync(this.debugLogPath, line, 'utf-8');
      } catch (err: any) {
        console.error(`[Debug Log Error]: ${err.message}`);
      }
    }
  }

  public async complete(messages: ChatMessage[], temperature: number = 0.2): Promise<string> {
    const separateMessages = enforceSeparate4kMessages(messages, 4000);

    this.logDebug({
      event: 'request',
      model: this.model,
      temperature,
      messages: separateMessages,
    });

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        if (this.debug) {
          const stream = await this.client.chat.completions.create({
            model: this.model,
            messages: separateMessages,
            temperature,
            stream: true,
          });

          let fullContent = '';
          for await (const chunk of stream) {
            this.logDebug({
              event: 'stream_chunk',
              chunk,
            });
            const delta = chunk.choices[0]?.delta?.content || '';
            fullContent += delta;
          }

          this.logDebug({
            event: 'response_complete',
            model: this.model,
            content: fullContent,
          });

          if (!fullContent) {
            throw new Error('LLM returned an empty response.');
          }

          return fullContent;
        }

        const response = await this.client.chat.completions.create({
          model: this.model,
          messages: separateMessages,
          temperature,
        });

        const choice = response.choices[0];
        if (!choice || !choice.message || !choice.message.content) {
          throw new Error('LLM returned an empty response.');
        }

        return choice.message.content;
      } catch (err: any) {
        attempt++;
        const isRateLimit = err?.status === 429 || /429|rate limit|quota/i.test(err?.message || '');
        const isTransientServer = err?.status === 502 || err?.status === 503;

        if ((isRateLimit || isTransientServer) && attempt < maxRetries) {
          const delayMs = attempt * 2500;
          console.log(`⚠️  [LLM ${err?.status || 'Throttled'}]: Backing off ${delayMs / 1000}s before retry (attempt ${attempt}/${maxRetries})...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw err;
      }
    }

    throw new Error('LLM request failed after maximum retries.');
  }

  public async compressHistory(history: ChatMessage[]): Promise<string> {
    this.logDebug({
      event: 'compression_start',
      historyCount: history.length,
    });

    const summaryMessages: ChatMessage[] = [
      {
        role: 'system',
        content: getCompressionPrompt(),
      },
      {
        role: 'user',
        content:
          `Here is the conversation history to condense:\n\n` +
          history.map((m) => `[${m.role.toUpperCase()}]:\n${m.content}`).join('\n\n---\n\n'),
      },
    ];

    const result = await this.complete(summaryMessages, 0.1);

    this.logDebug({
      event: 'compression_complete',
      summary: result,
    });

    return result;
  }
}

/**
 * Adapter that interacts with the custom Chat API pattern:
 * POST /chat/message  <- post messages
 * POST /chat/generate <- trigger generation on the messages
 * GET  /chat/messages <- get the messages
 */
export class RestChatApiAdapter implements LlmAdapter {
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
  }

  /**
   * POST /chat/message
   * Posts single message or multiple messages
   */
  public async postMessages(messages: ChatMessage | ChatMessage[]): Promise<void> {
    const list = Array.isArray(messages) ? messages : [messages];
    const payload = enforceSeparate4kMessages(list, 4000);

    const res = await fetch(`${this.baseUrl}/chat/message`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ messages: payload }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to POST /chat/message: HTTP ${res.status} ${errText}`);
    }
  }

  /**
   * GET /chat/messages
   * Retrieves current conversation messages
   */
  public async getMessages(): Promise<ChatMessage[]> {
    const res = await fetch(`${this.baseUrl}/chat/messages`, {
      method: 'GET',
      headers: this.headers,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to GET /chat/messages: HTTP ${res.status} ${errText}`);
    }

    const data: any = await res.json();
    return Array.isArray(data) ? data : data.messages || [];
  }

  /**
   * POST /chat/generate
   * Triggers generation on the posted messages
   */
  public async generate(temperature?: number): Promise<string> {
    const res = await fetch(`${this.baseUrl}/chat/generate`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ temperature }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to POST /chat/generate: HTTP ${res.status} ${errText}`);
    }

    const data: any = await res.json();
    if (typeof data === 'string') return data;
    if (data.content) return data.content;
    if (data.reply) return data.reply;
    if (data.message?.content) return data.message.content;
    if (data.choices?.[0]?.message?.content) return data.choices[0].message.content;
    return JSON.stringify(data);
  }

  /**
   * Full completion flow:
   * 1. Post separate messages (each max 4000 tokens) via POST /chat/message
   * 2. Trigger generation via POST /chat/generate
   */
  public async complete(messages: ChatMessage[], temperature: number = 0.2): Promise<string> {
    const separate = enforceSeparate4kMessages(messages, 4000);
    await this.postMessages(separate);
    return this.generate(temperature);
  }
}
