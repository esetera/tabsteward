// Provider adapters. Two wire shapes: OpenAI-compatible chat completions (OpenAI, DeepSeek, Z.ai, local
// Ollama / LM Studio / anything) and the Anthropic Messages API. Raw fetch, no SDKs: this runs inside a
// WebExtension with no bundler.

export const PROVIDERS = {
  ollama: {
    label: 'Ollama (local)', kind: 'openai', base: 'http://localhost:11434/v1', origin: 'http://localhost/*', local: true,
    defaultModel: 'llama3.2', models: [], jsonMode: 'json_schema', keyUrl: 'https://ollama.com/download',
    help: 'Runs on this machine. Nothing leaves your computer. Click "Grant access to the API host" once so Firefox lets the add-on talk to localhost.'
  },
  lmstudio: {
    label: 'LM Studio (local)', kind: 'openai', base: 'http://localhost:1234/v1', origin: 'http://localhost/*', local: true,
    defaultModel: '', models: [], jsonMode: 'json_schema', keyUrl: 'https://lmstudio.ai',
    help: 'Start the local server in LM Studio (Developer tab) and enable CORS there. Nothing leaves your computer.'
  },
  openai: {
    label: 'OpenAI', kind: 'openai', base: 'https://api.openai.com/v1', origin: 'https://api.openai.com/*',
    defaultModel: 'gpt-4.1-mini', models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-5'], jsonMode: 'json_object', keyUrl: 'https://platform.openai.com/api-keys'
  },
  anthropic: {
    label: 'Anthropic', kind: 'anthropic', base: 'https://api.anthropic.com/v1', origin: 'https://api.anthropic.com/*',
    defaultModel: 'claude-opus-5', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], jsonMode: 'json_schema', keyUrl: 'https://console.anthropic.com/settings/keys'
  },
  deepseek: {
    label: 'DeepSeek', kind: 'openai', base: 'https://api.deepseek.com/v1', origin: 'https://api.deepseek.com/*',
    defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'], jsonMode: 'json_object', keyUrl: 'https://platform.deepseek.com/api_keys'
  },
  zai: {
    label: 'Z.ai (GLM)', kind: 'openai', base: 'https://api.z.ai/api/paas/v4', origin: 'https://api.z.ai/*',
    defaultModel: 'glm-4.5-air', models: ['glm-4.5-air', 'glm-4.5', 'glm-4.5-flash'], jsonMode: false, keyUrl: 'https://z.ai/manage-apikey/apikey-list'
  },
  custom: {
    label: 'Custom OpenAI-compatible endpoint', kind: 'openai', base: 'http://localhost:8080/v1', origin: null,
    defaultModel: '', models: [], jsonMode: false, keyUrl: '',
    help: 'Any server speaking the OpenAI chat-completions shape: llama.cpp server, vLLM, LocalAI, Jan, OpenRouter, Groq…'
  }
};

export function isLocalBase(base) {
  try {
    const u = new URL(base);
    return ['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(u.hostname) || /\.local$/.test(u.hostname) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch { return false; }
}

export function isLocalProvider(provider) {
  if (!provider) return false;
  return !!provider.def.local || isLocalBase(provider.base);
}

// USD per 1M tokens, [input, output]. Approximate list prices; the spend meter is an estimate, not an invoice.
export const COSTS = {
  'gpt-4.1-mini': [0.4, 1.6], 'gpt-4.1': [2, 8], 'gpt-4o-mini': [0.15, 0.6], 'gpt-5-mini': [0.25, 2], 'gpt-5': [1.25, 10],
  'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5],
  'deepseek-chat': [0.27, 1.1], 'deepseek-reasoner': [0.55, 2.19],
  'glm-4.5-air': [0.2, 1.1], 'glm-4.5': [0.6, 2.2], 'glm-4.5-flash': [0, 0]
};

export function estimateCostUsd(model, inputTokens, outputTokens, local = false) {
  if (local) return 0;
  const [inRate, outRate] = COSTS[model] || [0, 0];
  return (inputTokens * inRate + outputTokens * outRate) / 1e6;
}

// Match patterns carry no port, so http://localhost:11434/v1 needs http://localhost/*.
export function originForBase(base) {
  try {
    const u = new URL(base);
    return `${u.protocol}//${u.hostname}/*`;
  } catch { return null; }
}

// Pull the first JSON object out of a model reply, tolerating code fences and chatter.
export function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* fall through */ } }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

