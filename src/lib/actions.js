// Executes steward actions against the browser, records every one in the activity log, sends closed
// tabs to the Attic, and knows how to undo a batch.
import { getState, updateState, getSettings, uid } from './store.js';
import { ensureGroup, keyForGroup, touchGroup, groupSnapshot } from './groups.js';
import { getTabMeta, setTabMeta } from './tabmeta.js';

const LOG_MAX = 500;
const ATTIC_MAX = 2000;

export async function addLog(entry) {
  const e = { id: uid('log'), ts: Date.now(), ...entry };
  await updateState('log', [], (log) => [e, ...log].slice(0, LOG_MAX));
  return e;
}

async function groupTitleOf(tab) {
  if (!tab || tab.groupId === undefined || tab.groupId === -1) return '';
  try { return (await browser.tabGroups.get(tab.groupId)).title || ''; } catch { return ''; }
}

export async function sendToAttic(tabs, { reason, action, batchId }) {
  const entries = [];
  for (const tab of tabs) {
    const meta = await getTabMeta(tab.id);
    entries.push({
      id: uid('attic'), tabId: tab.id, url: tab.url, title: tab.title || tab.url, favIconUrl: tab.favIconUrl || '',
      groupTitle: await groupTitleOf(tab), groupKey: meta.groupKey || null, note: meta.note || '', windowId: tab.windowId,
      reason, action, batchId, closedAt: Date.now(), lastAccessed: tab.lastAccessed || 0
    });
  }
  await updateState('attic', [], (attic) => [...entries, ...attic].slice(0, ATTIC_MAX));
  return entries;
}

export async function pruneAttic() {
  const settings = await getSettings();
  const cutoff = Date.now() - (settings.atticDays || 30) * 86400000;
  await updateState('attic', [], (attic) => attic.filter((e) => e.closedAt >= cutoff));
}

export async function restoreAttic(entryId, { activate = false } = {}) {
  const attic = await getState('attic', []);
  const entry = attic.find((e) => e.id === entryId);
  if (!entry) return null;
  let windowId;
  try { windowId = (await browser.windows.get(entry.windowId)).id; } catch { windowId = (await browser.windows.getLastFocused()).id; }
  const tab = await browser.tabs.create({ url: entry.url, windowId, active: activate });
  if (entry.note) await setTabMeta(tab.id, { note: entry.note });
  if (entry.groupTitle) {
    try { await ensureGroup(windowId, entry.groupTitle, [tab.id]); } catch { /* grouping is best effort */ }
  }
  await updateState('attic', [], (a) => a.filter((e) => e.id !== entryId));
  await addLog({ type: 'restore', reason: 'restored from the Attic', tabs: [{ id: tab.id, title: entry.title, url: entry.url }] });
  return tab;
}

export async function deleteAttic(entryId) {
  await updateState('attic', [], (a) => a.filter((e) => e.id !== entryId));
}

function tabSummary(t) {
  return { id: t.id, title: (t.title || t.url || '').slice(0, 120), url: t.url || '' };
}

async function tabsById(ids) {
  const out = [];
  for (const id of ids) {
    try { out.push(await browser.tabs.get(id)); } catch { /* gone */ }
  }
  return out;
}

async function isDirty(tabId) {
  try {
    const r = await browser.tabs.sendMessage(tabId, { type: 'ts:dirty?' });
    return !!(r && r.dirty);
  } catch { return false; }
}

