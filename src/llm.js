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
import { truncateToTokens, estimateMessagesTokens } from './tokenizer.js';
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
 * Sanitizes headers for safe debug logging (masks secrets, tokens, and passwords).
 */
export function sanitizeHeaders(headers = {}) {
  const sanitized = {};
  for (const [k, v] of Object.entries(headers)) {
    if (/authorization|api-key|key|token|secret/i.test(k) && typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed.length > 14) {
        sanitized[k] = `${trimmed.slice(0, 7)}...${trimmed.slice(-4)} (${trimmed.length} chars)`;
      } else if (trimmed.length > 0) {
        sanitized[k] = `[PRESENT: ${trimmed.length} chars]`;
      } else {
        sanitized[k] = '[OMITTED/EMPTY]';
      }
    } else {
      sanitized[k] = v;
    }
  }
  return sanitized;
}

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
 * Parses URL into components for diagnostic reporting.
 */
export function parseUrlDetails(urlStr) {
  try {
    const parsed = new URL(urlStr);
    return {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
      pathname: parsed.pathname,
      search: parsed.search || '',
      isPlaceholder: parsed.hostname === 'your-llm-service.internal' || (urlStr || '').includes('your-llm-service.internal'),
    };
  } catch {
    return {
      protocol: null,
      hostname: null,
      port: null,
      pathname: null,
      search: '',
      isPlaceholder: (urlStr || '').includes('your-llm-service.internal'),
    };
  }
}

/**
 * Unwinds the cause chain of an error (e.g., undici/fetch wrap around dns/tcp errors).
 */
export function extractCauseChain(err) {
  const causes = [];
  let current = err?.cause;
  let depth = 0;
  while (current && depth < 5) {
    causes.push({
      message: current.message || String(current),
      code: current.code || null,
      errno: current.errno || null,
      syscall: current.syscall || null,
      hostname: current.hostname || null,
      address: current.address || null,
      port: current.port || null,
    });
    current = current.cause;
    depth++;
  }
  return causes;
}

/**
 * Gathers relevant system environment diagnostics for network troubleshooting.
 */
export function buildEnvDiagnostics() {
  return {
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    http_proxy: process.env.HTTP_PROXY || process.env.http_proxy || null,
    https_proxy: process.env.HTTPS_PROXY || process.env.https_proxy || null,
    no_proxy: process.env.NO_PROXY || process.env.no_proxy || null,
    all_proxy: process.env.ALL_PROXY || process.env.all_proxy || null,
    extra_ca_certs: process.env.NODE_EXTRA_CA_CERTS || null,
    tls_reject_unauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED || null,
  };
}

/**
 * Classifies error into standard categories for quick diagnostic recognition.
 */
export function classifyError(err, status = null) {
  const code = err?.code || err?.cause?.code || '';
  const msg = `${err?.message || ''} ${err?.cause?.message || ''}`;

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'DNS_RESOLUTION_FAILURE';
  }
  if (code === 'ECONNREFUSED') {
    return 'CONNECTION_REFUSED';
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(msg)) {
    return 'CONNECTION_TIMEOUT';
  }
  if (/CERT_|DEPTH_ZERO|UNABLE_TO_VERIFY|self-signed/i.test(code || msg)) {
    return 'TLS_SSL_CERTIFICATE_ERROR';
  }
  if (status === 401 || status === 403) {
    return 'HTTP_AUTH_FAILURE';
  }
  if (status === 404) {
    return 'HTTP_NOT_FOUND';
  }
  if (status === 429) {
    return 'HTTP_RATE_LIMITED';
  }
  if (status >= 500) {
    return 'HTTP_SERVER_ERROR';
  }
  if (status >= 400) {
    return 'HTTP_CLIENT_ERROR';
  }
  if (msg.includes('empty response')) {
    return 'EMPTY_RESPONSE';
  }
  return 'NETWORK_FAILURE';
}

