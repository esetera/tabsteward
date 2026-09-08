// The only file that talks to a model. Enforces the spend cap, records every payload in the send log,
// caches classifications per URL, and shapes prompts so the model returns strict JSON.
import { resolveProvider, callModel, estimateCostUsd, isLocalProvider, listModels } from './providers.js';
import { getSettings, getState, updateState, monthKey, uid } from './store.js';
import { CATEGORIES } from './categories.js';
import { urlKey } from './urls.js';

const CLASSIFY_CACHE_TTL = 7 * 24 * 3600000;
const SEND_LOG_MAX = 50;

export class SpendCapError extends Error {}
export class NoProviderError extends Error {}

export async function providerStatus() {
  const settings = await getSettings();
  const p = resolveProvider(settings);
  if (!p) return { ok: false, local: false };
  const local = isLocalProvider(p);
  return { ok: true, label: p.def.label, model: p.model, local, seesEverything: local && settings.localSeesEverything !== false };
}

export async function getSpend() {
  const spend = await getState('spend', {});
  const m = monthKey();
  return { month: m, ...(spend[m] || { usd: 0, calls: 0, input: 0, output: 0, byModel: {} }) };
}

async function recordSpend(model, usage, task, local) {
  const m = monthKey();
  const usd = estimateCostUsd(model, usage.input, usage.output, local);
  await updateState('spend', {}, (spend) => {
    const cur = spend[m] || { usd: 0, calls: 0, input: 0, output: 0, byModel: {}, byTask: {} };
    cur.usd += usd; cur.calls += 1; cur.input += usage.input; cur.output += usage.output;
    cur.byModel[model] = (cur.byModel[model] || 0) + usd;
    cur.byTask = cur.byTask || {};
    cur.byTask[task] = (cur.byTask[task] || 0) + 1;
    // keep only the current and previous month
    const keep = Object.keys(spend).sort().slice(-1);
    const next = {};
    for (const k of keep) next[k] = spend[k];
    next[m] = cur;
    return next;
  });
  return usd;
}

async function logSend(entry) {
  await updateState('sendLog', [], (log) => [entry, ...log].slice(0, SEND_LOG_MAX));
}

// Generic task runner: privacy filtering is the caller's job (see privacy.tabForModel + isNeverSend).
export async function runTask(task, { system, user, schema, maxTokens }) {
  const settings = await getSettings();
  const provider = resolveProvider(settings);
  if (!provider) throw new NoProviderError('No model provider configured');
  const spend = await getSpend();
  const local = isLocalProvider(provider);
  if (!local && settings.monthlyCapUsd > 0 && spend.usd >= settings.monthlyCapUsd) {
    throw new SpendCapError(`Monthly cap of $${settings.monthlyCapUsd} reached`);
  }
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = await callModel(provider, { system, user, schema, maxTokens });
  } catch (e) {
    error = e;
  }
  const entry = {
    id: uid('send'), ts: started, task, provider: provider.id, model: provider.model, local,
    ms: Date.now() - started, bytes: (system.length + user.length),
    payload: user.slice(0, 4000), ok: !error, error: error ? String(error.message || error) : null,
    usage: result ? result.usage : null, usd: 0
  };
  if (result) entry.usd = await recordSpend(result.model || provider.model, result.usage, task, local);
  await logSend(entry);
  if (error) throw error;
  return result;
}

// ---------- Classification ----------

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          group: { type: 'string' },
          category: { type: 'string', enum: CATEGORIES },
          reason: { type: 'string' }
        },
        required: ['id', 'group', 'category', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['assignments'],
  additionalProperties: false
};

const CLASSIFY_SYSTEM = `You are a tab steward organising a person's open browser tabs into a small number of named groups.
Rules:
- Prefer the existing groups when a tab clearly belongs; reuse their exact titles.
- Otherwise invent a short, specific group title (1-3 words, Title Case) describing the task or topic, e.g. "Flights to Tokyo", "Rust Async", "House Hunting". Avoid vague titles like "Misc" or "Other" unless nothing fits.
- Tabs about the same task belong together even if on different sites. Tabs on the same site but different tasks may be split.
- Assign a category from the allowed list for each tab.
- Give a reason of at most 10 words.
Return JSON only.`;

export async function getClassifyCache() {
  return getState('classifyCache', {});
}

export async function classifyWithModel(tabsForModel, existingGroups, { useCache = true } = {}) {
  const cache = useCache ? await getClassifyCache() : {};
  const now = Date.now();
  const pending = [];
  const cached = [];
  for (const t of tabsForModel) {
    const key = urlKey(t.url || '');
    const hit = key && cache[key];
    if (useCache && hit && now - hit.ts < CLASSIFY_CACHE_TTL && existingGroups.some((g) => g.title === hit.group)) {
      cached.push({ id: t.id, group: hit.group, category: hit.category, reason: 'cached: ' + hit.reason, cached: true });
    } else {
      pending.push(t);
    }
  }
  let fresh = [];
  if (pending.length) {
    const user = JSON.stringify({
      existingGroups: existingGroups.map((g) => ({ title: g.title, category: g.category || null, sampleTitles: (g.sampleTitles || []).slice(0, 4) })),
      tabs: pending.map(({ id, title, host, path, excerpt }) => ({ id, title, host, path, ...(excerpt ? { excerpt } : {}) }))
    });
    const result = await runTask('classify', { system: CLASSIFY_SYSTEM, user, schema: CLASSIFY_SCHEMA, maxTokens: 4096 });
    const parsed = result.json;
    if (!parsed || !Array.isArray(parsed.assignments)) throw new Error('Model returned no assignments');
    const byId = new Map(pending.map((t) => [t.id, t]));
    fresh = parsed.assignments
      .filter((a) => byId.has(a.id) && typeof a.group === 'string' && a.group.trim())
      .map((a) => ({ id: a.id, group: a.group.trim().slice(0, 40), category: CATEGORIES.includes(a.category) ? a.category : 'Misc', reason: String(a.reason || '').slice(0, 80) }));
    await updateState('classifyCache', {}, (c) => {
      const next = { ...c };
      for (const a of fresh) {
        const t = byId.get(a.id);
        const key = urlKey(t.url || '');
        if (key) next[key] = { group: a.group, category: a.category, reason: a.reason, ts: now };
      }
      // prune
      for (const [k, v] of Object.entries(next)) if (now - v.ts > CLASSIFY_CACHE_TTL) delete next[k];
      return next;
    });
  }
  return [...cached, ...fresh];
}

