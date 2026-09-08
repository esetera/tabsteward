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
// Two steps. First the model sees every tab at once and proposes a small set of task-level groups
// (short output, one call). Then tabs are assigned to those groups by index in batches (tiny output
// per call). This keeps every call fast on a local model and keeps titles coherent across batches.

const TAXONOMY_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, category: { type: 'string', enum: CATEGORIES }, why: { type: 'string' } },
        required: ['title', 'category', 'why'],
        additionalProperties: false
      }
    }
  },
  required: ['groups'],
  additionalProperties: false
};

const TAXONOMY_SYSTEM = `You organise a person's open browser tabs into a small set of task-level groups.
You get their existing groups and every open tab (title, host, path). Propose the complete set of groups to use:
- Reuse an existing group's exact title whenever tabs fit it. Add new groups only for tabs that fit none.
- Aim for roughly one group per 4 to 8 tabs, between 2 and 10 groups in total. Every group should cover at least two tabs.
- Titles are 1 to 4 words, Title Case, describing the task or topic ("Firefox Add-on Dev", "OpenRouter Keys", "Flights to Tokyo"), not a site name.
- Merge near-duplicates into one group rather than splitting hairs. Do not create "Misc" or "Other".
- "why" is at most 8 words.
Return JSON only.`;

const ASSIGN_SCHEMA = {
  type: 'object',
  properties: {
    assignments: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' }, g: { type: 'integer' } }, required: ['id', 'g'], additionalProperties: false }
    }
  },
  required: ['assignments'],
  additionalProperties: false
};

const ASSIGN_SYSTEM = `Assign each browser tab to the best-fitting group from the numbered list. Use the group number as "g". If a tab truly fits none, use -1, but prefer the closest group. Every tab id in the input must appear exactly once. Return JSON only.`;

export async function getClassifyCache() {
  return getState('classifyCache', {});
}

