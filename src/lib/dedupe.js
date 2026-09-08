import { urlKey, isInternalUrl } from './urls.js';

// Groups tabs by canonical URL. Returns [{keep, close: [...tabs], key}] for every duplicate set.
export function findDuplicates(tabs, { sameWindowOnly = false } = {}) {
  const buckets = new Map();
  for (const tab of tabs) {
    if (!tab.url || isInternalUrl(tab.url) || tab.pinned) continue;
    const key = (sameWindowOnly ? tab.windowId + '|' : '') + urlKey(tab.url);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(tab);
  }
  const sets = [];
  for (const [key, list] of buckets) {
    if (list.length < 2) continue;
    // Keep the active one, else the most recently used, else the one with the most history (lowest id proxy).
    const sorted = [...list].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      if ((b.lastAccessed || 0) !== (a.lastAccessed || 0)) return (b.lastAccessed || 0) - (a.lastAccessed || 0);
      return a.id - b.id;
    });
    const keep = sorted[0];
    const close = sorted.slice(1).filter((t) => !t.audible && !(t.sharingState && (t.sharingState.camera || t.sharingState.microphone || t.sharingState.screen)));
    if (close.length) sets.push({ key, keep, close });
  }
  return sets;
}
