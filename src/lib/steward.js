// The steward: builds a plan from the current tabs, gates each action by the autonomy dial, executes
// or queues suggestions, and exposes every feature the UI calls.
import { getSettings, saveSettings, getState, setState, updateState, getSession, setSession, updateSession, uid } from './store.js';
import { classifyHeuristic, colorFor } from './categories.js';
import { effectivePolicy, validateRules, parsePolicyFallback } from './rules.js';
import { stalenessDecision, hoursIdle, staleThresholdHours } from './staleness.js';
import { findDuplicates } from './dedupe.js';
import { isEphemeral, isBlankTab, isInternalUrl, hostOf } from './urls.js';
import { isNeverSend, tabForModel } from './privacy.js';
import { listGroups, ensureGroup, touchGroup, findGroupByTitle, keyForGroup } from './groups.js';
import { metaForTabs, setTabMeta, getTabMeta } from './tabmeta.js';
import { execute, undoBatch, lastUndoableBatch, addLog, sendToAttic } from './actions.js';
import { classifyWithModel, compilePolicyWithModel, askWithModel, draftNoteWithModel, nameGroupWithModel, providerStatus, getSpend, sendPolicy, NoProviderError, SpendCapError } from './llm.js';

const SNOOZE_MS = 24 * 3600000;
const SUGGESTION_MAX = 60;

// ---------- context ----------

async function collectContext() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const meta = await metaForTabs(tabs);
  const groups = await listGroups();
  const focus = await getSession('focus', null);
  const created = await getSession('tabCreated', {});
  return { settings, tabs, meta, groups, focus, created, now: Date.now() };
}

function localClassify(tab, rules) {
  const h = classifyHeuristic(tab);
  const policy = effectivePolicy(rules, tab, h.category);
  return { ...h, policy };
}

async function excerptFor(tab, settings) {
  if (!settings.sendContent) return '';
  try {
    const r = await browser.tabs.sendMessage(tab.id, { type: 'ts:excerpt' });
    return r && r.excerpt ? r.excerpt : '';
  } catch { return ''; }
}

// Decide a group title for each candidate tab. Model first when available, heuristics otherwise.
async function assignGroups(candidates, ctx, { allowModel = true } = {}) {
  const { settings, groups } = ctx;
  const out = new Map();
  const forModel = [];
  const sp = await sendPolicy();
  for (const tab of candidates) {
    const c = localClassify(tab, settings.rules);
    if (c.policy.group) { out.set(tab.id, { title: c.policy.group, category: c.category, reason: 'policy rule' }); continue; }
    const neverSend = isNeverSend(tab, sp.neverSend, c.policy, { local: sp.local });
    if (allowModel && !neverSend) {
      forModel.push({ ...tabForModel(tab, { includeContent: settings.sendContent, content: await excerptFor(tab, settings) }), url: tab.url });
    }
    if (c.confidence >= 0.6 && c.category !== 'Misc') out.set(tab.id, { title: c.category, category: c.category, reason: c.reason });
  }
  if (forModel.length && allowModel) {
    const status = await providerStatus();
    if (status.ok) {
      try {
        const existing = groups.map((g) => ({ title: g.title || 'Untitled', category: g.category, sampleTitles: g.sampleTitles }));
        const assignments = await classifyWithModel(forModel, existing);
        for (const a of assignments) out.set(a.id, { title: a.group, category: a.category, reason: a.reason, byModel: true });
      } catch (e) {
        await addLog({ type: 'model-error', reason: String(e.message || e), tabs: [] });
      }
    }
  }
  return out;
}

// ---------- planning ----------

