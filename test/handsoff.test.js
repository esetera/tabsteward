import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeBrowser } from './fakeBrowser.js';

const MIN = 60000;
const H = 60 * MIN;
const now = Date.now();
let browser, steward, store, groups;

async function boot(fixture) {
  browser = makeFakeBrowser(fixture);
  globalThis.browser = browser;
  steward = await import('../src/lib/steward.js');
  store = await import('../src/lib/store.js');
  groups = await import('../src/lib/groups.js');
}

async function context(extra = {}) {
  const settings = await store.getSettings();
  const tabs = await browser.tabs.query({});
  const meta = new Map(tabs.map((t) => [t.id, (browser.state.tabValues[t.id] || {}).ts || {}]));
  return { settings, tabs, meta, groups: await groups.listGroups(), focus: null, created: {}, used: {}, now, ...extra };
}
const grouped = (plan) => plan.filter((a) => a.type === 'group');

describe('hands off: automatic grouping leaves tabs in use alone', () => {
  beforeEach(async () => {
    await boot({ tabs: [
      { id: 1, url: 'https://github.com/a/one', title: 'one', active: true, lastAccessed: now },
      { id: 2, url: 'https://github.com/a/two', title: 'two', lastAccessed: now - 5 * MIN },
      { id: 3, url: 'https://github.com/a/three', title: 'three', lastAccessed: now - 2 * H },
      { id: 4, url: 'https://github.com/a/four', title: 'four', lastAccessed: now - 3 * H }
    ] });
  });

  it('an automatic pass groups only tabs untouched for the hands-off time', async () => {
    const plan = await steward.planTidy(await context(), { allowModel: false, handsOff: true });
    expect(grouped(plan).map((a) => a.tabIds)).toEqual([[3, 4]]);
  });

  it('a tab switched to recently counts as in use', async () => {
    const plan = await steward.planTidy(await context({ used: { 3: now - 2 * MIN } }), { allowModel: false, handsOff: true });
    expect(grouped(plan)).toEqual([]); // 4 alone is below the smallest group size
  });

  it('Tidy now (pressed by you) still sorts everything loose', async () => {
    const plan = await steward.planTidy(await context(), { allowModel: false });
    expect(grouped(plan)[0].tabIds.sort()).toEqual([1, 2, 3, 4]);
  });

  it('handsOffUntil gives the time a tab becomes eligible', async () => {
    const ctx = await context();
    expect(steward.handsOffUntil(ctx.tabs[0], ctx)).toBe(Infinity);
    expect(steward.handsOffUntil(ctx.tabs[1], ctx)).toBe(now - 5 * MIN + 20 * MIN);
    expect(steward.handsOffUntil(ctx.tabs[2], ctx)).toBe(0);
  });
});

describe('your moves stick', () => {
  beforeEach(async () => {
    await boot({ tabs: [
      { id: 1, url: 'https://github.com/a/one', title: 'one', lastAccessed: now - 3 * H },
      { id: 2, url: 'https://github.com/a/two', title: 'two', lastAccessed: now - 3 * H },
      { id: 3, url: 'https://github.com/a/three', title: 'three', lastAccessed: now - 3 * H }
    ] });
  });

  it('a tab you placed is never regrouped, not even by Rethink', async () => {
    await browser.sessions.setTabValue(3, 'ts', { userPlaced: true });
    for (const opts of [{ handsOff: true }, {}, { regroupAll: true }]) {
      const plan = await steward.planTidy(await context(), { allowModel: false, ...opts });
      expect(grouped(plan).flatMap((a) => a.tabIds)).not.toContain(3);
    }
  });

  it('ungrouping from the panel marks the tabs as yours; the steward marks its own moves', async () => {
    const r = await steward.keepTogether([1, 2]);
    const moves = (await browser.storage.session.get('stewardMoves')).stewardMoves;
    expect(Object.keys(moves).map(Number).sort()).toEqual([1, 2]);
    await steward.dissolveWorkbench(r.groupId);
    const tabs = await browser.tabs.query({});
    expect(tabs.every((t) => t.groupId === -1)).toBe(true);
    await steward.keepTogether([1, 2]);
    const [group] = await browser.tabGroups.query({});
    await steward.groupAction('ungroup', { groupId: group.id });
    expect(browser.state.tabValues[1].ts.userPlaced).toBe(true);
  });
});