/**
 * Derives comprehensive troubleshooting diagnosis, checklists, and ready-to-run test commands.
 */
export function getTroubleshootingDetails(err, url = '', config = {}) {
  const status = err.status ?? null;
  const category = classifyError(err, status);
  const urlInfo = parseUrlDetails(url);
  const hostname = urlInfo.hostname || 'your-llm-service.internal';
  const port = urlInfo.port || '443';

  let hint = '';
  const checklist = [];
  const testCommands = {};

  if (urlInfo.isPlaceholder) {
    hint = `LLM_BASE_URL is still configured with the default placeholder '${hostname}'. Please update your .env file with your actual enterprise LLM endpoint URL.`;
    checklist.push(`Edit .env and set LLM_BASE_URL to your corporate endpoint (e.g. LLM_BASE_URL=https://corp-llm.company.internal/v1)`);
    checklist.push(`Provide a valid Bearer token when prompted, or configure LLM_API_KEY in .env`);
  } else if (category === 'DNS_RESOLUTION_FAILURE') {
    hint = `Hostname '${hostname}' could not be resolved by DNS. Check your VPN, corporate proxy, or spelling in LLM_BASE_URL.`;
    checklist.push(`Verify spelling of LLM_BASE_URL in .env: '${url}'`);
    checklist.push(`Test DNS resolution in PowerShell: Resolve-DnsName ${hostname}`);
    checklist.push(`If on corporate network, verify you are connected to the corporate VPN`);
    checklist.push(`If a corporate proxy is required, set HTTP_PROXY and HTTPS_PROXY environment variables`);
    testCommands.powershell_dns = `Resolve-DnsName ${hostname}`;
  } else if (category === 'CONNECTION_REFUSED') {
    hint = `Connection was refused at '${hostname}:${port}'. Ensure the LLM gateway or local proxy is running and listening on port ${port}.`;
    checklist.push(`Verify the target server/proxy is running and listening on port ${port}`);
    checklist.push(`Test port connectivity in PowerShell: Test-NetConnection -ComputerName ${hostname} -Port ${port}`);
    checklist.push(`Confirm the port number in LLM_BASE_URL`);
    testCommands.powershell_test_net = `Test-NetConnection -ComputerName ${hostname} -Port ${port}`;
  } else if (category === 'CONNECTION_TIMEOUT') {
    hint = `Connection timed out reaching '${hostname}:${port}'. Check corporate firewall rules, network proxy, or slow network routes.`;
    checklist.push(`Check corporate firewall rules for outbound connections to port ${port}`);
    checklist.push(`Verify proxy configuration (HTTP_PROXY / HTTPS_PROXY)`);
    checklist.push(`Increase AGENT_TIMEOUT_MS in .env (current default is 60000ms)`);
  } else if (category === 'TLS_SSL_CERTIFICATE_ERROR') {
    hint = `TLS/SSL certificate validation failed. In corporate environments with SSL decryption/inspection, configure NODE_EXTRA_CA_CERTS pointing to your corporate root certificate.`;
    checklist.push(`Export corporate root CA certificate to a .pem file (e.g. C:\\certs\\corporate-ca.pem)`);
    checklist.push(`Set environment variable: $env:NODE_EXTRA_CA_CERTS = "C:\\certs\\corporate-ca.pem"`);
    checklist.push(`Or set NODE_EXTRA_CA_CERTS in your .env file`);
  } else if (category === 'HTTP_AUTH_FAILURE') {
    hint = `Authentication failed (HTTP ${status}). The API key / Bearer token was rejected by the server.`;
    checklist.push(`Verify the Bearer token entered at startup or in LLM_API_KEY is valid and not expired`);
    checklist.push(`Check if your enterprise API expects a different auth header (e.g. LLM_AUTH_HEADER=api-key)`);
    checklist.push(`If leaving token empty, verify whether the endpoint permits unauthenticated access`);
  } else if (category === 'HTTP_NOT_FOUND') {
    hint = `Endpoint path was not found (HTTP 404) at '${url}'. Check the URL path and API mode.`;
    checklist.push(`For OpenAI-compatible endpoints, verify if '/v1' or '/v1/chat/completions' is required in LLM_BASE_URL`);
    checklist.push(`If your server uses enterprise REST (/chat/message + /chat/generate), set LLM_API_TYPE=rest in .env`);
  } else if (category === 'HTTP_RATE_LIMITED') {
    hint = `Rate limit or quota exceeded (HTTP 429). The model is throttled or tokens/credits are exhausted.`;
    checklist.push(`Wait a few moments for rate limits to reset`);
    checklist.push(`Check quota or tier limits on your enterprise LLM gateway`);
  } else if (category === 'HTTP_SERVER_ERROR') {
    hint = `Remote server error (HTTP ${status}). The upstream LLM provider encountered an internal failure.`;
    checklist.push(`Check remote LLM service status and health logs`);
    checklist.push(`Retry the request after a short interval`);
  } else {
    hint = `Network or request failure calling '${url}': ${err.message}`;
    checklist.push(`Review error message and stack trace in agent/llm-debug.jsonl`);
    checklist.push(`Verify network connectivity to the endpoint`);
  }

  const authVal = config.apiKey ? (config.apiKey.length > 20 ? `${config.apiKey.slice(0, 7)}...` : '<TOKEN>') : null;
  const authHeaderParam = authVal ? ` -H "${config.authHeader || 'Authorization'}: Bearer ${authVal}"` : '';

  testCommands.curl = `curl.exe -v -X POST "${url}" -H "Content-Type: application/json"${authHeaderParam} -d "{\\"model\\":\\"${config.model || 'gpt-4o'}\\",\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"ping\\"}]}"`;

  testCommands.powershell = `Invoke-RestMethod -Uri "${url}" -Method Post -Headers @{ "Content-Type" = "application/json"${authVal ? `; "${config.authHeader || 'Authorization'}" = "Bearer ${authVal}"` : ''} } -Body '{"model":"${config.model || 'gpt-4o'}","messages":[{"role":"user","content":"ping"}]}'`;

  return {
    category,
    hint,
    checklist,
    testCommands,
  };
}