export async function planTidy(ctx, { allowModel = true } = {}) {
  const { settings, tabs, meta, groups, focus, created, now } = ctx;
  const actions = [];
  const scheduledClose = new Set();
  const inFocusIds = new Set();
  if (focus) {
    for (const t of tabs) if (t.groupId === focus.groupId) inFocusIds.add(t.id);
  }
  const live = tabs.filter((t) => !t.hidden);

  // 1. Ephemeral and blank tabs
  const ephemeralMs = (settings.ephemeralMinutes || 10) * 60000;
  const blanks = [];
  const ephemeral = [];
  for (const t of live) {
    if (t.active || t.pinned) continue;
    const age = now - (created[t.id] || t.lastAccessed || now);
    if (isBlankTab(t) && age > ephemeralMs) { blanks.push(t); continue; }
    if (isInternalUrl(t.url)) continue;
    const c = localClassify(t, settings.rules);
    if (c.policy.protect || c.policy.closeNever) continue;
    if (isEphemeral(t) && age > ephemeralMs) ephemeral.push(t);
  }
  if (blanks.length) actions.push({ type: 'closeSilently', gate: 'ephemeral', tabIds: blanks.map((t) => t.id), reason: 'empty tab left open' });
  if (ephemeral.length) {
    actions.push({ type: 'close', subtype: 'ephemeral', gate: 'ephemeral', tabIds: ephemeral.map((t) => t.id), reason: 'leftover sign-in or confirmation page' });
    ephemeral.forEach((t) => scheduledClose.add(t.id));
  }

  // 2. Duplicates
  const dupCandidates = live.filter((t) => !scheduledClose.has(t.id) && !inFocusIds.has(t.id));
  for (const set of findDuplicates(dupCandidates)) {
    const closable = set.close.filter((t) => !localClassify(t, settings.rules).policy.protect);
    if (!closable.length) continue;
    actions.push({ type: 'close', subtype: 'duplicate', gate: 'dedupe', tabIds: closable.map((t) => t.id), keepTabId: set.keep.id, reason: `duplicate of "${(set.keep.title || set.keep.url).slice(0, 50)}"` });
    closable.forEach((t) => scheduledClose.add(t.id));
  }

  // 3. Grouping of ungrouped tabs
  const ungrouped = live.filter((t) => t.groupId === -1 && !t.pinned && !isInternalUrl(t.url) && !scheduledClose.has(t.id));
  const assignments = ungrouped.length ? await assignGroups(ungrouped, ctx, { allowModel }) : new Map();
  const byWindowTitle = new Map();
  for (const t of ungrouped) {
    const a = assignments.get(t.id);
    if (!a) continue;
    const key = t.windowId + '||' + a.title.toLowerCase();
    if (!byWindowTitle.has(key)) byWindowTitle.set(key, { windowId: t.windowId, title: a.title, category: a.category, tabs: [], reasons: new Set() });
    const bucket = byWindowTitle.get(key);
    bucket.tabs.push(t);
    bucket.reasons.add(a.reason);
  }
  for (const b of byWindowTitle.values()) {
    const existing = groups.find((g) => g.windowId === b.windowId && (g.title || '').toLowerCase() === b.title.toLowerCase());
    if (!existing && b.tabs.length < (settings.minGroupSize || 2)) continue;
    actions.push({ type: 'group', gate: 'group', windowId: b.windowId, title: existing ? existing.title : b.title, category: b.category, color: colorFor(b.category), tabIds: b.tabs.map((t) => t.id), reason: (existing ? 'belongs with ' : 'new group: ') + [...b.reasons].slice(0, 2).join('; ') });
  }

  // 4. Staleness: sleep, close, read later
  const sleepIds = [];
  const closeStale = [];
  const closeStaleConfirm = [];
  const readLater = [];
  for (const t of live) {
    if (scheduledClose.has(t.id) || isInternalUrl(t.url)) continue;
    const c = localClassify(t, settings.rules);
    const category = assignments.get(t.id)?.category || c.category;
    const m = meta.get(t.id) || {};
    const d = stalenessDecision(t, { category, policy: c.policy, settings, now, snoozedUntil: m.snoozedUntil || 0, inFocus: inFocusIds.has(t.id) });
    if (!d) continue;
    if (d.action === 'sleep') sleepIds.push(t.id);
    else if (d.action === 'close') (d.needsConfirm ? closeStaleConfirm : closeStale).push({ t, reason: d.reason });
    else if (d.action === 'readLater') readLater.push({ t, reason: d.reason });
  }
  if (sleepIds.length) actions.push({ type: 'sleep', gate: 'sleep', tabIds: sleepIds, reason: 'idle, put to sleep to free memory' });
  for (const { t, reason } of closeStale) actions.push({ type: 'close', subtype: 'stale', gate: 'close', tabIds: [t.id], reason });
  for (const { t, reason } of closeStaleConfirm) actions.push({ type: 'close', subtype: 'stale', gate: 'close', needsConfirm: true, tabIds: [t.id], reason });
  for (const { t, reason } of readLater) actions.push({ type: 'readLater', gate: 'close', suggestOnly: true, tabIds: [t.id], reason });

  // 5. Collapse and hide idle groups
  const collapseMs = (settings.collapseIdleHours || 2) * 3600000;
  const hideMs = (settings.hideIdleHours || 24) * 3600000;
  for (const g of groups) {
    if (g.hasActive || !g.tabs.length) continue;
    if (focus && g.id === focus.groupId) continue;
    const allHidden = g.tabs.every((t) => t.hidden);
    if (allHidden) continue;
    const idle = now - g.lastActive;
    const anyNeverHide = g.tabs.some((t) => localClassify(t, settings.rules).policy.neverHide);
    if (idle > hideMs && !anyNeverHide) {
      actions.push({ type: 'hide', gate: 'hide', groupId: g.id, title: g.title, reason: `group "${g.title || 'untitled'}" untouched for ${Math.round(idle / 3600000)} h` });
    } else if (idle > collapseMs && !g.collapsed) {
      actions.push({ type: 'collapse', gate: 'collapse', groupId: g.id, title: g.title, reason: `group "${g.title || 'untitled'}" idle ${Math.round(idle / 3600000)} h` });
    }
  }
  return actions;
}

