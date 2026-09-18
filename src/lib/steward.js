// The steward: builds a plan from the current tabs, gates each action by the autonomy dial, executes
// or queues suggestions, and exposes every feature the UI calls.
import { getSettings, saveSettings, getState, setState, updateState, getSession, setSession, updateSession, uid } from './store.js';
import { classifyHeuristic, colorFor } from './categories.js';
import { effectivePolicy, validateRules, parsePolicyFallback, describeRule } from './rules.js';
import { stalenessDecision, hoursIdle, staleThresholdHours } from './staleness.js';
import { findDuplicates } from './dedupe.js';
import { isEphemeral, isBlankTab, isInternalUrl, hostOf } from './urls.js';
import { isNeverSend, tabForModel } from './privacy.js';
import { listGroups, ensureGroup, touchGroup, findGroupByTitle, keyForGroup, pickColor } from './groups.js';
import { metaForTabs, setTabMeta, getTabMeta } from './tabmeta.js';
import { execute, undoBatch, lastUndoableBatch, addLog, sendToAttic, markStewardMove } from './actions.js';
import { classifyWithModel, compilePolicyWithModel, askWithModel, draftNoteWithModel, nameGroupWithModel, commandWithModel, COMMAND_OPS, providerStatus, getSpend, sendPolicy, NoProviderError, SpendCapError } from './llm.js';

const SNOOZE_MS = 24 * 3600000;

// Triggers the user did not press: these respect hands-off, workbenches and pause.
const AUTOMATIC_TRIGGERS = new Set(['scheduled', 'idle', 'new-tab']);

// A workbench is a group whose title starts with "Workbench": tabs the user is working with together.
// The steward never regroups, collapses, hides, sleeps, closes or dedupes them, and never adds tabs to it.
export const WORKBENCH_TITLE = 'Workbench';
export const isWorkbenchTitle = (title) => /^workbench\b/i.test((title || '').trim());
const SUGGESTION_MAX = 60;

// ---------- context ----------

async function collectContext() {
  const settings = await getSettings();
  const tabs = await browser.tabs.query({});
  const meta = await metaForTabs(tabs);
  const groups = await listGroups();
  const focus = await getSession('focus', null);
  const created = await getSession('tabCreated', {});
  const used = await getSession('tabUsed', {});
  return { settings, tabs, meta, groups, focus, created, used, now: Date.now() };
}

/** Workbench group ids, from their titles (so they survive restarts). */
export function workbenchIds(groups) {
  return new Set(groups.filter((g) => isWorkbenchTitle(g.title)).map((g) => g.id));
}

/** When the user last touched a tab: created, switched to, or used. */
export function lastTouched(t, { created = {}, used = {} } = {}) {
  return Math.max(created[t.id] || 0, t.lastAccessed || 0, used[t.id] || 0);
}

/**
 * Hands off: an automatic pass may group a loose tab only when it isn't the tab being
 * looked at and nothing has touched it for handsOffMinutes. Returns the time it becomes
 * eligible (0 = now).
 */