describe('never into a folded group', () => {
  beforeEach(async () => {
    await boot({
      tabs: [
        { id: 10, url: 'https://github.com/x/old', title: 'old', groupId: 7, lastAccessed: now - 5 * H },
        { id: 1, url: 'https://github.com/a/one', title: 'one', lastAccessed: now - 3 * H }
      ],
      groups: [{ id: 7, windowId: 1, title: 'Dev', color: 'blue', collapsed: true }]
    });
  });

  it('joining a collapsed group waits for your OK instead of moving the tab out of sight', async () => {
    const plan = await steward.planTidy(await context(), { allowModel: false, handsOff: true });
    const join = grouped(plan).find((a) => a.title === 'Dev');
    expect(join).toMatchObject({ tabIds: [1], suggestOnly: true, expand: true });
    const r = await steward.tidy({ trigger: 'scheduled', allowModel: false });
    expect(r.suggested.some((s) => s.action?.type === 'group' || s.type === 'group')).toBe(true);
    expect((await browser.tabs.get(1)).groupId).toBe(-1);
  });

  it('approving it moves the tab and opens the group', async () => {
    await steward.tidy({ trigger: 'scheduled', allowModel: false });
    const [s] = await steward.listSuggestions();
    await steward.approveSuggestion(s.id);
    expect((await browser.tabs.get(1)).groupId).toBe(7);
    expect((await browser.tabGroups.get(7)).collapsed).toBe(false);
  });
});

describe('workbench', () => {
  beforeEach(async () => {
    await boot({ tabs: [
      { id: 1, url: 'https://news.ycombinator.com/', title: 'HN', lastAccessed: now - 300 * H, highlighted: true },
      { id: 2, url: 'https://news.ycombinator.com/', title: 'HN again', lastAccessed: now - 300 * H, highlighted: true },
      { id: 3, url: 'https://github.com/a/three', title: 'three', lastAccessed: now - 3 * H, active: true, highlighted: false }
    ] });
  });

  it('keeps the selected tabs together, then leaves them entirely alone', async () => {
    const r = await steward.keepTogether();
    expect(r).toMatchObject({ title: 'Workbench', tabCount: 2 });
    expect(await browser.tabGroups.get(r.groupId)).toMatchObject({ title: 'Workbench', color: 'grey', collapsed: false });
    const plan = await steward.planTidy(await context(), { allowModel: false, handsOff: true });
    // Stale and duplicate as they are, nothing touches them; the group is never folded.
    expect(plan.flatMap((a) => a.tabIds || [])).not.toContain(1);
    expect(plan.flatMap((a) => a.tabIds || [])).not.toContain(2);
    expect(plan.some((a) => a.groupId === r.groupId)).toBe(false);
    await steward.quick('minimise');
    expect((await browser.tabGroups.get(r.groupId)).collapsed).toBe(false);
    expect((await browser.tabs.get(1)).discarded).toBe(false);
  });

  it('a second workbench in the window is numbered; dissolving queues its tabs to be sorted later', async () => {
    await steward.keepTogether([1]);
    const second = await steward.keepTogether([2]);
    expect(second.title).toBe('Workbench 2');
    await steward.dissolveWorkbench(second.groupId);
    expect((await browser.tabs.get(2)).groupId).toBe(-1);
    expect((await browser.storage.session.get('pendingNew')).pendingNew).toContain(2);
    await expect(steward.dissolveWorkbench((await browser.tabs.get(1)).groupId).then(() => steward.dissolveWorkbench(999))).rejects.toThrow();
  });
});

describe('pause', () => {
  beforeEach(async () => {
    await boot({ tabs: [
      { id: 1, url: 'https://github.com/a/one', title: 'one', lastAccessed: now - 3 * H },
      { id: 2, url: 'https://github.com/a/two', title: 'two', lastAccessed: now - 3 * H }
    ] });
  });

  it('stops everything automatic until resumed; what you press still runs', async () => {
    await steward.setPaused(true);
    expect(await steward.tidy({ trigger: 'scheduled', allowModel: false })).toMatchObject({ skipped: 'paused' });
    expect(await steward.tidy({ trigger: 'idle', allowModel: false })).toMatchObject({ skipped: 'paused' });
    await steward.queueNewTab(1); await steward.queueNewTab(2);
    await steward.processPending();
    expect((await browser.storage.session.get('pendingNew')).pendingNew).toEqual([1, 2]);
    expect((await browser.tabs.query({})).every((t) => t.groupId === -1)).toBe(true);
    const manual = await steward.tidy({ trigger: 'manual', allowModel: false });
    expect(manual.skipped).toBeUndefined();
    await steward.setPaused(false);
    expect(await steward.isPaused()).toBe(false);
  });
});

describe('new tabs wait their turn', () => {
  beforeEach(async () => {
    await boot({ tabs: [
      { id: 1, url: 'https://github.com/a/one', title: 'one', active: true, lastAccessed: now },
      { id: 2, url: 'https://github.com/a/two', title: 'two', lastAccessed: now - 3 * H },
      { id: 3, url: 'https://github.com/a/three', title: 'three', lastAccessed: now - 3 * H }
    ] });
  });

  it('groups idle new tabs, keeps the one you are on queued and sets the alarm for it', async () => {
    for (const id of [1, 2, 3]) await steward.queueNewTab(id);
    await steward.processPending();
    expect((await browser.tabs.get(1)).groupId).toBe(-1);
    expect((await browser.tabs.get(2)).groupId).not.toBe(-1);
    expect((await browser.storage.session.get('pendingNew')).pendingNew).toEqual([1]);
    expect(browser.state.alarms['classify-pending'].when).toBeGreaterThan(Date.now());
  });
});