// ---------- gating and execution ----------

function signature(a) {
  return [a.type, a.groupId ?? '', (a.title || '').toLowerCase(), [...(a.tabIds || [])].sort().join(',')].join('|');
}

export async function applyPlan(actions, settings, { trigger = 'steward' } = {}) {
  const batchId = uid('batch');
  const executed = [];
  const suggested = [];
  const existing = await getState('suggestions', []);
  const sigs = new Set(existing.map((s) => s.sig));
  for (const a of actions) {
    let mode = settings.autonomy[a.gate] || 'suggest';
    if (a.needsConfirm && mode === 'auto') mode = 'confirm';
    if (a.suggestOnly) mode = mode === 'auto' ? 'suggest' : mode;
    if (mode === 'auto') {
      try {
        const entry = await execute({ ...a, batchId, trigger });
        if (entry) executed.push(entry);
      } catch (e) {
        await addLog({ type: 'error', reason: `${a.type} failed: ${String(e.message || e)}`, tabs: [] });
      }
    } else {
      const sig = signature(a);
      if (sigs.has(sig)) continue;
      sigs.add(sig);
      suggested.push({ id: uid('sug'), sig, mode, createdAt: Date.now(), action: a, tabs: await describeTabs(a) });
    }
  }
  if (suggested.length) {
    await updateState('suggestions', [], (s) => [...suggested, ...s].slice(0, SUGGESTION_MAX));
    if (settings.notifications && suggested.some((s) => s.mode === 'confirm')) await notifyOnce(suggested.length);
  }
  return { batchId, executed, suggested };
}

async function describeTabs(a) {
  const out = [];
  for (const id of a.tabIds || []) {
    try { const t = await browser.tabs.get(id); out.push({ id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '' }); } catch { /* gone */ }
  }
  if (a.groupId !== undefined && !out.length) {
    try { for (const t of await browser.tabs.query({ groupId: a.groupId })) out.push({ id: t.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '' }); } catch { /* gone */ }
  }
  return out;
}

async function notifyOnce(count) {
  const last = await getSession('lastNotify', 0);
  if (Date.now() - last < 30 * 60000) return;
  await setSession('lastNotify', Date.now());
  try {
    await browser.notifications.create('ts-suggestions', {
      type: 'basic', iconUrl: browser.runtime.getURL('icons/icon.svg'), title: 'Tab Steward',
      message: `${count} suggestion${count === 1 ? '' : 's'} waiting for your say-so. Click to review.`
    });
  } catch { /* notifications unavailable */ }
}

export async function tidy({ trigger = 'manual', allowModel = true } = {}) {
  const running = await getSession('tidyRunning', 0);
  if (running && Date.now() - running < 120000) return { skipped: 'already running' };
  await setSession('tidyRunning', Date.now());
  try {
    const ctx = await collectContext();
    const actions = await planTidy(ctx, { allowModel });
    const result = await applyPlan(actions, ctx.settings, { trigger });
    await pruneSuggestions();
    await setState('lastTidy', { ts: Date.now(), trigger, executed: result.executed.length, suggested: result.suggested.length });
    return result;
  } finally {
    await setSession('tidyRunning', 0);
  }
}