/**
 * Derives actionable troubleshooting guidance based on network error codes or HTTP status.
 */
export function getTroubleshootingHint(err, url = '', config = {}) {
  return getTroubleshootingDetails(err, url, config).hint;
}

/**
 * Posts JSON payload to endpoint with latency tracking and detailed error capture.
 */
async function postJson(url, headers, body, onDebug = null, config = {}) {
  const startTime = Date.now();
  const requestHeaders = { 'Content-Type': 'application/json', ...headers };
  const bodyString = typeof body === 'string' ? body : JSON.stringify(body);
  const urlInfo = parseUrlDetails(url);

  if (onDebug) {
    onDebug({
      event: 'http_request',
      url,
      method: 'POST',
      headers: sanitizeHeaders(requestHeaders),
      body_bytes: Buffer.byteLength(bodyString, 'utf-8'),
    });
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: requestHeaders,
      body: bodyString,
    });
  } catch (netErr) {
    const durationMs = Date.now() - startTime;
    const causeChain = extractCauseChain(netErr);
    const primaryCause = causeChain[0] || {};
    const causeCode = primaryCause.code || netErr.code || 'NETWORK_ERROR';
    const causeMsg = primaryCause.message || netErr.message;
    const details = `${causeCode}${causeMsg && causeMsg !== causeCode ? `: ${causeMsg}` : ''}`;

    const diag = getTroubleshootingDetails(netErr, url, config);

    const enrichedErr = new Error(`Network failure calling ${url}: ${netErr.message} (${details})`);
    enrichedErr.name = netErr.name || 'NetworkError';
    enrichedErr.originalError = netErr;
    enrichedErr.url = url;
    enrichedErr.urlInfo = urlInfo;
    enrichedErr.durationMs = durationMs;
    enrichedErr.code = causeCode;
    enrichedErr.cause = netErr.cause;
    enrichedErr.causeChain = causeChain;
    enrichedErr.category = diag.category;
    enrichedErr.troubleshootingHint = diag.hint;
    enrichedErr.troubleshootingChecklist = diag.checklist;
    enrichedErr.diagnosticCommands = diag.testCommands;
    enrichedErr.requestHeaders = sanitizeHeaders(requestHeaders);
    throw enrichedErr;
  }

  const durationMs = Date.now() - startTime;
  const text = await res.text();

  if (!res.ok) {
    const responseHeadersObj = {};
    try {
      res.headers.forEach((v, k) => { responseHeadersObj[k] = v; });
    } catch {}

    const diag = getTroubleshootingDetails({ status: res.status, message: res.statusText }, url, config);

    const httpErr = new Error(`HTTP ${res.status} ${res.statusText || ''} from ${url}${text ? `: ${text.slice(0, 500)}` : ''}`);
    httpErr.name = 'HttpError';
    httpErr.status = res.status;
    httpErr.statusText = res.statusText;
    httpErr.url = url;
    httpErr.urlInfo = urlInfo;
    httpErr.durationMs = durationMs;
    httpErr.responseHeaders = responseHeadersObj;
    httpErr.responseBody = text;
    httpErr.requestHeaders = sanitizeHeaders(requestHeaders);
    httpErr.category = diag.category;
    httpErr.troubleshootingHint = diag.hint;
    httpErr.troubleshootingChecklist = diag.checklist;
    httpErr.diagnosticCommands = diag.testCommands;
    throw httpErr;
  }

  if (onDebug) {
    onDebug({
      event: 'http_response',
      url,
      status: res.status,
      duration_ms: durationMs,
      response_bytes: Buffer.byteLength(text, 'utf-8'),
    });
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
export function chatCompletionsTransport(config, onDebug = null) {
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = /\/chat\/completions(\?|$)/.test(base) ? base : `${base}/chat/completions`;
  return async (messages, temperature) => {
    const body = { messages, temperature };
    if (config.model) body.model = config.model;
    return extractContent(await postJson(url, authHeaders(config), body, onDebug, config));
  };
}

/** REST chat API: POST {baseUrl}/chat/message with the messages, then POST {baseUrl}/chat/generate. */
export function restChatTransport(config, onDebug = null) {
  const base = config.baseUrl.replace(/\/+$/, '');
  return async (messages, temperature) => {
    await postJson(`${base}/chat/message`, authHeaders(config), { messages }, onDebug, config);
    return extractContent(await postJson(`${base}/chat/generate`, authHeaders(config), { temperature }, onDebug, config));
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
    this.debugLogPath = this.config.debug
      ? this.config.debugLogPath || path.join(this.config.workspaceDir || process.cwd(), 'agent', 'llm-debug.jsonl')
      : null;

    const onDebug = (entry) => this.logDebug(entry);

    if (transport && typeof transport.complete === 'function') {
      this.adapter = transport;
      this.transport = (msgs, temp) => transport.complete(msgs, temp);
    } else {
      this.transport = transport || (this.config.api === 'rest'
        ? restChatTransport(this.config, onDebug)
        : chatCompletionsTransport(this.config, onDebug));
    }
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
    const targetUrl = (this.config.api === 'rest')
      ? `${this.config.baseUrl.replace(/\/+$/, '')}/chat/message`
      : (/\/chat\/completions(\?|$)/.test(this.config.baseUrl) ? this.config.baseUrl : `${this.config.baseUrl.replace(/\/+$/, '')}/chat/completions`);

    const urlInfo = parseUrlDetails(targetUrl);
    const authHead = authHeaders(this.config);
    const hasAuth = Boolean(this.config.apiKey && this.config.apiKey.trim());
    const initialDiag = getTroubleshootingDetails({ code: 'OK' }, targetUrl, this.config);

    this.logDebug({
      event: 'request',
      endpoint: targetUrl,
      api_type: this.config.api,
      model: this.config.model,
      temperature,
      auth_status: hasAuth ? 'provided' : 'omitted',
      auth: {
        status: hasAuth ? 'provided' : 'omitted',
        header_name: this.config.authHeader || 'Authorization',
        token_length: hasAuth ? this.config.apiKey.length : 0,
        token_preview: hasAuth ? sanitizeHeaders({ key: this.config.apiKey }).key : '[NONE]',
      },
      headers: sanitizeHeaders(authHead),
      url_details: urlInfo,
      env_diagnostics: buildEnvDiagnostics(),
      test_commands: initialDiag.testCommands,
      warning: urlInfo.isPlaceholder
        ? "LLM_BASE_URL is currently using default placeholder 'your-llm-service.internal'. Requests to this host will fail unless configured in .env."
        : null,
      messages_count: payload.length,
      estimated_tokens: estimateMessagesTokens(payload),
      messages: payload,
    });

    for (let attempt = 1; ; attempt++) {
      const attemptStartTime = Date.now();
      try {
        const content = await this.transport(payload, temperature);
        if (!content || !String(content).trim()) throw new Error('LLM returned an empty response.');
        const durationMs = Date.now() - attemptStartTime;

        this.logDebug({
          event: 'response',
          endpoint: targetUrl,
          status: 200,
          duration_ms: durationMs,
          length: String(content).length,
          preview: String(content).slice(0, 160).replace(/\r?\n/g, ' '),
          content: String(content),
        });
        return String(content);
      } catch (err) {
        const durationMs = Date.now() - attemptStartTime;
        const errCode = err.code || err.cause?.code || null;
        const diag = getTroubleshootingDetails(err, err.url || targetUrl, this.config);
        const causeChain = err.causeChain || extractCauseChain(err);
        const primaryCause = causeChain[0] || (err.cause ? {
          message: err.cause.message,
          code: err.cause.code,
          address: err.cause.address,
          port: err.cause.port,
          syscall: err.cause.syscall,
          hostname: err.cause.hostname,
          errno: err.cause.errno,
        } : null);

        const errorDetails = {
          event: 'error',
          attempt,
          max_attempts: MAX_ATTEMPTS,
          duration_ms: durationMs,
          endpoint: err.url || targetUrl,
          error_category: diag.category,
          error_name: err.name || 'Error',
          message: err.message,
          error_code: errCode,
          status: err.status ?? null,
          status_text: err.statusText ?? null,
          url_details: err.urlInfo || parseUrlDetails(err.url || targetUrl),
          network_cause: primaryCause,
          cause_chain: causeChain.length > 1 ? causeChain : undefined,
          request_headers: err.requestHeaders || sanitizeHeaders(authHead),
          response_body: err.responseBody || null,
          response_headers: err.responseHeaders || null,
          env_diagnostics: buildEnvDiagnostics(),
          troubleshooting_hint: diag.hint,
          troubleshooting_checklist: diag.checklist,
          diagnostic_commands: diag.testCommands,
          will_retry: RETRYABLE.includes(err.status) && attempt < MAX_ATTEMPTS,
          stack: err.stack,
        };
        this.logDebug(errorDetails);

        // Ensure error object carries diagnostic fields
        err.category = diag.category;
        err.troubleshootingHint = diag.hint;
        err.troubleshootingChecklist = diag.checklist;
        err.diagnosticCommands = diag.testCommands;

        if (!RETRYABLE.includes(err.status) || attempt >= MAX_ATTEMPTS) {
          throw err;
        }

        const delayMs = attempt * (this.config.retryDelayMs ?? 2500);
        console.log(`⚠️  [LLM ${err.status || errCode}]: retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})...`);
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