// ---------- Policy compilation ----------

const RULES_SCHEMA = {
  type: 'object',
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          match: {
            type: 'object',
            properties: {
              host: { type: 'string' }, category: { type: 'string', enum: CATEGORIES }, title: { type: 'string' }, urlRegex: { type: 'string' }, any: { type: 'boolean' }
            },
            additionalProperties: false
          },
          effect: {
            type: 'object',
            properties: {
              protect: { type: 'boolean' }, closeNever: { type: 'boolean' }, closeAfterHours: { type: 'number' }, group: { type: 'string' },
              confirmClose: { type: 'boolean' }, neverSend: { type: 'boolean' }, neverHide: { type: 'boolean' }, neverSleep: { type: 'boolean' }
            },
            additionalProperties: false
          },
          source: { type: 'string' }
        },
        required: ['match', 'effect', 'source'],
        additionalProperties: false
      }
    }
  },
  required: ['rules'],
  additionalProperties: false
};

const RULES_SYSTEM = `You compile a person's plain-language tab policy into rules for a browser tab manager.
Each rule has a match (host like "github.com" which also covers subdomains; or a category from ${CATEGORIES.join(', ')}; or a title substring; or a urlRegex; or any:true for every tab) and an effect.
Effects: protect (never close, hide or sleep), closeNever, closeAfterHours (number), group (a group title), confirmClose (ask before closing), neverSend (never describe this tab to a model), neverHide, neverSleep.
One sentence may become several rules. Put the sentence you compiled in "source". Only produce rules the text actually asks for. Return JSON only.`;

export async function compilePolicyWithModel(text) {
  const result = await runTask('compile-policy', { system: RULES_SYSTEM, user: text, schema: RULES_SCHEMA, maxTokens: 4096 });
  return result.json?.rules || [];
}

// ---------- Ask your tabs ----------

const ASK_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['find', 'close', 'group', 'summarize', 'answer'] },
    tabIds: { type: 'array', items: { type: 'integer' } },
    groupTitle: { type: 'string' },
    answer: { type: 'string' }
  },
  required: ['intent', 'tabIds', 'groupTitle', 'answer'],
  additionalProperties: false
};

const ASK_SYSTEM = `You answer questions about, and act on, a person's open browser tabs.
Decide the intent: find (they want to jump to a tab), close (they want tabs closed), group (they want tabs grouped; set groupTitle), summarize (describe what a set of tabs is about), answer (a question you can answer from the tab list).
Fill tabIds with every matching tab id. Keep answer to two sentences. Return JSON only.`;

export async function askWithModel(query, tabsForModel, groups) {
  const user = JSON.stringify({ question: query, groups: groups.map((g) => ({ id: g.id, title: g.title })), tabs: tabsForModel.map(({ id, title, host, path, group }) => ({ id, title, host, path, group })) });
  const result = await runTask('ask', { system: ASK_SYSTEM, user, schema: ASK_SCHEMA, maxTokens: 2048 });
  return result.json;
}

// ---------- Tab note drafting ----------

const NOTE_SCHEMA = { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false };

export async function draftNoteWithModel(tabForModel, groupTitle) {
  const user = JSON.stringify({ tab: tabForModel, group: groupTitle || null });
  const result = await runTask('note', { system: 'Write a one-line note (max 12 words) guessing why this browser tab is still open, phrased as a reminder to its owner. Return JSON only.', user, schema: NOTE_SCHEMA, maxTokens: 200 });
  return result.json?.note || '';
}

// ---------- Group naming ----------

const NAME_SCHEMA = { type: 'object', properties: { title: { type: 'string' }, category: { type: 'string', enum: CATEGORIES } }, required: ['title', 'category'], additionalProperties: false };

export async function nameGroupWithModel(tabsForModel) {
  const user = JSON.stringify({ tabs: tabsForModel.map(({ title, host, path }) => ({ title, host, path })) });
  const result = await runTask('name-group', { system: 'Give this set of browser tabs a short specific group title (1-3 words, Title Case) and a category. Return JSON only.', user, schema: NAME_SCHEMA, maxTokens: 200 });
  return result.json;
}

// "Should this tab be described to the model?" helper that knows about local providers.
export async function sendPolicy() {
  const settings = await getSettings();
  const p = resolveProvider(settings);
  const local = isLocalProvider(p) && settings.localSeesEverything !== false;
  return { neverSend: settings.neverSend, local };
}

export async function discoverModels(settingsOverride) {
  const settings = settingsOverride || (await getSettings());
  const p = resolveProvider({ ...settings, providers: { ...settings.providers, [settings.provider]: { ...settings.providers[settings.provider], model: settings.providers[settings.provider].model || 'probe' } } });
  if (!p) throw new Error('Provider not configured');
  return listModels(p);
}
