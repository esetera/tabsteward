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

// Group changes the steward makes itself are recorded briefly, so a group change it did not make
// can be recognised as the user's (and then stick: see userPlaced).
const STEWARD_MOVE_MS = 5000;
export async function markStewardMove(tabIds) {
  const now = Date.now();
  const { stewardMoves = {} } = await browser.storage.session.get('stewardMoves');
  const next = Object.fromEntries(Object.entries(stewardMoves).filter(([, ts]) => now - ts < STEWARD_MOVE_MS * 4));
  for (const id of tabIds) next[id] = now;
  await browser.storage.session.set({ stewardMoves: next });
}
export async function wasStewardMove(tabId) {
  const { stewardMoves = {} } = await browser.storage.session.get('stewardMoves');
  return Date.now() - (stewardMoves[tabId] || 0) < STEWARD_MOVE_MS;
}
