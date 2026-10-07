/**
 * ============================================================================
 * Environment Setup
 * Configure .env with your enterprise endpoint:
 *
 * LLM_BASE_URL=https://your-llm-service.internal/v1
 * LLM_API_KEY=your-api-key-here
 * LLM_MODEL=gpt-4o
 * LLM_API_TYPE=chat
 * # Optional: custom auth header name (e.g. 'api-key' for Azure, defaults to 'Authorization')
 * # LLM_AUTH_HEADER=Authorization
 * MAX_TURN_TOKENS=4000
 * MAX_TOTAL_CONTEXT_TOKENS=32000
 * AGENT_DEFAULT_SHELL=powershell
 * AGENT_TIMEOUT_MS=60000
 * ============================================================================
 *
 * This file is the single, centralized place to maintain for all
 * custom or special enterprise LLM endpoints, transports, headers, and payload formats.
 */

import fs from 'node:fs';
import path from 'node:path';
import { truncateToTokens } from './tokenizer.js';
import { getCompressionPrompt } from './prompt.js';

export const DEFAULT_LLM_CONFIG = {
  baseUrl: 'https://your-llm-service.internal/v1',
  apiKey: '',
  model: 'gpt-4o',
  api: 'chat', // 'chat' (OpenAI-compatible) or 'rest' (POST /chat/message + POST /chat/generate)
  authHeader: 'Authorization',
  maxTurnTokens: 4000,
  maxTotalTokens: 32000,
  retryDelayMs: 2500,
};

/**
 * Resolves LLM configuration from raw inputs, environment variables, and enterprise defaults.
 */
export function resolveLlmConfig(raw = {}) {
  const apiKey = (raw.apiKey ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? '').trim();
  const baseUrl = raw.baseUrl || process.env.LLM_BASE_URL || DEFAULT_LLM_CONFIG.baseUrl;
  const model = raw.model ?? process.env.LLM_MODEL ?? DEFAULT_LLM_CONFIG.model;
  const apiType = (raw.api || process.env.LLM_API_TYPE || process.env.LLM_API || DEFAULT_LLM_CONFIG.api).toLowerCase();
  const authHeader = raw.authHeader || process.env.LLM_AUTH_HEADER || DEFAULT_LLM_CONFIG.authHeader;
  const maxTurnTokens = parseInt(raw.maxTurnTokens || process.env.MAX_TURN_TOKENS || DEFAULT_LLM_CONFIG.maxTurnTokens, 10);
  const maxTotalTokens = parseInt(raw.maxTotalTokens || process.env.MAX_TOTAL_CONTEXT_TOKENS || DEFAULT_LLM_CONFIG.maxTotalTokens, 10);

  return {
    ...raw,
    baseUrl,
    apiKey,
    model,
    api: apiType,
    authHeader,
    maxTurnTokens,
    maxTotalTokens,
  };
}

const RETRYABLE = [429, 502, 503, 504];
const MAX_ATTEMPTS = 3;

/** Drops empty messages and caps each message at maxTokens, keeping messages separate. */
export function capMessages(messages, maxTokens = 4000) {
  return messages
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({ role: m.role, content: truncateToTokens(m.content, maxTokens) }));
}

export const enforceSeparate4kMessages = capMessages;

/**
 * Builds HTTP headers for LLM requests.
 * If the bearer token / apiKey is empty, leaves out the Authorization header entirely.
 */
export function authHeaders(config) {
  const key = (config?.apiKey || '').trim();
  if (!key || key === 'none') {
    return {}; // Leave out auth header completely when user leaves it empty
  }
  const header = config.authHeader || 'Authorization';
  const isAuth = header.toLowerCase() === 'authorization';
  const headerValue = isAuth && !key.toLowerCase().startsWith('bearer ') ? `Bearer ${key}` : key;
  return { [header]: headerValue };
}

/**
 * Posts JSON payload to endpoint and handles response.
 */