export function resolveProvider(settings) {
  const id = settings.provider;
  if (!id || id === 'none' || !PROVIDERS[id]) return null;
  const def = PROVIDERS[id];
  const cfg = (settings.providers && settings.providers[id]) || {};
  const base = (cfg.baseUrl && (id === 'custom' || def.local) ? cfg.baseUrl : def.base) || def.base;
  const model = cfg.model || def.defaultModel;
  const apiKey = cfg.apiKey || '';
  const local = !!def.local || isLocalBase(base);
  if (!local && !apiKey) return null;
  if (!model) return null;
  return { id, def, base: base.replace(/\/+$/, ''), model, apiKey, kind: def.kind, jsonMode: def.jsonMode, local };
}

export async function callModel(provider, { system, user, schema, maxTokens = 4096, timeoutMs = 60000, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider.kind === 'anthropic') return await callAnthropic(provider, { system, user, schema, maxTokens, signal: controller.signal, fetchImpl });
    return await callOpenAiCompatible(provider, { system, user, schema, maxTokens, signal: controller.signal, fetchImpl });
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(provider, { system, user, schema, maxTokens, signal, fetchImpl }) {
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const body = {
    model: provider.model,
    messages: [
      { role: 'system', content: system + (schema ? `\n\nReply with a single JSON object matching this JSON schema and nothing else:\n${JSON.stringify(schema)}` : '') },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
    max_tokens: maxTokens
  };
  if (schema && provider.jsonMode === 'json_object') body.response_format = { type: 'json_object' };
  if (schema && provider.jsonMode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'reply', schema, strict: true } };
  let res = await fetchImpl(`${provider.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok && res.status === 400 && body.response_format && body.response_format.type === 'json_schema') {
    // Older servers know only json_object mode; the schema is still in the system prompt.
    body.response_format = { type: 'json_object' };
    res = await fetchImpl(`${provider.base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  }
  if (!res.ok) throw new Error(`${provider.def.label} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
  const usage = { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 };
  return { text, json: schema ? extractJson(text) : null, usage, model: data.model || provider.model };
}

async function callAnthropic(provider, { system, user, schema, maxTokens, signal, fetchImpl }) {
  const headers = {
    'content-type': 'application/json',
    'x-api-key': provider.apiKey,
    'anthropic-version': '2023-06-01',
    // Required when the API is called from a browser context rather than a server.
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  const body = { model: provider.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] };
  const outputConfig = {};
  if (!/haiku|sonnet-4-5/.test(provider.model)) outputConfig.effort = 'low';
  if (schema) outputConfig.format = { type: 'json_schema', schema };
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  const res = await fetchImpl(`${provider.base}/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  if (data.stop_reason === 'refusal') throw new Error('Anthropic declined the request (refusal)');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usage = { input: data.usage?.input_tokens || 0, output: data.usage?.output_tokens || 0 };
  return { text, json: schema ? extractJson(text) : null, usage, model: data.model || provider.model };
}


// List models from an OpenAI-compatible server (works for Ollama, LM Studio, OpenAI, DeepSeek).
export async function listModels(provider, { fetchImpl = fetch } = {}) {
  const headers = {};
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  const res = await fetchImpl(`${provider.base}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${provider.base}/models`);
  const data = await res.json();
  const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
  return list.map((m) => m.id || m.name).filter(Boolean).sort();
}