// ---------- new-tab auto grouping ----------

export async function queueNewTab(tabId) {
  await updateSession('pendingNew', [], (p) => (p.includes(tabId) ? p : [...p, tabId]));
  browser.alarms.create('classify-pending', { delayInMinutes: 0.1 });
}

export async function processPending() {
  const pending = await getSession('pendingNew', []);
  if (!pending.length) return;
  await setSession('pendingNew', []);
  const ctx = await collectContext();
  if (!ctx.settings.autoGroupNewTabs) return;
  const tabs = [];
  for (const id of pending) {
    const t = ctx.tabs.find((x) => x.id === id);
    if (t && t.groupId === -1 && !t.pinned && !isInternalUrl(t.url) && !isBlankTab(t)) tabs.push(t);
  }
  if (!tabs.length) return;
  const assignments = await assignGroups(tabs, ctx);
  const actions = [];
  const buckets = new Map();
  for (const t of tabs) {
    const a = assignments.get(t.id);
    if (!a) continue;
    const key = t.windowId + '||' + a.title.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { windowId: t.windowId, title: a.title, category: a.category, tabs: [], reason: a.reason });
    buckets.get(key).tabs.push(t);
  }
  for (const b of buckets.values()) {
    const existing = ctx.groups.find((g) => g.windowId === b.windowId && (g.title || '').toLowerCase() === b.title.toLowerCase());
    if (!existing && b.tabs.length < (ctx.settings.minGroupSize || 2)) continue;
    actions.push({ type: 'group', gate: 'group', windowId: b.windowId, title: existing ? existing.title : b.title, category: b.category, color: colorFor(b.category), tabIds: b.tabs.map((t) => t.id), reason: (existing ? 'new tab belongs with ' : 'new group: ') + b.reason });
  }
  if (actions.length) await applyPlan(actions, ctx.settings, { trigger: 'new-tab' });
}

// ---------- suggestions ----------

export async function listSuggestions() {
  await pruneSuggestions();
  return getState('suggestions', []);
}

async function pruneSuggestions() {
  const alive = new Set((await browser.tabs.query({})).map((t) => t.id));
  const groups = new Set((await browser.tabGroups.query({})).map((g) => g.id));
  await updateState('suggestions', [], (s) => s.filter((x) => {
    const a = x.action;
    if (a.tabIds && a.tabIds.length && !a.tabIds.some((id) => alive.has(id))) return false;
    if (a.groupId !== undefined && !groups.has(a.groupId)) return false;
    return Date.now() - x.createdAt < 7 * 86400000;
  }));
}

export async function approveSuggestion(id) {
  const s = (await getState('suggestions', [])).find((x) => x.id === id);
  if (!s) return null;
  await updateState('suggestions', [], (list) => list.filter((x) => x.id !== id));
  const entry = await execute({ ...s.action, force: false, trigger: 'approved' });
  await bumpStreak(s.action.gate, true);
  return entry;
}

export async function dismissSuggestion(id) {
  const s = (await getState('suggestions', [])).find((x) => x.id === id);
  if (!s) return;
  await updateState('suggestions', [], (list) => list.filter((x) => x.id !== id));
  if (['close', 'readLater', 'sleep', 'hide', 'collapse'].includes(s.action.type)) {
    for (const tid of s.action.tabIds || []) await setTabMeta(tid, { snoozedUntil: Date.now() + SNOOZE_MS });
    if (s.action.groupId !== undefined) await touchGroup(s.action.groupId);
  }
  await bumpStreak(s.action.gate, false);
}

export async function dismissAllSuggestions() {
  const list = await getState('suggestions', []);
  for (const s of list) await dismissSuggestion(s.id);
}

async function bumpStreak(gate, approved) {
  const settings = await getSettings();
  const streaks = { ...settings.approvalStreaks };
  streaks[gate] = approved ? (streaks[gate] || 0) + 1 : 0;
  await saveSettings({ approvalStreaks: streaks });
}

// ---------- groups ----------

