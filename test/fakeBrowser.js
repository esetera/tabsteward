// A small in-memory stand-in for the WebExtension APIs the steward touches.
export function makeFakeBrowser({ tabs = [], groups = [] } = {}) {
  let nextTabId = Math.max(0, ...tabs.map((t) => t.id)) + 1;
  let nextGroupId = Math.max(0, ...groups.map((g) => g.id)) + 1;
  const state = { tabs: tabs.map((t) => ({ active: false, pinned: false, hidden: false, discarded: false, audible: false, groupId: -1, windowId: 1, lastAccessed: Date.now(), ...t })), groups: [...groups], local: {}, session: {}, tabValues: {}, alarms: {}, notifications: [], bookmarks: [] };
  const listeners = () => ({ addListener() {}, removeListener() {} });
  const find = (id) => { const t = state.tabs.find((x) => x.id === id); if (!t) throw new Error('No tab ' + id); return t; };
  const storageArea = (bucket) => ({
    async get(key) { if (typeof key === 'string') return key in state[bucket] ? { [key]: clone(state[bucket][key]) } : {}; const out = {}; for (const k of key || Object.keys(state[bucket])) if (k in state[bucket]) out[k] = clone(state[bucket][k]); return out; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) state[bucket][k] = clone(v); },
    async clear() { state[bucket] = {}; }
  });
  const browser = {
    state,
    runtime: { getURL: (p) => 'moz-extension://x/' + p, onMessage: listeners(), onInstalled: listeners(), onStartup: listeners(), openOptionsPage: async () => {} },
    storage: { local: storageArea('local'), session: storageArea('session'), onChanged: listeners() },
    sessions: {
      async setTabValue(id, key, value) { state.tabValues[id] = { ...(state.tabValues[id] || {}), [key]: clone(value) }; },
      async getTabValue(id, key) { return state.tabValues[id] ? clone(state.tabValues[id][key]) : undefined; }
    },
    tabs: {
      TAB_ID_NONE: -1,
      async query(q = {}) { return state.tabs.filter((t) => Object.entries(q).every(([k, v]) => t[k] === v)).map(clone); },
      async get(id) { return clone(find(id)); },
      async remove(ids) { for (const id of [].concat(ids)) state.tabs = state.tabs.filter((t) => t.id !== id); },
      async discard(ids) { for (const id of [].concat(ids)) find(id).discarded = true; },
      async hide(ids) { const out = []; for (const id of [].concat(ids)) { const t = find(id); if (!t.active && !t.pinned) { t.hidden = true; out.push(id); } } return out; },
      async show(ids) { for (const id of [].concat(ids)) { try { find(id).hidden = false; } catch { /* gone */ } } },
      async update(id, props) { const t = find(id); if (props.active) { state.tabs.forEach((x) => { if (x.windowId === t.windowId) x.active = false; }); t.active = true; } return clone(t); },
      async move(ids, { windowId }) { for (const id of [].concat(ids)) { const t = find(id); if (windowId !== undefined) { t.windowId = windowId; t.groupId = -1; } } },
      async create(props) { const t = { id: nextTabId++, active: !!props.active, pinned: false, hidden: false, discarded: !!props.discarded, audible: false, groupId: -1, windowId: props.windowId || 1, url: props.url, title: props.title || props.url, lastAccessed: Date.now() }; state.tabs.push(t); return clone(t); },
      async group({ tabIds, groupId, createProperties }) {
        if (groupId === undefined) { groupId = nextGroupId++; state.groups.push({ id: groupId, windowId: createProperties.windowId, title: '', color: 'grey', collapsed: false }); }
        for (const id of tabIds) find(id).groupId = groupId;
        return groupId;
      },
      async ungroup(ids) { for (const id of [].concat(ids)) find(id).groupId = -1; gc(); },
      async sendMessage() { throw new Error('no content script'); },
      onCreated: listeners(), onUpdated: listeners(), onActivated: listeners(), onRemoved: listeners()
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      async query(q = {}) { gc(); return state.groups.filter((g) => Object.entries(q).every(([k, v]) => g[k] === v)).map(clone); },
      async get(id) { gc(); const g = state.groups.find((x) => x.id === id); if (!g) throw new Error('No group ' + id); return clone(g); },
      async update(id, props) { const g = state.groups.find((x) => x.id === id); Object.assign(g, props); return clone(g); },
      async move(id, { windowId }) { const g = state.groups.find((x) => x.id === id); g.windowId = windowId; state.tabs.forEach((t) => { if (t.groupId === id) t.windowId = windowId; }); },
      onCreated: listeners(), onRemoved: listeners(), onUpdated: listeners(), onMoved: listeners()
    },
    windows: { async get(id) { return { id }; }, async getLastFocused() { return { id: 1 }; }, async create(props = {}) { const id = 100 + Object.keys(state.local).length; if (props.tabId) find(props.tabId).windowId = id; else state.tabs.push({ id: nextTabId++, url: 'about:blank', title: '', windowId: id, groupId: -1, active: true }); return { id }; }, async update() {} },
    alarms: { create(name, info) { state.alarms[name] = info; }, async clear(name) { delete state.alarms[name]; }, onAlarm: listeners() },
    notifications: { async create(id, opts) { state.notifications.push(opts); return id; }, onClicked: listeners() },
    bookmarks: { async search({ title }) { return state.bookmarks.filter((b) => b.title === title); }, async create(b) { const n = { id: 'b' + state.bookmarks.length, ...b }; state.bookmarks.push(n); return n; } },
    permissions: { async contains() { return false; }, async request() { return false; }, onAdded: listeners(), onRemoved: listeners() },
    idle: { onStateChanged: listeners() }, commands: { onCommand: listeners() },
    scripting: { async getRegisteredContentScripts() { return []; }, async registerContentScripts() {}, async unregisterContentScripts() {} }
  };
  function gc() { state.groups = state.groups.filter((g) => state.tabs.some((t) => t.groupId === g.id)); }
  return browser;
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