async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${url}${text ? `: ${text.slice(0, 300)}` : ''}`);
    err.status = res.status;
    throw err;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

/**
 * Flexible content extractor supporting standard OpenAI format, REST chat responses, and raw strings.
 */
function extractContent(data) {
  if (typeof data === 'string') return data;
  return (
    data?.choices?.[0]?.message?.content ??
    data?.message?.content ??
    data?.content ??
    data?.reply ??
    JSON.stringify(data)
  );
}

/** OpenAI-compatible: POST {baseUrl}/chat/completions (baseUrl may already be the full endpoint). */
export function chatCompletionsTransport(config) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = /\/chat\/completions(\?|$)/.test(base) ? base : `${base}/chat/completions`;
  return async (messages, temperature) => {
    const body = { messages, temperature };
    if (config.model) body.model = config.model;
    return extractContent(await postJson(url, authHeaders(config), body));
  };
}

/** REST chat API: POST {baseUrl}/chat/message with the messages, then POST {baseUrl}/chat/generate. */
export function restChatTransport(config) {
  const base = config.baseUrl.replace(/\/+$/, '');
  return async (messages, temperature) => {
    await postJson(`${base}/chat/message`, authHeaders(config), { messages });
    return extractContent(await postJson(`${base}/chat/generate`, authHeaders(config), { temperature }));
  };
}

/**
 * Adapter for enterprise REST chat API pattern:
 * POST /chat/message  <- post messages
 * POST /chat/generate <- trigger generation on the messages
 * GET  /chat/messages <- get current message history
 */
export class RestChatApiAdapter {
  constructor(baseUrl, apiKey) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.headers = {
      'Content-Type': 'application/json',
      ...authHeaders({ apiKey, authHeader: 'Authorization' }),
    };
  }

  async postMessages(messages) {
    const list = Array.isArray(messages) ? messages : [messages];
    const payload = capMessages(list, 4000);
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

  async getMessages() {
    const res = await fetch(`${this.baseUrl}/chat/messages`, {
      method: 'GET',
      headers: this.headers,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to GET /chat/messages: HTTP ${res.status} ${errText}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : data.messages || [];
  }

  async generate(temperature = 0.2) {
    const res = await fetch(`${this.baseUrl}/chat/generate`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ temperature }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Failed to POST /chat/generate: HTTP ${res.status} ${errText}`);
    }
    const data = await res.json();
    return extractContent(data);
  }

  async complete(messages, temperature = 0.2) {
    await this.postMessages(messages);
    return this.generate(temperature);
  }
}

/**
 * Main LLM client for code-agent.
 * Manages transports, retry backoff, sliding-window compression, and debug logging.
 */
export class LlmClient {
  constructor(config = {}, transport) {
    this.config = resolveLlmConfig(config);
    if (transport && typeof transport.complete === 'function') {
      this.adapter = transport;
      this.transport = (msgs, temp) => transport.complete(msgs, temp);
    } else {
      this.transport = transport || (this.config.api === 'rest' ? restChatTransport(this.config) : chatCompletionsTransport(this.config));
    }
    this.debugLogPath = this.config.debug
      ? this.config.debugLogPath || path.join(this.config.workspaceDir || process.cwd(), 'agent', 'llm-debug.jsonl')
      : null;
  }

  getAdapter() {
    return this.adapter;
  }

  setAdapter(adapter) {
    this.adapter = adapter;
    this.transport = (msgs, temp) => adapter.complete(msgs, temp);
  }

  logDebug(entry) {
    if (!this.debugLogPath) return;
    try {
      fs.mkdirSync(path.dirname(this.debugLogPath), { recursive: true });
      fs.appendFileSync(this.debugLogPath, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf-8');
    } catch (err) {
      console.error(`[Debug Log Error]: ${err.message}`);
    }
  }

  async complete(messages, temperature = 0.2) {
    const payload = capMessages(messages);
    this.logDebug({ event: 'request', model: this.config.model, temperature, messages: payload });

    for (let attempt = 1; ; attempt++) {
      try {
        const content = await this.transport(payload, temperature);
        if (!content || !String(content).trim()) throw new Error('LLM returned an empty response.');
        this.logDebug({ event: 'response', content });
        return String(content);
      } catch (err) {
        this.logDebug({ event: 'error', attempt, status: err.status, message: err.message });
        if (!RETRYABLE.includes(err.status) || attempt >= MAX_ATTEMPTS) throw err;
        const delayMs = attempt * (this.config.retryDelayMs ?? 2500);
        console.log(`⚠️  [LLM ${err.status}]: retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})...`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async compressHistory(history) {
    const transcript = history.map((m) => `[${m.role.toUpperCase()}]:\n${m.content}`).join('\n\n---\n\n');
    return this.complete(
      [
        { role: 'system', content: getCompressionPrompt() },
        { role: 'user', content: `Here is the conversation history to condense:\n\n${transcript}` },
      ],
      0.1
    );
  }
}