export function handsOffUntil(t, ctx) {
  if (t.active) return Infinity;
  const ms = (ctx.settings.handsOffMinutes ?? 20) * 60000;
  const until = lastTouched(t, ctx) + ms;
  return until > ctx.now ? until : 0;
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

/**
 * A group action for a bucket of tabs. Joining a group that is collapsed or hidden would make the
 * tabs vanish from where the user was, so that becomes a suggestion instead (and executing it
 * opens the group).
 */
function groupingAction(b, existing, reason, joinWord) {
  const folded = !!existing && (existing.collapsed || (existing.tabs || []).every((t) => t.hidden));
  return {
    type: 'group', gate: 'group', windowId: b.windowId, title: existing ? existing.title : b.title, category: b.category, color: colorFor(b.category),
    tabIds: b.tabs.map((t) => t.id), reason: (existing ? joinWord : 'new group: ') + reason + (folded ? ' (the group is folded, so this waits for your OK)' : ''),
    ...(folded ? { suggestOnly: true, expand: true } : {})
  };
}

export async function planTidy(ctx, { allowModel = true, regroupAll = false, handsOff = false } = {}) {
  const { settings, tabs, meta, groups, focus, created, now } = ctx;
  const actions = [];
  const scheduledClose = new Set();
  const inFocusIds = new Set();
  if (focus) {
    for (const t of tabs) if (t.groupId === focus.groupId) inFocusIds.add(t.id);
  }
  // Workbench tabs are left entirely alone (treated like a focus session that never ends).
  const benches = workbenchIds(groups);
  const onBench = (t) => benches.has(t.groupId);
  for (const t of tabs) if (onBench(t)) inFocusIds.add(t.id);
  // Tabs whose group the user changed by hand stay where the user put them.
  const userPlaced = (t) => !!(meta.get(t.id) || {}).userPlaced;
  const live = tabs.filter((t) => !t.hidden);

  // 1. Ephemeral and blank tabs
  const ephemeralMs = (settings.ephemeralMinutes || 10) * 60000;
  const blanks = [];
  const ephemeral = [];
  for (const t of live) {
    if (t.active || t.pinned || onBench(t)) continue;
    // Firefox reports lastAccessed as 0 for tabs never selected; without a creation record treat those as old.
    const born = created[t.id] || (t.lastAccessed > 0 ? t.lastAccessed : 0);
    const age = born ? now - born : Infinity;
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

  // 3. Grouping of ungrouped tabs (or every tab, when asked to rethink the groups)
  const ungrouped = live.filter((t) => (regroupAll || t.groupId === -1) && !t.pinned && !isInternalUrl(t.url) && !scheduledClose.has(t.id)
    && !onBench(t) && !userPlaced(t) && !(handsOff && handsOffUntil(t, ctx)));
  const assignments = ungrouped.length ? await assignGroups(ungrouped, ctx, { allowModel }) : new Map();
  const groupTitleById = new Map(groups.map((g) => [g.id, (g.title || '').toLowerCase()]));
  const byWindowTitle = new Map();
  for (const t of ungrouped) {
    const a = assignments.get(t.id);
    if (!a) continue;
    if (t.groupId !== -1 && groupTitleById.get(t.groupId) === a.title.toLowerCase()) continue; // already there
    const key = t.windowId + '||' + a.title.toLowerCase();
    if (!byWindowTitle.has(key)) byWindowTitle.set(key, { windowId: t.windowId, title: a.title, category: a.category, tabs: [], reasons: new Set(), forced: false });
    const bucket = byWindowTitle.get(key);
    bucket.tabs.push(t);
    bucket.reasons.add(a.reason);
    if (a.reason === 'policy rule') bucket.forced = true;
  }
  for (const b of byWindowTitle.values()) {
    if (isWorkbenchTitle(b.title)) continue; // nothing is ever added to a workbench
    const existing = groups.find((g) => g.windowId === b.windowId && (g.title || '').toLowerCase() === b.title.toLowerCase());
    // A policy rule is explicit intent, so it may create a group of one. Heuristics and the model need minGroupSize.
    if (!existing && !b.forced && b.tabs.length < (settings.minGroupSize || 2)) continue;
    actions.push(groupingAction(b, existing, [...b.reasons].slice(0, 2).join('; '), 'belongs with '));
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
    if (g.hasActive || !g.tabs.length || benches.has(g.id)) continue;
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

export async function tidy({ trigger = 'manual', allowModel = true, regroupAll = false } = {}) {
  const automatic = AUTOMATIC_TRIGGERS.has(trigger);
  if (automatic && await isPaused()) return { skipped: 'paused', executed: [], suggested: [] };
  const running = await getSession('tidyRunning', 0);
  if (running && Date.now() - running < 120000) return { skipped: 'already running' };
  await setSession('tidyRunning', Date.now());
  try {
    const ctx = await collectContext();
    const actions = await planTidy(ctx, { allowModel, regroupAll, handsOff: automatic });
    const result = await applyPlan(actions, ctx.settings, { trigger });
    await pruneSuggestions();
    await setState('lastTidy', { ts: Date.now(), trigger, executed: result.executed.length, suggested: result.suggested.length });
    return result;
  } finally {
    await setSession('tidyRunning', 0);
  }
}

// Dry run: what Tidy would do right now, with reasons and the gate each action would pass through.
export async function preview({ allowModel = false } = {}) {
  const ctx = await collectContext();
  const actions = await planTidy(ctx, { allowModel });
  const out = [];
  for (const a of actions) {
    let mode = ctx.settings.autonomy[a.gate] || 'suggest';
    if (a.needsConfirm && mode === 'auto') mode = 'confirm';
    if (a.suggestOnly && mode === 'auto') mode = 'suggest';
    out.push({ type: a.type, subtype: a.subtype || null, gate: a.gate, mode, title: a.title || null, groupId: a.groupId ?? null, reason: a.reason, tabs: await describeTabs(a) });
  }
  return out;
}

// ---------- quick actions: one click, no sentence, always executed (the user pressed the button) ----------

async function runActions(actions, trigger) {
  const batchId = uid('batch');
  const executed = [];
  for (const a of actions) {
    try { const e = await execute({ ...a, batchId, trigger }); if (e) executed.push(e); } catch (e) { await addLog({ type: 'error', reason: `${a.type} failed: ${String(e.message || e)}`, tabs: [] }); }
  }
  return { batchId, executed: executed.length, tabs: executed.reduce((n, e) => n + (e.tabs || []).length, 0) };
}

export const QUICK_KINDS = ['cleanup', 'dedupe', 'group', 'closeStale', 'sleepAll', 'collapseAll', 'expandAll', 'minimise'];

export async function quick(kind) {
  const ctx = await collectContext();
  const running = await getSession('tidyRunning', 0);
  if (running && Date.now() - running < 120000) return { skipped: 'already running' };
  await setSession('tidyRunning', Date.now());
  try {
    switch (kind) {
      case 'cleanup': {
        const plan = (await planTidy(ctx, { allowModel: true })).filter((a) => ['ephemeral', 'dedupe', 'group'].includes(a.gate));
        return runActions(plan, 'quick:cleanup');
      }
      case 'dedupe': return runActions((await planTidy(ctx, { allowModel: false })).filter((a) => a.gate === 'dedupe'), 'quick:dedupe');
      case 'group': return runActions((await planTidy(ctx, { allowModel: true })).filter((a) => a.gate === 'group'), 'quick:group');
      case 'closeStale': return runActions((await planTidy(ctx, { allowModel: false })).filter((a) => a.gate === 'close' && a.type === 'close'), 'quick:closeStale');
      case 'sleepAll': {
        const benches = workbenchIds(ctx.groups);
        const ids = ctx.tabs.filter((t) => !t.active && !t.pinned && !t.audible && !t.discarded && !t.hidden && !isInternalUrl(t.url) && !benches.has(t.groupId)).map((t) => t.id);
        return runActions(ids.length ? [{ type: 'sleep', tabIds: ids, reason: 'you put everything to sleep' }] : [], 'quick:sleepAll');
      }
      case 'collapseAll': return runActions(ctx.groups.filter((g) => !g.collapsed && !isWorkbenchTitle(g.title)).map((g) => ({ type: 'collapse', groupId: g.id, title: g.title, reason: 'you collapsed everything' })), 'quick:collapseAll');
      case 'expandAll': return runActions(ctx.groups.filter((g) => g.collapsed).map((g) => ({ type: 'expand', groupId: g.id, title: g.title, reason: 'you expanded everything' })), 'quick:expandAll');
      case 'minimise': {
        const benches = workbenchIds(ctx.groups);
        const ids = ctx.tabs.filter((t) => !t.active && !t.pinned && !t.audible && !t.discarded && !t.hidden && !isInternalUrl(t.url) && !benches.has(t.groupId)).map((t) => t.id);
        const actions = ctx.groups.filter((g) => !g.collapsed && !benches.has(g.id)).map((g) => ({ type: 'collapse', groupId: g.id, title: g.title, reason: 'minimised' }));
        if (ids.length) actions.push({ type: 'sleep', tabIds: ids, reason: 'minimised' });
        return runActions(actions, 'quick:minimise');
      }
      default: throw new Error('Unknown quick action ' + kind);
    }
  } finally {
    await setSession('tidyRunning', 0);
  }
}

// ---------- new-tab auto grouping ----------

export async function queueNewTab(tabId) {
  await updateSession('pendingNew', [], (p) => (p.includes(tabId) ? p : [...p, tabId]));
  browser.alarms.create('classify-pending', { delayInMinutes: 0.1 });
}

/**
 * New loose tabs wait their turn: each is grouped only once hands-off allows (not the tab being
 * looked at, untouched for handsOffMinutes). Tabs not yet eligible stay queued and the alarm is
 * set for the earliest one. Nothing runs while paused; the queue is kept for when it resumes.
 */
export async function processPending() {
  const pending = await getSession('pendingNew', []);
  if (!pending.length || await isPaused()) return;
  const ctx = await collectContext();
  if (!ctx.settings.autoGroupNewTabs) { await setSession('pendingNew', []); return; }
  const benches = workbenchIds(ctx.groups);
  const ready = [];
  const waiting = [];
  let nextDue = Infinity;
  for (const id of pending) {
    const t = ctx.tabs.find((x) => x.id === id);
    if (!t || t.groupId !== -1 || t.pinned || isInternalUrl(t.url) || isBlankTab(t) || benches.has(t.groupId) || (ctx.meta.get(t.id) || {}).userPlaced) continue;
    const until = handsOffUntil(t, ctx);
    if (until) { waiting.push(id); if (until < nextDue) nextDue = until; } else ready.push(t);
  }
  await setSession('pendingNew', waiting);
  // The active tab has no due time; look again after the hands-off period.
  if (waiting.length) browser.alarms.create('classify-pending', { when: Number.isFinite(nextDue) ? nextDue + 5000 : ctx.now + (ctx.settings.handsOffMinutes ?? 20) * 60000 });
  if (!ready.length) return;
  const assignments = await assignGroups(ready, ctx);
  const actions = [];
  const buckets = new Map();
  for (const t of ready) {
    const a = assignments.get(t.id);
    if (!a || isWorkbenchTitle(a.title)) continue;
    const key = t.windowId + '||' + a.title.toLowerCase();
    if (!buckets.has(key)) buckets.set(key, { windowId: t.windowId, title: a.title, category: a.category, tabs: [], reason: a.reason, forced: false });
    buckets.get(key).tabs.push(t);
    if (a.reason === 'policy rule') buckets.get(key).forced = true;
  }
  for (const b of buckets.values()) {
    const existing = ctx.groups.find((g) => g.windowId === b.windowId && (g.title || '').toLowerCase() === b.title.toLowerCase());
    if (!existing && !b.forced && b.tabs.length < (ctx.settings.minGroupSize || 2)) continue;
    actions.push(groupingAction(b, existing, b.reason, 'new tab belongs with '));
  }
  if (actions.length) await applyPlan(actions, ctx.settings, { trigger: 'new-tab' });
}

// ---------- pause ----------

/** Paused stays paused until the user resumes (it survives restarts). */
export async function isPaused() { return !!(await getState('paused', null)); }
export async function setPaused(paused) {
  await setState('paused', paused ? { since: Date.now() } : null);
  await addLog({ type: paused ? 'paused' : 'resumed', reason: paused ? 'you paused the steward: nothing automatic runs until you resume' : 'you resumed the steward', tabs: [] });
  if (!paused) browser.alarms.create('classify-pending', { delayInMinutes: 0.1 });
  return pauseStatus();
}
export async function pauseStatus() { return getState('paused', null); }

// ---------- workbench ----------

/**
 * Keep these tabs together: puts them in a "Workbench" group in their window, left entirely alone
 * by the steward. With no ids, uses the highlighted (multi-selected) tabs of the focused window,
 * or just the active tab.
 */
export async function keepTogether(tabIds) {
  let tabs;
  if (tabIds && tabIds.length) tabs = (await Promise.all(tabIds.map((id) => browser.tabs.get(id).catch(() => null)))).filter(Boolean);
  else {
    const win = await browser.windows.getLastFocused();
    tabs = await browser.tabs.query({ windowId: win.id, highlighted: true });
    if (!tabs.length) tabs = await browser.tabs.query({ windowId: win.id, active: true });
  }
  tabs = tabs.filter((t) => !t.pinned);
  if (!tabs.length) throw new Error('Select the tabs to keep together (Ctrl or Cmd-click them), then try again.');
  const windowId = tabs[0].windowId;
  const others = tabs.filter((t) => t.windowId !== windowId);
  const ids = tabs.map((t) => t.id);
  await markStewardMove(ids);
  if (others.length) await browser.tabs.move(others.map((t) => t.id), { windowId, index: -1 });
  const existing = (await browser.tabGroups.query({ windowId })).map((g) => g.title || '');
  let title = WORKBENCH_TITLE;
  for (let n = 2; existing.some((t) => t.toLowerCase() === title.toLowerCase()); n++) title = `${WORKBENCH_TITLE} ${n}`;
  const groupId = await browser.tabs.group({ tabIds: ids, createProperties: { windowId } });
  await browser.tabGroups.update(groupId, { title, color: 'grey', collapsed: false });
  for (const id of ids) await setTabMeta(id, { userPlaced: false });
  await touchGroup(groupId);
  await addLog({ type: 'workbench', reason: `you kept ${ids.length} tab${ids.length === 1 ? '' : 's'} together in "${title}"; the steward leaves them alone`, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) });
  return { groupId, title, tabCount: ids.length };
}

/** Dissolve a workbench: its tabs go back to being loose (and are sorted later, once hands-off allows). */
export async function dissolveWorkbench(groupId) {
  const group = await browser.tabGroups.get(groupId);
  if (!isWorkbenchTitle(group.title)) throw new Error('That group is not a workbench.');
  const tabs = await browser.tabs.query({ groupId });
  const ids = tabs.map((t) => t.id);
  await markStewardMove(ids);
  if (ids.length) await browser.tabs.ungroup(ids);
  const used = Date.now();
  await updateSession('tabUsed', {}, (m) => ({ ...m, ...Object.fromEntries(ids.map((id) => [id, used])) }));
  await updateSession('pendingNew', [], (p) => [...new Set([...p, ...ids])]);
  browser.alarms.create('classify-pending', { delayInMinutes: 0.1 });
  await addLog({ type: 'workbench-end', reason: `you dissolved "${group.title}"; its ${ids.length} tabs are loose again`, tabs: tabs.map((t) => ({ id: t.id, title: t.title, url: t.url })) });
  return { dissolved: true, tabCount: ids.length };
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
  const rawIds = Array.isArray(r.tabIds) ? r.tabIds : Array.isArray(r.tabs) ? r.tabs.map((t) => (t && typeof t === 'object' ? t.id : t)) : Array.isArray(r.ids) ? r.ids : [];
  const tabIds = [...new Set(rawIds.map((id) => Number(id)).filter((id) => known.has(id)))];
  if (!['find', 'close', 'group', 'summarize', 'answer'].includes(r.intent)) r.intent = tabIds.length === 1 ? 'find' : 'answer';
  const described = [];
  for (const id of tabIds) { const t = tabs.find((x) => x.id === id); described.push({ id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '', windowId: t.windowId }); }
  const answer = typeof r.answer === 'string' && r.answer ? r.answer : described.length ? `${described.length} matching tab${described.length === 1 ? '' : 's'}` : 'No matching tabs';
  return { intent: r.intent, answer, groupTitle: typeof r.groupTitle === 'string' ? r.groupTitle : '', tabs: described };
}

// ---------- commands: "merge the two Firefox groups", "add the OpenRouter tabs to Dev" ----------

const DESTRUCTIVE = new Set(['closeTabs', 'closeGroup', 'hide']);

function sameTitle(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
}

function stepText(step, groupsById, tabsById) {
  const g = (id) => `“${(groupsById.get(id) || {}).title || 'group ' + id}”`;
  const n = (ids) => `${ids.length} tab${ids.length === 1 ? '' : 's'}`;
  switch (step.op) {
    case 'createGroup': {
      const existing = [...groupsById.values()].find((x) => sameTitle(x.title, step.title));
      return existing ? `Add ${n(step.tabIds)} to the existing group “${existing.title}”` : `Create group “${step.title}” with ${n(step.tabIds)}`;
    }
    case 'addToGroup': return `Add ${n(step.tabIds)} to ${g(step.groupId)}`;
    case 'renameGroup': return `Rename ${g(step.groupId)} to “${step.title}”`;
    case 'mergeGroups': return `Merge ${step.groupIds.map(g).join(' + ')}${step.title ? ` as “${step.title}”` : ''}`;
    case 'ungroup': return step.groupId ? `Ungroup ${g(step.groupId)}` : `Ungroup ${n(step.tabIds)}`;
    case 'closeTabs': return `Close ${n(step.tabIds)} (to the Attic)`;
    case 'closeGroup': return `Close ${g(step.groupId)} (to the Attic)`;
    case 'collapse': return `Collapse ${g(step.groupId)}`;
    case 'expand': return `Expand ${g(step.groupId)}`;
    case 'hide': return `Hide ${g(step.groupId)}`;
    case 'sleep': return `Put ${n(step.tabIds)} to sleep`;
    case 'moveToNewWindow': return `Move ${g(step.groupId)} to a new window`;
    case 'find': return `Found ${n(step.tabIds)}`;
    case 'answer': return step.text || '';
    default: return step.op;
  }
}

async function commandContext() {
  const settings = await getSettings();
  const tabs = (await browser.tabs.query({})).filter((t) => !isInternalUrl(t.url));
  const groups = await listGroups();
  const sp = await sendPolicy();
  const forModel = tabs.filter((t) => !isNeverSend(t, sp.neverSend, localClassify(t, settings.rules).policy, { local: sp.local })).map((t) => ({ ...tabForModel(t), groupId: t.groupId === -1 ? null : t.groupId }));
  return { settings, tabs, groups, forModel };
}

function validatePlan(raw, groups, tabs) {
  const groupIds = new Set(groups.map((g) => g.id));
  const tabIds = new Set(tabs.map((t) => t.id));
  const steps = [];
  for (const s of Array.isArray(raw?.steps) ? raw.steps : []) {
    if (!COMMAND_OPS.includes(s.op)) continue;
    const step = {
      op: s.op,
      title: typeof s.title === 'string' ? s.title.trim().slice(0, 40) : '',
      groupId: groupIds.has(Number(s.groupId)) ? Number(s.groupId) : null,
      groupIds: (Array.isArray(s.groupIds) ? s.groupIds : []).map(Number).filter((id) => groupIds.has(id)),
      tabIds: [...new Set((Array.isArray(s.tabIds) ? s.tabIds : []).map(Number).filter((id) => tabIds.has(id)))],
      text: typeof s.text === 'string' ? s.text.slice(0, 400) : ''
    };
    if (step.op === 'ungroup' && step.groupId) step.tabIds = [...new Set([...step.tabIds, ...tabs.filter((t) => t.groupId === step.groupId).map((t) => t.id)])];
    const needsTabs = ['createGroup', 'addToGroup', 'ungroup', 'closeTabs', 'sleep', 'find'].includes(step.op);
    const needsGroup = ['addToGroup', 'renameGroup', 'closeGroup', 'collapse', 'expand', 'hide', 'moveToNewWindow'].includes(step.op);
    if (needsTabs && !step.tabIds.length) continue;
    if (needsGroup && step.groupId === null) continue;
    if (step.op === 'mergeGroups' && step.groupIds.length < 2) continue;
    if ((step.op === 'createGroup' || step.op === 'renameGroup') && !step.title) continue;
    if (step.op === 'answer' && !step.text) continue;
    steps.push(step);
  }
  return steps;
}

// The window a new group belongs in: the focused window when any of the tabs live there, otherwise
// the window holding most of them. The first id the model happened to list must not decide it.
export async function targetWindowFor(tabs) {
  if (!tabs.length) return undefined;
  let focused = null;
  try { focused = (await browser.windows.getLastFocused()).id; } catch { focused = null; }
  if (focused !== null && tabs.some((t) => t.windowId === focused)) return focused;
  const counts = new Map();
  for (const t of tabs) counts.set(t.windowId, (counts.get(t.windowId) || 0) + 1);
  let best = tabs[0].windowId;
  let n = 0;
  for (const [w, k] of counts) if (k > n) { n = k; best = w; }
  return best;
}

// What a plan would disturb beyond what the person asked for. Anything listed here needs an OK
// before it runs: a "create a group with X" must never quietly empty other groups or drag tabs
// between windows.
export async function assessPlan(steps, groups, tabs) {
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const notes = [];
  const titleOf = (id) => `“${(groupsById.get(id) || {}).title || 'a group'}”`;
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  for (const s of steps) {
    const stepTabs = s.tabIds.map((id) => tabsById.get(id)).filter(Boolean);
    if (s.op === 'createGroup' || s.op === 'addToGroup') {
      const target = s.op === 'addToGroup' ? groupsById.get(s.groupId) : null;
      const windowId = target ? target.windowId : await targetWindowFor(stepTabs);
      const leaving = new Map();
      for (const t of stepTabs) {
        if (t.groupId !== -1 && t.groupId !== (target ? target.id : -1)) leaving.set(t.groupId, (leaving.get(t.groupId) || 0) + 1);
      }
      for (const [gid, k] of leaving) {
        const g = groupsById.get(gid);
        const empties = g && g.tabs.length <= k;
        notes.push(`Takes ${plural(k, 'tab')} out of ${titleOf(gid)}${empties ? ', which empties it' : ''}`);
      }
      const crossing = stepTabs.filter((t) => t.windowId !== windowId).length;
      if (crossing) notes.push(`Moves ${plural(crossing, 'tab')} in from another window`);
      if (s.op === 'createGroup') {
        const existing = groups.find((g) => g.windowId === windowId && sameTitle(g.title, s.title));
        if (existing) notes.push(`A group called “${existing.title}” already exists there, so the tabs join it instead`);
      }
    } else if (s.op === 'mergeGroups') {
      notes.push(`Merges ${s.groupIds.map(titleOf).join(' and ')} into one group`);
    } else if (s.op === 'ungroup') {
      notes.push(`Ungroups ${plural(s.tabIds.length, 'tab')}`);
    }
  }
  return notes;
}

export async function command(text, { execute: run = true } = {}) {
  const { groups, tabs, forModel } = await commandContext();
  const raw = await commandWithModel(text, groups.map((g) => ({ id: g.id, title: g.title || 'Untitled', count: g.tabs.length })), forModel);
  const steps = validatePlan(raw, groups, tabs);
  const groupsById = new Map(groups.map((g) => [g.id, g]));
  const tabsById = new Map(tabs.map((t) => [t.id, t]));
  const notes = await assessPlan(steps, groups, tabs);
  const destructive = steps.some((s) => DESTRUCTIVE.has(s.op));
  const plan = {
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    steps: steps.map((s) => ({ ...s, text: s.op === 'answer' ? s.text : stepText(s, groupsById, tabsById) })),
    destructive,
    notes,
    needsOk: destructive || notes.length > 0,
    tabs: [...new Set(steps.flatMap((s) => s.tabIds))].map((id) => tabsById.get(id)).filter(Boolean).map((t) => ({ id: t.id, title: t.title || t.url, url: t.url, favIconUrl: t.favIconUrl || '', windowId: t.windowId }))
  };
  if (!steps.length) plan.summary = plan.summary || 'I could not map that to an action.';
  if (run && steps.length && !plan.needsOk) return { ...plan, ...(await runPlan(plan.steps, text)) };
  return plan;
}

export async function runPlan(steps, text = '') {
  const batchId = uid('batch');
  const results = [];
  for (const step of steps) {
    try {
      const ok = await runStep(step, batchId, text);
      results.push({ ok: ok !== false, text: step.text || step.op });
    } catch (e) {
      results.push({ ok: false, text: `${step.text || step.op}: ${String(e.message || e)}` });
    }
  }
  return { ran: true, batchId, results };
}

// The tabs a step can still act on. Cross-window moves happen inside the group action itself, after
// it has recorded where each tab came from, so undo can send them home.
async function aliveUnpinned(tabIds) {
  const alive = [];
  for (const id of tabIds) { try { alive.push(await browser.tabs.get(id)); } catch { /* gone */ } }
  return alive.filter((t) => !t.pinned).map((t) => t.id);
}

async function runStep(step, batchId, text) {
  const reason = `you asked: “${text.slice(0, 60)}”`;
  switch (step.op) {
    case 'createGroup': {
      const alive = [];
      for (const id of step.tabIds) { try { alive.push(await browser.tabs.get(id)); } catch { /* gone */ } }
      if (!alive.length) return false;
      const windowId = await targetWindowFor(alive);
      const existing = await findGroupByTitle(windowId, step.title);
      const color = existing ? undefined : await pickColor(windowId);
      const ids = await aliveUnpinned(step.tabIds);
      return execute({ type: 'group', windowId, title: step.title, tabIds: ids, color, reason, batchId, trigger: 'command' });
    }
    case 'addToGroup': {
      const g = await browser.tabGroups.get(step.groupId);
      const ids = await aliveUnpinned(step.tabIds);
      return execute({ type: 'group', windowId: g.windowId, title: g.title, tabIds: ids, reason, batchId, trigger: 'command' });
    }
    case 'renameGroup': return execute({ type: 'rename', groupId: step.groupId, title: step.title, reason, batchId, trigger: 'command' });
    case 'mergeGroups': {
      const infos = [];
      for (const id of step.groupIds) { const g = await browser.tabGroups.get(id); const tabs = await browser.tabs.query({ groupId: id }); infos.push({ g, tabs }); }
      infos.sort((a, b) => b.tabs.length - a.tabs.length);
      const target = infos[0];
      for (const other of infos.slice(1)) {
        const ids = await aliveUnpinned(other.tabs.map((t) => t.id));
        if (ids.length) await execute({ type: 'group', windowId: target.g.windowId, title: target.g.title, tabIds: ids, reason, batchId, trigger: 'command' });
      }
      if (step.title && step.title !== target.g.title) await execute({ type: 'rename', groupId: target.g.id, title: step.title, reason, batchId, trigger: 'command' });
      return true;
    }
    case 'ungroup': return execute({ type: 'ungroup', tabIds: step.tabIds, reason, batchId, trigger: 'command' });
    case 'closeTabs': return execute({ type: 'close', tabIds: step.tabIds, force: true, reason, batchId, trigger: 'command' });
    case 'closeGroup': { const tabs = await browser.tabs.query({ groupId: step.groupId }); return execute({ type: 'close', tabIds: tabs.map((t) => t.id), force: true, reason, batchId, trigger: 'command' }); }
    case 'collapse': return execute({ type: 'collapse', groupId: step.groupId, reason, batchId, trigger: 'command' });
    case 'expand': return execute({ type: 'expand', groupId: step.groupId, reason, batchId, trigger: 'command' });
    case 'hide': return execute({ type: 'hide', groupId: step.groupId, reason, batchId, trigger: 'command' });
    case 'sleep': return execute({ type: 'sleep', tabIds: step.tabIds, reason, batchId, trigger: 'command' });
    case 'moveToNewWindow': return execute({ type: 'moveGroupToWindow', groupId: step.groupId, reason, batchId, trigger: 'command' });
    case 'find': case 'answer': return true;
    default: return false;
  }
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
    groups: groups.map((g) => ({ id: g.id, windowId: g.windowId, title: g.title, color: g.color, collapsed: g.collapsed, key: g.key, count: g.tabs.length, hasActive: g.hasActive, idleHours: Math.round((now - g.lastActive) / 3600000), category: g.category, allHidden: g.tabs.every((t) => t.hidden), workbench: isWorkbenchTitle(g.title) })),
    tabs: tabRows,
    suggestions,
    hiddenGroups: await hiddenGroups(),
    closedSinceLastOpen: attic.filter((e) => e.closedAt > lastOpen).slice(0, 20),
    atticCount: attic.length,
    lastTidy: await getState('lastTidy', null),
    focus, spend, provider, streakNudges, paused: await pauseStatus(), handsOffMinutes: settings.handsOffMinutes ?? 20,
    autonomy: settings.autonomy, monthlyCapUsd: settings.monthlyCapUsd, onboarded: settings.onboarded,
    rules: Object.fromEntries((settings.rules || []).map((r) => [r.id, describeRule(r)]))
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

export async function ungroupTabs(tabIds) {
  return execute({ type: 'ungroup', tabIds, reason: 'you dragged it out', trigger: 'user' });
}

export async function moveTabsToGroup(tabIds, groupId) {
  const g = await browser.tabGroups.get(groupId);
  const ids = await aliveUnpinned(tabIds);
  if (!ids.length) return null;
  return execute({ type: 'group', windowId: g.windowId, title: g.title, tabIds: ids, reason: 'you dragged it here', trigger: 'user' });
}

// Place a group just before another group in the tab strip (same window; cross-window moves the group first).
export async function reorderGroup(groupId, beforeGroupId) {
  const target = await browser.tabGroups.get(beforeGroupId);
  const targetTabs = await browser.tabs.query({ groupId: beforeGroupId });
  const index = Math.min(...targetTabs.map((t) => t.index));
  await browser.tabGroups.move(groupId, { windowId: target.windowId, index });
  await addLog({ type: 'reorder', reason: 'you reordered the groups', tabs: [], groupId });
  return true;
}

export async function sleepTabs(tabIds) {
  return execute({ type: 'sleep', tabIds, reason: 'you put it to sleep', trigger: 'user' });
}

export { NoProviderError, SpendCapError };
