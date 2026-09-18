import { markStewardMove } from './tabmeta.js';
// Native tab group helpers. Groups get a stable key (stored on their tabs) because Firefox may
// hand a restored group a different id.
import { getSession, updateSession, uid } from './store.js';
import { getTabMeta, setTabMeta } from './tabmeta.js';
import { classifyHeuristic, colorFor } from './categories.js';

export const NONE = -1;

export async function touchGroup(groupId) {
  if (groupId === undefined || groupId === NONE) return;
  await updateSession('groupActivity', {}, (m) => ({ ...m, [groupId]: Date.now() }));
}

export async function groupActivity() {
  return getSession('groupActivity', {});
}

export async function keyForGroup(groupId, tabs) {
  const keys = await getSession('groupKeys', {});
  if (keys[groupId]) return keys[groupId];
  const counts = new Map();
  for (const t of tabs) {
    const meta = await getTabMeta(t.id);
    if (meta.groupKey) counts.set(meta.groupKey, (counts.get(meta.groupKey) || 0) + 1);
  }
  let key = null;
  let best = 0;
  for (const [k, n] of counts) if (n > best) { best = n; key = k; }
  if (!key) key = uid('g');
  await updateSession('groupKeys', {}, (m) => ({ ...m, [groupId]: key }));
  await Promise.all(tabs.filter((t) => true).map((t) => setTabMeta(t.id, { groupKey: key })));
  return key;
}

export function majorityCategory(tabs) {
  const counts = {};
  for (const t of tabs) {
    const c = classifyHeuristic(t).category;
    counts[c] = (counts[c] || 0) + 1;
  }
  let best = 'Misc';
  let n = 0;
  for (const [c, k] of Object.entries(counts)) if (k > n && c !== 'Misc') { n = k; best = c; }
  return best;
}

// Full picture of every group with its tabs.
export async function listGroups({ windowId } = {}) {
  const groups = await browser.tabGroups.query(windowId !== undefined ? { windowId } : {});
  const activity = await groupActivity();
  const out = [];
  for (const g of groups) {
    const tabs = await browser.tabs.query({ groupId: g.id });
    const key = await keyForGroup(g.id, tabs);
    const lastAccessed = Math.max(0, ...tabs.map((t) => t.lastAccessed || 0));
    out.push({
      id: g.id, windowId: g.windowId, title: g.title || '', color: g.color, collapsed: g.collapsed, key,
      tabs, category: majorityCategory(tabs), hasActive: tabs.some((t) => t.active),
      lastActive: Math.max(activity[g.id] || 0, lastAccessed),
      sampleTitles: tabs.slice(0, 4).map((t) => (t.title || '').slice(0, 60))
    });
  }
  return out;
}

export const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

// A colour for a new group that stands apart from the groups already in the window: the least-used
// one, grey last. A grey group beside a grey group reads as one group in the tab strip.
export async function pickColor(windowId) {
  const groups = await browser.tabGroups.query(windowId !== undefined ? { windowId } : {});
  const used = new Map(GROUP_COLORS.map((c) => [c, 0]));
  for (const g of groups) if (used.has(g.color)) used.set(g.color, used.get(g.color) + 1);
  let best = 'grey';
  let n = Infinity;
  for (const c of GROUP_COLORS) if (used.get(c) < n) { n = used.get(c); best = c; }
  return best;
}

// Snapshot of the groups these tabs are in right now, so an undo can rebuild a group that emptied.
export async function groupSnapshot(tabs) {
  const out = {};
  for (const t of tabs) {
    if (t.groupId === undefined || t.groupId === NONE || out[t.groupId]) continue;
    try {
      const g = await browser.tabGroups.get(t.groupId);
      out[t.groupId] = { title: g.title || '', color: g.color, windowId: g.windowId, collapsed: !!g.collapsed };
    } catch { /* gone already */ }
  }
  return out;
}

export async function findGroupByTitle(windowId, title) {
  const groups = await browser.tabGroups.query({ windowId });
  const t = title.trim().toLowerCase();
  return groups.find((g) => (g.title || '').trim().toLowerCase() === t) || null;
}

// Add tabs to the group with this title in the window, creating it if needed. Returns groupId.
export async function ensureGroup(windowId, title, tabIds, { color, category } = {}) {
  if (!tabIds.length) return NONE;
  const existing = await findGroupByTitle(windowId, title);
  let groupId;
  if (existing) {
    const already = new Set((await browser.tabs.query({ groupId: existing.id })).map((t) => t.id));
    const toAdd = tabIds.filter((id) => !already.has(id));
    if (toAdd.length) { await markStewardMove(toAdd); await browser.tabs.group({ tabIds: toAdd, groupId: existing.id }); }
    groupId = existing.id;
  } else {
    await markStewardMove(tabIds);
    groupId = await browser.tabs.group({ tabIds, createProperties: { windowId } });
    await browser.tabGroups.update(groupId, { title, color: color || colorFor(category || 'Misc') });
  }
  const tabs = await browser.tabs.query({ groupId });
  const key = await keyForGroup(groupId, tabs);
  await Promise.all(tabIds.map((id) => setTabMeta(id, { groupKey: key })));
  await touchGroup(groupId);
  return groupId;
}

export async function rebuildGroupKeys() {
  const groups = await browser.tabGroups.query({});
  for (const g of groups) {
    const tabs = await browser.tabs.query({ groupId: g.id });
    await keyForGroup(g.id, tabs);
  }
}