async function proposeTaxonomy(existingGroups, tabs) {
  const user = JSON.stringify({
    existingGroups: existingGroups.map((g) => ({ title: g.title, category: g.category || null, sampleTitles: (g.sampleTitles || []).slice(0, 3) })),
    tabs: tabs.map(({ id, title, host, path }) => ({ id, title: (title || '').slice(0, 80), host, path: (path || '').slice(0, 40) }))
  });
  const result = await runTask('taxonomy', { system: TAXONOMY_SYSTEM, user, schema: TAXONOMY_SCHEMA, maxTokens: 1024 });
  const groups = Array.isArray(result.json?.groups) ? result.json.groups : [];
  const out = [];
  const seen = new Set();
  for (const g of existingGroups) {
    const t = (g.title || '').trim();
    if (t && !seen.has(t.toLowerCase())) { seen.add(t.toLowerCase()); out.push({ title: t, category: g.category || 'Misc', why: 'existing group', existing: true }); }
  }
  for (const g of groups) {
    const t = typeof g.title === 'string' ? g.title.trim().slice(0, 40) : '';
    if (!t || /^(misc|other|miscellaneous)$/i.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push({ title: t, category: CATEGORIES.includes(g.category) ? g.category : 'Misc', why: String(g.why || '').slice(0, 60) });
  }
  return out;
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
  const fresh = [];
  if (pending.length) {
    const taxonomy = await proposeTaxonomy(existingGroups, pending);
    if (!taxonomy.length) throw new Error('Model proposed no groups');
    const byId = new Map(pending.map((t) => [t.id, t]));
    const groupList = taxonomy.map((g, i) => ({ n: i, title: g.title, why: g.why }));
    const BATCH = 15;
    let firstError = null;
    for (let i = 0; i < pending.length; i += BATCH) {
      const batch = pending.slice(i, i + BATCH);
      const user = JSON.stringify({ groups: groupList, tabs: batch.map(({ id, title, host, path, excerpt }) => ({ id, title: (title || '').slice(0, 80), host, path: (path || '').slice(0, 40), ...(excerpt ? { excerpt } : {}) })) });
      try {
        const result = await runTask('assign', { system: ASSIGN_SYSTEM, user, schema: ASSIGN_SCHEMA, maxTokens: 1024 });
        for (const a of Array.isArray(result.json?.assignments) ? result.json.assignments : []) {
          const id = Number(a.id);
          const g = taxonomy[Number(a.g)];
          if (!byId.has(id) || !g) continue;
          if (fresh.some((f) => f.id === id)) continue;
          fresh.push({ id, group: g.title, category: g.category, reason: g.why || 'model', byModel: true });
        }
      } catch (e) {
        firstError = firstError || e;
        if (e instanceof SpendCapError || e instanceof NoProviderError) break;
      }
    }
    if (!fresh.length && firstError) throw firstError;
    if (fresh.length) {
      await updateState('classifyCache', {}, (c) => {
        const next = { ...c };
        for (const a of fresh) {
          const key = urlKey(byId.get(a.id).url || '');
          if (key) next[key] = { group: a.group, category: a.category, reason: a.reason, ts: now };
        }
        for (const [k, v] of Object.entries(next)) if (now - v.ts > CLASSIFY_CACHE_TTL) delete next[k];
        return next;
      });
    }
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
Fill tabIds with every matching tab id (numbers from the tab list). Keep answer to two sentences. Return JSON only.
Example: {"intent":"find","tabIds":[12],"groupTitle":"","answer":"The pricing page is the Acme tab."}`;

export async function askWithModel(query, tabsForModel, groups) {
  const user = JSON.stringify({ question: query, groups: groups.map((g) => ({ id: g.id, title: g.title })), tabs: tabsForModel.map(({ id, title, host, path, group }) => ({ id, title, host, path, group })) });
  const result = await runTask('ask', { system: ASK_SYSTEM, user, schema: ASK_SCHEMA, maxTokens: 2048 });
  return result.json;
}

// ---------- Commands ----------

export const COMMAND_OPS = ['createGroup', 'addToGroup', 'renameGroup', 'mergeGroups', 'ungroup', 'closeTabs', 'closeGroup', 'collapse', 'expand', 'hide', 'sleep', 'moveToNewWindow', 'find', 'answer'];

const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: COMMAND_OPS },
          title: { type: 'string' },
          groupId: { type: 'integer' },
          groupIds: { type: 'array', items: { type: 'integer' } },
          tabIds: { type: 'array', items: { type: 'integer' } },
          text: { type: 'string' }
        },
        required: ['op', 'title', 'groupId', 'groupIds', 'tabIds', 'text'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'steps'],
  additionalProperties: false
};

const COMMAND_SYSTEM = `You turn a person's instruction about their browser tabs into a short plan of operations. You get their tab groups (id, title, tab count) and open tabs (id, title, host, path, groupId or null).
Operations (fill unused fields with "" , 0 or []):
- createGroup: title + tabIds. Make a new group with those tabs.
- addToGroup: groupId + tabIds. Put tabs into an existing group.
- renameGroup: groupId + title.
- mergeGroups: groupIds (two or more) + optional title. All tabs end up in one group.
- ungroup: tabIds and/or groupId. Take tabs out of groups.
- closeTabs: tabIds. closeGroup: groupId. Closed tabs are recoverable.
- collapse / expand / hide / moveToNewWindow: groupId.
- sleep: tabIds. Unload tabs to save memory.
- find: tabIds. When they just want to locate tabs.
- answer: text. When no action fits, or to explain.
Match tabs and groups by meaning ("the Firefox tabs" = every tab about Firefox; "the two add-on groups" = groups whose titles mention add-ons). Never invent ids. Prefer one precise step over many. "summary" is one sentence saying what the plan does. Return JSON only.`;

export async function commandWithModel(text, groups, tabsForModel) {
  const user = JSON.stringify({
    instruction: text,
    groups: groups.map((g) => ({ id: g.id, title: g.title, tabs: g.count })),
    tabs: tabsForModel.map(({ id, title, host, path, groupId }) => ({ id, title: (title || '').slice(0, 80), host, path: (path || '').slice(0, 40), groupId }))
  });
  const result = await runTask('command', { system: COMMAND_SYSTEM, user, schema: COMMAND_SCHEMA, maxTokens: 1024 });
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
