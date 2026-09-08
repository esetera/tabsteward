// Per-tab metadata that survives restarts, stored with sessions.setTabValue.
const KEY = 'ts';

export async function getTabMeta(tabId) {
  try {
    const v = await browser.sessions.getTabValue(tabId, KEY);
    return v || {};
  } catch { return {}; }
}

export async function setTabMeta(tabId, patch) {
  const cur = await getTabMeta(tabId);
  const next = { ...cur, ...patch };
  try { await browser.sessions.setTabValue(tabId, KEY, next); } catch { /* tab gone */ }
  return next;
}

export async function metaForTabs(tabs) {
  const out = new Map();
  await Promise.all(tabs.map(async (t) => { out.set(t.id, await getTabMeta(t.id)); }));
  return out;
}