// action: {type, tabIds?, groupId?, windowId?, title?, color?, category?, reason, batchId?, force?}
export async function execute(action) {
  const batchId = action.batchId || uid('batch');
  const type = action.type;
  const tabs = action.tabIds ? await tabsById(action.tabIds) : [];
  let undo = null;
  let affected = tabs.map(tabSummary);

  switch (type) {
    case 'close': {
      const closable = [];
      for (const t of tabs) {
        if (!action.force && (t.active || t.pinned)) continue;
        if (!action.force && (await isDirty(t.id))) continue;
        closable.push(t);
      }
      if (!closable.length) return null;
      const entries = await sendToAttic(closable, { reason: action.reason, action: action.subtype || 'close', batchId });
      await browser.tabs.remove(closable.map((t) => t.id));
      affected = closable.map(tabSummary);
      undo = { atticIds: entries.map((e) => e.id) };
      break;
    }
    case 'closeSilently': {
      // blank tabs: nothing worth keeping
      const ids = tabs.filter((t) => !t.active && !t.pinned).map((t) => t.id);
      if (!ids.length) return null;
      await browser.tabs.remove(ids);
      break;
    }
    case 'sleep': {
      const ids = tabs.filter((t) => !t.active && !t.discarded).map((t) => t.id);
      if (!ids.length) return null;
      await browser.tabs.discard(ids);
      affected = tabs.filter((t) => ids.includes(t.id)).map(tabSummary);
      break;
    }
    case 'group': {
      const movable = tabs.filter((t) => !t.pinned);
      const ids = movable.map((t) => t.id);
      if (!ids.length) return null;
      // Snapshot before anything moves: a cross-window move ungroups a tab, and undo needs to know
      // where it came from.
      const previous = tabs.map((t) => ({ id: t.id, groupId: t.groupId, windowId: t.windowId, index: t.index }));
      const previousGroups = await groupSnapshot(tabs);
      const away = action.windowId === undefined ? [] : movable.filter((t) => t.windowId !== action.windowId).map((t) => t.id);
      if (away.length) await browser.tabs.move(away, { windowId: action.windowId, index: -1 });
      const groupId = await ensureGroup(action.windowId, action.title, ids, { color: action.color, category: action.category });
      undo = { previous, previousGroups, groupId };
      action.groupId = groupId;
      break;
    }
    case 'ungroup': {
      const ids = tabs.map((t) => t.id);
      if (!ids.length) return null;
      await browser.tabs.ungroup(ids);
      for (const id of ids) await setTabMeta(id, { groupKey: null });
      break;
    }
    case 'rename': {
      const g = await browser.tabGroups.get(action.groupId);
      await browser.tabGroups.update(action.groupId, { title: action.title, ...(action.color ? { color: action.color } : {}) });
      undo = { groupId: action.groupId, title: g.title, color: g.color };
      break;
    }
    case 'collapse': {
      await browser.tabGroups.update(action.groupId, { collapsed: true });
      undo = { groupId: action.groupId };
      break;
    }
    case 'expand': {
      await browser.tabGroups.update(action.groupId, { collapsed: false });
      await touchGroup(action.groupId);
      break;
    }
    case 'hide': {
      const groupTabs = action.groupId !== undefined ? await browser.tabs.query({ groupId: action.groupId }) : tabs;
      const ids = groupTabs.filter((t) => !t.active && !t.pinned).map((t) => t.id);
      if (!ids.length) return null;
      const hidden = await browser.tabs.hide(ids);
      if (!hidden.length) return null;
      let record = null;
      if (action.groupId !== undefined) {
        const g = await browser.tabGroups.get(action.groupId);
        const key = await keyForGroup(action.groupId, groupTabs);
        record = { key, title: g.title, color: g.color, windowId: g.windowId, tabIds: hidden, hiddenAt: Date.now(), reason: action.reason };
        await updateState('hiddenGroups', {}, (h) => ({ ...h, [key]: record }));
      }
      affected = groupTabs.filter((t) => hidden.includes(t.id)).map(tabSummary);
      undo = { tabIds: hidden, key: record ? record.key : null };
      break;
    }
    case 'show': {
      const ids = action.tabIds || [];
      if (ids.length) { try { await browser.tabs.show(ids); } catch { /* some may be gone */ } }
      if (action.key) {
        const hidden = await getState('hiddenGroups', {});
        const rec = hidden[action.key];
        if (rec) {
          try { await browser.tabs.show(rec.tabIds); } catch { /* ignore */ }
          const alive = await tabsById(rec.tabIds);
          const ungrouped = alive.filter((t) => t.groupId === -1).map((t) => t.id);
          if (ungrouped.length && rec.title) {
            try { await ensureGroup(alive[0].windowId, rec.title, ungrouped, { color: rec.color }); } catch { /* best effort */ }
          }
          affected = alive.map(tabSummary);
          await updateState('hiddenGroups', {}, (h) => { const n = { ...h }; delete n[action.key]; return n; });
        }
      }
      break;
    }
    case 'readLater': {
      // Bookmark into a "Tab Steward: read later" folder, then close to the Attic.
      const folder = await readLaterFolder();
      const closable = tabs.filter((t) => !t.active && !t.pinned);
      if (!closable.length) return null;
      for (const t of closable) await browser.bookmarks.create({ parentId: folder.id, title: t.title || t.url, url: t.url });
      const entries = await sendToAttic(closable, { reason: action.reason + ' (bookmarked)', action: 'readLater', batchId });
      await browser.tabs.remove(closable.map((t) => t.id));
      affected = closable.map(tabSummary);
      undo = { atticIds: entries.map((e) => e.id) };
      break;
    }
    case 'moveGroupToWindow': {
      let windowId = action.windowId;
      const g = await browser.tabGroups.get(action.groupId);
      if (!windowId) {
        const groupTabs = await browser.tabs.query({ groupId: action.groupId });
        const w = await browser.windows.create({ tabId: groupTabs[0].id });
        windowId = w.id;
        if (groupTabs.length > 1) await browser.tabs.move(groupTabs.slice(1).map((t) => t.id), { windowId, index: -1 });
        await ensureGroup(windowId, g.title, groupTabs.map((t) => t.id), { color: g.color });
        // the new window starts with a blank tab; remove it
        const blanks = (await browser.tabs.query({ windowId })).filter((t) => t.url === 'about:blank' || t.url === 'about:newtab');
        if (blanks.length) await browser.tabs.remove(blanks.map((t) => t.id));
      } else {
        await browser.tabGroups.move(action.groupId, { windowId, index: -1 });
      }
      break;
    }
    default:
      throw new Error('Unknown action ' + type);
  }

  const entry = await addLog({ type, reason: action.reason, tabs: affected, groupId: action.groupId, title: action.title, batchId, undo, trigger: action.trigger || 'steward' });
  return entry;
}