export async function groupAction(kind, { groupId, title, color, windowId }) {
  switch (kind) {
    case 'collapse': return execute({ type: 'collapse', groupId, reason: 'you collapsed it', trigger: 'user' });
    case 'expand': return execute({ type: 'expand', groupId, reason: 'you expanded it', trigger: 'user' });
    case 'hide': return execute({ type: 'hide', groupId, reason: 'you hid it', trigger: 'user' });
    case 'rename': return execute({ type: 'rename', groupId, title, color, reason: 'you renamed it', trigger: 'user' });
    case 'ungroup': {
      const tabs = await browser.tabs.query({ groupId });
      return execute({ type: 'ungroup', tabIds: tabs.map((t) => t.id), reason: 'you ungrouped it', trigger: 'user' });
    }
    case 'close': {
      const tabs = await browser.tabs.query({ groupId });
      return execute({ type: 'close', tabIds: tabs.map((t) => t.id), force: true, reason: 'you closed the group', trigger: 'user' });
    }
    case 'sleep': {
      const tabs = await browser.tabs.query({ groupId });
      return execute({ type: 'sleep', tabIds: tabs.map((t) => t.id), reason: 'you put the group to sleep', trigger: 'user' });
    }
    case 'moveToNewWindow': return execute({ type: 'moveGroupToWindow', groupId, windowId, reason: 'you moved it', trigger: 'user' });
    case 'autoName': {
      const tabs = await browser.tabs.query({ groupId });
      const settings = await getSettings();
      const sp = await sendPolicy();
      const forModel = tabs.filter((t) => !isNeverSend(t, sp.neverSend, localClassify(t, settings.rules).policy, { local: sp.local })).map((t) => tabForModel(t));
      if (!forModel.length) throw new Error('Every tab in this group is on your never-send list');
      const r = await nameGroupWithModel(forModel);
      if (!r || !r.title) throw new Error('No name suggested');
      return execute({ type: 'rename', groupId, title: r.title.slice(0, 40), color: colorFor(r.category), reason: 'model suggested the name', trigger: 'user' });
    }
    default: throw new Error('Unknown group action ' + kind);
  }
}

export async function showHiddenGroup(key) {
  return execute({ type: 'show', key, reason: 'you brought it back', trigger: 'user' });
}

export async function hiddenGroups() {
  const h = await getState('hiddenGroups', {});
  const alive = new Set((await browser.tabs.query({})).map((t) => t.id));
  const out = {};
  for (const [k, rec] of Object.entries(h)) {
    const tabIds = rec.tabIds.filter((id) => alive.has(id));
    if (tabIds.length) out[k] = { ...rec, tabIds };
  }
  if (Object.keys(out).length !== Object.keys(h).length) await setState('hiddenGroups', out);
  return Object.values(out);
}

// Pull every group with this title, across windows, into the window that holds the biggest one.
export async function gatherGroups(title) {
  const groups = (await listGroups()).filter((g) => (g.title || '').toLowerCase() === title.toLowerCase());
  if (groups.length < 2) return 0;
  groups.sort((a, b) => b.tabs.length - a.tabs.length);
  const target = groups[0];
  let moved = 0;
  for (const g of groups.slice(1)) {
    const ids = g.tabs.map((t) => t.id);
    await browser.tabs.move(ids, { windowId: target.windowId, index: -1 });
    await browser.tabs.group({ tabIds: ids, groupId: target.id });
    moved += ids.length;
  }
  await addLog({ type: 'gather', reason: `gathered "${title}" into one window`, tabs: [], title });
  return moved;
}

export async function createGroupFromTabs(tabIds, title, windowId) {
  return execute({ type: 'group', tabIds, title, windowId, reason: 'you grouped them', trigger: 'user' });
}

// ---------- focus mode ----------

export async function startFocus(groupId, minutes = 50) {
  const g = await browser.tabGroups.get(groupId);
  const tabs = await browser.tabs.query({ windowId: g.windowId });
  const toHide = tabs.filter((t) => t.groupId !== groupId && !t.pinned && !t.active && !t.hidden).map((t) => t.id);
  const active = tabs.find((t) => t.active);
  if (active && active.groupId !== groupId) {
    const first = tabs.find((t) => t.groupId === groupId);
    if (first) await browser.tabs.update(first.id, { active: true });
    if (!active.pinned) toHide.push(active.id);
  }
  const hidden = toHide.length ? await browser.tabs.hide(toHide) : [];
  await browser.tabGroups.update(groupId, { collapsed: false });
  const endsAt = Date.now() + minutes * 60000;
  await setSession('focus', { groupId, windowId: g.windowId, title: g.title, hiddenTabIds: hidden, endsAt });
  browser.alarms.create('focus-end', { when: endsAt });
  await addLog({ type: 'focus', reason: `focus on "${g.title || 'group'}" for ${minutes} min`, tabs: [] });
  return { groupId, endsAt, hidden: hidden.length };
}

