import { describe, it, expect } from 'vitest';
import { extractJson, resolveProvider, callModel, estimateCostUsd, isLocalBase, isLocalProvider, listModels } from '../src/lib/providers.js';
import { isNeverSend, tabForModel } from '../src/lib/privacy.js';

describe('extractJson', () => {
  it('parses clean, fenced and chatty replies', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(extractJson('nope')).toBeNull();
  });
});

describe('resolveProvider', () => {
  it('needs a key for cloud providers but not for local ones', () => {
    expect(resolveProvider({ provider: 'openai', providers: { openai: { apiKey: '' } } })).toBeNull();
    expect(resolveProvider({ provider: 'openai', providers: { openai: { apiKey: 'k' } } })).toMatchObject({ model: 'gpt-4.1-mini', local: false });
    expect(resolveProvider({ provider: 'ollama', providers: { ollama: { apiKey: '', model: 'qwen3' } } })).toMatchObject({ model: 'qwen3', local: true });
    expect(resolveProvider({ provider: 'custom', providers: { custom: { baseUrl: 'http://192.168.1.5:8080/v1', model: 'm' } } }).local).toBe(true);
    expect(resolveProvider({ provider: 'custom', providers: { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'm' } } })).toBeNull();
  });
  it('detects local hosts', () => {
    expect(isLocalBase('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBase('http://10.0.0.7:1234/v1')).toBe(true);
    expect(isLocalBase('https://api.openai.com/v1')).toBe(false);
  });
});

describe('callModel wire shapes', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  it('sends OpenAI-compatible JSON mode and reads usage', async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 }, model: 'deepseek-chat' }) }; };
    const p = resolveProvider({ provider: 'deepseek', providers: { deepseek: { apiKey: 'k' } } });
    const r = await callModel(p, { system: 's', user: 'u', schema, fetchImpl });
    expect(captured.url).toBe('https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(captured.init.body);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(captured.init.headers.authorization).toBe('Bearer k');
    expect(r.json).toEqual({ ok: true });
    expect(r.usage).toEqual({ input: 10, output: 2 });
  });
  it('uses json_schema response_format for LM Studio', async () => {
    let body;
    const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) }; };
    const p = resolveProvider({ provider: 'lmstudio', providers: { lmstudio: { model: 'qwen' } } });
    await callModel(p, { system: 's', user: 'u', schema, fetchImpl });
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema).toEqual(schema);
  });
  it('sends the Anthropic Messages shape with structured output and the browser header', async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return { ok: true, json: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 5, output_tokens: 1 }, model: 'claude-opus-5', stop_reason: 'end_turn' }) }; };
    const p = resolveProvider({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k' } } });
    const r = await callModel(p, { system: 's', user: 'u', schema, fetchImpl });
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');
    expect(captured.init.headers['x-api-key']).toBe('k');
    expect(captured.init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(captured.init.body);
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema });
    expect(body.output_config.effort).toBe('low');
    expect(body.thinking).toBeUndefined();
    expect(r.json).toEqual({ ok: true });
  });
  it('omits effort for haiku and throws on refusal', async () => {
    let body;
    const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return { ok: true, json: async () => ({ content: [], stop_reason: 'refusal', usage: {} }) }; };
    const p = resolveProvider({ provider: 'anthropic', providers: { anthropic: { apiKey: 'k', model: 'claude-haiku-4-5' } } });
    await expect(callModel(p, { system: 's', user: 'u', schema, fetchImpl })).rejects.toThrow(/refusal/);
    expect(body.output_config.effort).toBeUndefined();
  });
  it('surfaces HTTP errors with the provider name', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
    const p = resolveProvider({ provider: 'openai', providers: { openai: { apiKey: 'k' } } });
    await expect(callModel(p, { system: 's', user: 'u', fetchImpl })).rejects.toThrow(/OpenAI HTTP 401/);
  });
  it('lists models from an OpenAI-compatible server', async () => {
    const fetchImpl = async () => ({ ok: true, json: async () => ({ data: [{ id: 'b' }, { id: 'a' }] }) });
    const p = resolveProvider({ provider: 'ollama', providers: { ollama: { model: 'x' } } });
    expect(await listModels(p, { fetchImpl })).toEqual(['a', 'b']);
  });
});

describe('cost and privacy', () => {
  it('estimates cost and zeroes it for local models', () => {
    expect(estimateCostUsd('claude-haiku-4-5', 1e6, 0)).toBe(1);
    expect(estimateCostUsd('claude-haiku-4-5', 1e6, 0, true)).toBe(0);
    expect(isLocalProvider(resolveProvider({ provider: 'ollama', providers: { ollama: { model: 'x' } } }))).toBe(true);
  });
  it('never-send list gates cloud models but not trusted local ones', () => {
    const tab = { url: 'https://mail.google.com/mail', title: 'Inbox' };
    expect(isNeverSend(tab, ['mail.google.com'], {})).toBe(true);
    expect(isNeverSend(tab, ['mail.google.com'], {}, { local: true })).toBe(false);
    expect(isNeverSend(tab, [], { neverSend: true }, { local: true })).toBe(true);
    expect(isNeverSend({ url: 'about:blank' }, [], {}, { local: true })).toBe(true);
  });
  it('only ever exposes title, host and path', () => {
    const out = tabForModel({ id: 3, url: 'https://www.example.com/secret/path?token=abc', title: 'Hello' });
    expect(out).toEqual({ id: 3, title: 'Hello', host: 'example.com', path: '/secret/path' });
  });
});