async function readLaterFolder() {
  const title = 'Tab Steward: read later';
  const found = await browser.bookmarks.search({ title });
  const folder = found.find((b) => !b.url);
  if (folder) return folder;
  return browser.bookmarks.create({ title });
}

export async function undoBatch(batchId) {
  const log = await getState('log', []);
  const entries = log.filter((e) => e.batchId === batchId && e.undo && !e.undone);
  let count = 0;
  for (const e of entries) {
    try {
      if (e.undo.atticIds) {
        for (const id of e.undo.atticIds) if (await restoreAttic(id)) count += 1;
      } else if (e.type === 'group' && e.undo.previous) {
        const moved = (await tabsById(e.undo.previous.map((p) => p.id))).filter((t) => t.groupId === e.undo.groupId);
        const byPrev = new Map();
        for (const t of moved) { const prev = e.undo.previous.find((p) => p.id === t.id).groupId; if (!byPrev.has(prev)) byPrev.set(prev, []); byPrev.get(prev).push(t.id); }
        for (const [prev, ids] of byPrev) {
          // Tabs pulled in from another window go home first; grouping is per window.
          const home = e.undo.previous.find((p) => p.id === ids[0]).windowId;
          if (home !== undefined) {
            const away = (await tabsById(ids)).filter((t) => t.windowId !== home && !t.pinned).map((t) => t.id);
            if (away.length) { try { await browser.windows.get(home); await browser.tabs.move(away, { windowId: home, index: -1 }); } catch { /* window closed; stay */ } }
          }
          let back = false;
          if (prev !== -1) { try { await browser.tabGroups.get(prev); await browser.tabs.group({ tabIds: ids, groupId: prev }); back = true; } catch { back = false; } }
          if (!back && prev !== -1 && e.undo.previousGroups && e.undo.previousGroups[prev]) {
            // The old group emptied and Firefox dropped it: rebuild it with its title and colour.
            const was = e.undo.previousGroups[prev];
            const windowId = (await browser.tabs.get(ids[0])).windowId;
            try { await ensureGroup(windowId, was.title, ids, { color: was.color }); back = true; } catch { back = false; }
          }
          if (!back) await browser.tabs.ungroup(ids);
          count += ids.length;
        }
      } else if (e.type === 'rename') {
        await browser.tabGroups.update(e.undo.groupId, { title: e.undo.title, color: e.undo.color }); count += 1;
      } else if (e.type === 'collapse') {
        await browser.tabGroups.update(e.undo.groupId, { collapsed: false }); count += 1;
      } else if (e.type === 'hide') {
        await execute({ type: 'show', tabIds: e.undo.tabIds, key: e.undo.key, reason: 'undo' }); count += 1;
      }
    } catch { /* tab or group is gone; keep going */ }
  }
  await updateState('log', [], (l) => l.map((x) => (x.batchId === batchId ? { ...x, undone: true } : x)));
  await addLog({ type: 'undo', reason: `undid ${count} change${count === 1 ? '' : 's'}`, tabs: [], batchId });
  return count;
}

export async function lastUndoableBatch() {
  const log = await getState('log', []);
  const e = log.find((x) => x.undo && !x.undone && x.type !== 'undo');
  return e ? e.batchId : null;
}