export async function endFocus() {
  const f = await getSession('focus', null);
  if (!f) return null;
  try { await browser.tabs.show(f.hiddenTabIds); } catch { /* some gone */ }
  await setSession('focus', null);
  browser.alarms.clear('focus-end');
  await addLog({ type: 'focus-end', reason: 'focus session ended', tabs: [] });
  return f;
}

export async function focusStatus() {
  return getSession('focus', null);
}

// ---------- projects ----------

export async function listProjects() {
  return getState('projects', []);
}

export async function saveProject(name, { windowId } = {}) {
  const groups = (await listGroups(windowId !== undefined ? { windowId } : {})).filter((g) => g.tabs.length);
  const project = {
    id: uid('proj'), name: name || `Project ${new Date().toLocaleDateString()}`, createdAt: Date.now(),
    groups: groups.map((g) => ({ title: g.title || 'Untitled', color: g.color, tabs: g.tabs.map((t) => ({ url: t.url, title: t.title || t.url })) }))
  };
  await updateState('projects', [], (p) => [project, ...p].slice(0, 100));
  return project;
}

export async function restoreProject(id) {
  const project = (await getState('projects', [])).find((p) => p.id === id);
  if (!project) return null;
  const win = await browser.windows.create({});
  const blank = (await browser.tabs.query({ windowId: win.id }))[0];
  for (const g of project.groups) {
    const ids = [];
    for (const t of g.tabs) {
      if (isInternalUrl(t.url)) continue;
      try {
        const tab = await browser.tabs.create({ url: t.url, windowId: win.id, active: false, discarded: true, title: t.title });
        ids.push(tab.id);
      } catch {
        const tab = await browser.tabs.create({ url: t.url, windowId: win.id, active: false });
        ids.push(tab.id);
      }
    }
    if (ids.length) await ensureGroup(win.id, g.title, ids, { color: g.color });
  }
  if (blank) { try { await browser.tabs.remove(blank.id); } catch { /* ignore */ } }
  await addLog({ type: 'project-restore', reason: `restored project "${project.name}"`, tabs: [] });
  return win.id;
}

export async function deleteProject(id) {
  await updateState('projects', [], (p) => p.filter((x) => x.id !== id));
}

// Snapshot every group as today's project, then close the grouped tabs into the Attic.
export async function endOfDay() {
  const project = await saveProject(`Day ${new Date().toISOString().slice(0, 10)}`);
  const groups = await listGroups();
  const batchId = uid('batch');
  let closed = 0;
  for (const g of groups) {
    const ids = g.tabs.filter((t) => !t.pinned).map((t) => t.id);
    if (!ids.length) continue;
    const entry = await execute({ type: 'close', tabIds: ids, force: true, batchId, reason: 'end of day, saved in project "' + project.name + '"', trigger: 'user' });
    closed += entry ? entry.tabs.length : 0;
  }
  return { project, closed, batchId };
}

// ---------- ask your tabs ----------

export async function ask(query) {
  const settings = await getSettings();
  const tabs = (await browser.tabs.query({})).filter((t) => !isInternalUrl(t.url));
  const groups = await browser.tabGroups.query({});
  const titles = new Map(groups.map((g) => [g.id, g.title]));
  const sp = await sendPolicy();
  const forModel = tabs.filter((t) => !isNeverSend(t, sp.neverSend, localClassify(t, settings.rules).policy, { local: sp.local })).map((t) => ({ ...tabForModel(t), group: titles.get(t.groupId) || null }));
  const r = await askWithModel(query, forModel, groups.map((g) => ({ id: g.id, title: g.title })));
  if (!r) throw new Error('No answer');
  const known = new Set(tabs.map((t) => t.id));
  const tabIds = (r.tabIds || []).filter((id) => known.has(id));
  const described = [];
  for (const id of tabIds) { const t = tabs.find((x) => x.id === id); described.push({ id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '', windowId: t.windowId }); }
  return { intent: r.intent, answer: r.answer || '', groupTitle: r.groupTitle || '', tabs: described };
}

// ---------- notes ----------

export async function setNote(tabId, note) {
  await setTabMeta(tabId, { note: (note || '').slice(0, 200) });
  return true;
}

export async function draftNote(tabId) {
  const t = await browser.tabs.get(tabId);
  const settings = await getSettings();
  const sp = await sendPolicy();
  if (isNeverSend(t, sp.neverSend, localClassify(t, settings.rules).policy, { local: sp.local })) throw new Error('This tab is on your never-send list');
  let groupTitle = '';
  if (t.groupId !== -1) { try { groupTitle = (await browser.tabGroups.get(t.groupId)).title; } catch { /* ignore */ } }
  const note = await draftNoteWithModel(tabForModel(t), groupTitle);
  await setNote(tabId, note);
  return note;
}

// ---------- policy ----------

export async function compilePolicy(text) {
  let rules = [];
  let via = 'fallback';
  const status = await providerStatus();
  if (status.ok && text.trim()) {
    try { rules = validateRules(await compilePolicyWithModel(text)); via = 'model'; } catch (e) { via = 'fallback (' + String(e.message || e) + ')'; }
  }
  if (!rules.length) rules = validateRules(parsePolicyFallback(text));
  await saveSettings({ policyText: text, rules });
  return { rules, via };
}

// ---------- overview for the popup ----------

export async function overview() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const groups = await listGroups();
  const suggestions = await listSuggestions();
  const attic = await getState('attic', []);
  const lastOpen = await getState('lastPopupOpen', 0);
  const now = Date.now();
  const meta = await metaForTabs(tabs);
  let staleSoon = 0;
  const tabRows = [];
  const grouped = new Map(groups.map((g) => [g.id, g]));
  for (const t of tabs) {
    const c = localClassify(t, settings.rules);
    const idle = hoursIdle(t, now);
    const threshold = staleThresholdHours(c.category, settings, c.policy);
    const willClose = !t.pinned && !c.policy.closeNever && !c.policy.protect;
    if (willClose && idle >= threshold - 24 && idle < threshold) staleSoon += 1;
    tabRows.push({
      id: t.id, windowId: t.windowId, groupId: t.groupId, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '',
      active: t.active, pinned: t.pinned, discarded: t.discarded, hidden: t.hidden, audible: t.audible,
      category: c.category, protectedBy: c.policy.matched, idleHours: Math.round(idle), note: (meta.get(t.id) || {}).note || '',
      closesInHours: willClose ? Math.max(0, Math.round(threshold - idle)) : null
    });
  }
  const streakNudges = Object.entries(settings.approvalStreaks || {}).filter(([gate, n]) => n >= 10 && settings.autonomy[gate] !== 'auto').map(([gate, n]) => ({ gate, n }));
  const focus = await focusStatus();
  const spend = await getSpend();
  const provider = await providerStatus();
  return {
    counts: { tabs: tabs.length, sleeping: tabs.filter((t) => t.discarded).length, hidden: tabs.filter((t) => t.hidden).length, groups: groups.length, windows: new Set(tabs.map((t) => t.windowId)).size, staleSoon },
    groups: groups.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed, key: g.key, count: g.tabs.length, hasActive: g.hasActive, idleHours: Math.round((now - g.lastActive) / 3600000), category: g.category, allHidden: g.tabs.every((t) => t.hidden) })),
    tabs: tabRows,
    suggestions,
    hiddenGroups: await hiddenGroups(),
    closedSinceLastOpen: attic.filter((e) => e.closedAt > lastOpen).slice(0, 20),
    atticCount: attic.length,
    lastTidy: await getState('lastTidy', null),
    focus, spend, provider, streakNudges,
    autonomy: settings.autonomy, monthlyCapUsd: settings.monthlyCapUsd, onboarded: settings.onboarded
  };
}

export async function markPopupOpen() {
  await setState('lastPopupOpen', Date.now());
}

export async function undoLast() {
  const batchId = await lastUndoableBatch();
  if (!batchId) return 0;
  return undoBatch(batchId);
}

export async function closeTabs(tabIds, reason = 'you closed it') {
  return execute({ type: 'close', tabIds, force: true, reason, trigger: 'user' });
}

export async function sleepTabs(tabIds) {
  return execute({ type: 'sleep', tabIds, reason: 'you put it to sleep', trigger: 'user' });
}

export { NoProviderError, SpendCapError };
