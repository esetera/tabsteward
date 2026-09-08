import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeBrowser } from './fakeBrowser.js';

const H = 3600000;
let browser;
let steward;
let store;
let actions;

async function boot(fixture) {
  browser = makeFakeBrowser(fixture);
  globalThis.browser = browser;
  steward = await import('../src/lib/steward.js');
  store = await import('../src/lib/store.js');
  actions = await import('../src/lib/actions.js');
}

const now = Date.now();
const fixture = () => ({
  tabs: [
    { id: 1, url: 'https://github.com/a/b', title: 'a/b repo', active: true, lastAccessed: now },
    { id: 2, url: 'https://github.com/a/b/issues', title: 'Issues', lastAccessed: now - 1 * H },
    { id: 3, url: 'https://www.amazon.com/dp/1?utm_source=x', title: 'Widget', lastAccessed: now - 2 * H },
    { id: 4, url: 'https://amazon.com/dp/1', title: 'Widget', lastAccessed: now - 3 * H },
    { id: 5, url: 'https://example.com/oauth2/callback?code=1&state=2', title: 'Redirecting', lastAccessed: now - 1 * H },
    { id: 6, url: 'about:newtab', title: 'New Tab', lastAccessed: now - 1 * H },
    { id: 7, url: 'https://news.ycombinator.com/', title: 'HN', lastAccessed: now - 200 * H },
    { id: 8, url: 'https://www.bbc.com/news/x', title: 'BBC', lastAccessed: now - 60 * H },
    { id: 9, url: 'https://mail.google.com/', title: 'Inbox', pinned: true, lastAccessed: now - 300 * H },
    { id: 10, url: 'https://www.ebay.com/itm/9', title: 'Gadget', lastAccessed: now - 2 * H }
  ]
});

describe('steward end to end (fake browser, no model)', () => {
  beforeEach(async () => { await boot(fixture()); });

  it('plans the expected actions', async () => {
    const settings = await store.getSettings();
    const ctx = { settings, tabs: await browser.tabs.query({}), meta: new Map(), groups: [], focus: null, created: { 6: now - 20 * 60000, 5: now - 20 * 60000 }, now };
    const plan = await steward.planTidy(ctx, { allowModel: false });
    const types = plan.map((a) => a.type + ':' + (a.subtype || a.title || ''));
    expect(types).toContain('closeSilently:');
    expect(types).toContain('close:ephemeral');
    expect(types).toContain('close:duplicate');
    expect(types).toContain('group:Dev');
    expect(types).toContain('group:Shopping');
    expect(types).toContain('close:stale');
    const stale = plan.filter((a) => a.subtype === 'stale');
    expect(stale.map((a) => a.tabIds[0])).toEqual([7]);
    expect(plan.some((a) => a.type === 'sleep' && a.tabIds.includes(8))).toBe(true);
    expect(plan.every((a) => !(a.tabIds || []).includes(9))).toBe(true);
  });

  it('executes auto actions, queues confirmations, records the Attic and undoes', async () => {
    await browser.storage.session.set({ tabCreated: { 5: now - 20 * 60000, 6: now - 20 * 60000 } });
    const r = await steward.tidy({ trigger: 'test', allowModel: false });
    expect(r.executed.length).toBeGreaterThan(0);
    const remaining = (await browser.tabs.query({})).map((t) => t.id);
    expect(remaining).not.toContain(5); // ephemeral closed (auto)
    expect(remaining).not.toContain(6); // blank closed (auto)
    expect(remaining).not.toContain(4); // duplicate closed (auto), tab 3 kept as more recent
    expect(remaining).toContain(3);
    expect(remaining).toContain(7); // stale close is "confirm" by default -> suggestion
    const groups = await browser.tabGroups.query({});
    expect(groups.map((g) => g.title).sort()).toEqual(['Dev', 'News', 'Shopping']);
    const attic = await browser.storage.local.get('attic');
    expect(attic.attic.map((e) => e.tabId).sort()).toEqual([4, 5]);
    expect(attic.attic.every((e) => e.reason)).toBe(true);
    const suggestions = await steward.listSuggestions();
    expect(suggestions.some((s) => s.action.type === 'close' && s.action.tabIds[0] === 7)).toBe(true);
    expect(browser.state.notifications.length).toBe(1);
    // approve the stale close, then undo everything from the batch of the tidy
    const sug = suggestions.find((s) => s.action.tabIds && s.action.tabIds[0] === 7);
    await steward.approveSuggestion(sug.id);
    expect((await browser.tabs.query({})).map((t) => t.id)).not.toContain(7);
    const n = await steward.undoLast();
    expect(n).toBe(1);
    expect((await browser.tabs.query({})).some((t) => t.url === 'https://news.ycombinator.com/')).toBe(true);
    const undone = await actions.undoBatch(r.batchId);
    expect(undone).toBeGreaterThanOrEqual(2);
    const urls = (await browser.tabs.query({})).map((t) => t.url);
    expect(urls).toContain('https://example.com/oauth2/callback?code=1&state=2');
  });

  it('respects the policy: protected sites are never closed and rule groups win', async () => {
    await steward.compilePolicy('Never close news.ycombinator.com.\nKeep github.com under Work.');
    await browser.storage.session.set({ tabCreated: {} });
    await steward.tidy({ trigger: 'test', allowModel: false });
    expect((await browser.tabs.query({})).map((t) => t.id)).toContain(7);
    const groups = await browser.tabGroups.query({});
    expect(groups.map((g) => g.title)).toContain('Work');
    expect(groups.map((g) => g.title)).not.toContain('Dev');
    const sugs = await steward.listSuggestions();
    expect(sugs.every((s) => !(s.action.tabIds || []).includes(7))).toBe(true);
  });

  it('dismissing a suggestion snoozes the tab', async () => {
    await browser.storage.session.set({ tabCreated: {} });
    await steward.tidy({ trigger: 'test', allowModel: false });
    const sug = (await steward.listSuggestions()).find((s) => s.action.tabIds && s.action.tabIds[0] === 7);
    await steward.dismissSuggestion(sug.id);
    await steward.tidy({ trigger: 'test', allowModel: false });
    expect((await steward.listSuggestions()).some((s) => s.action.tabIds && s.action.tabIds[0] === 7)).toBe(false);
    const meta = await browser.sessions.getTabValue(7, 'ts');
    expect(meta.snoozedUntil).toBeGreaterThan(now);
  });

  it('focus mode hides everything outside the group and brings it back', async () => {
    await browser.storage.session.set({ tabCreated: {} });
    await steward.tidy({ trigger: 'test', allowModel: false });
    const dev = (await browser.tabGroups.query({})).find((g) => g.title === 'Dev');
    const f = await steward.startFocus(dev.id, 25);
    expect(f.hidden).toBeGreaterThan(0);
    const hiddenIds = (await browser.tabs.query({ hidden: true })).map((t) => t.id);
    expect(hiddenIds).toContain(7);
    expect(hiddenIds).not.toContain(1);
    expect(hiddenIds).not.toContain(9); // pinned never hidden
    expect(browser.state.alarms['focus-end']).toBeTruthy();
    await steward.endFocus();
    expect((await browser.tabs.query({ hidden: true })).length).toBe(0);
  });

  it('hide and show a group by stable key, and gather groups across windows', async () => {
    await browser.storage.session.set({ tabCreated: {} });
    await steward.tidy({ trigger: 'test', allowModel: false });
    const shop = (await browser.tabGroups.query({})).find((g) => g.title === 'Shopping');
    await steward.groupAction('hide', { groupId: shop.id });
    const hidden = await steward.hiddenGroups();
    expect(hidden.length).toBe(1);
    expect(hidden[0].title).toBe('Shopping');
    await steward.showHiddenGroup(hidden[0].key);
    expect((await steward.hiddenGroups()).length).toBe(0);
    // second window with its own Dev group
    await browser.tabs.create({ url: 'https://gitlab.com/x', title: 'gl', windowId: 2 });
    await browser.tabs.create({ url: 'https://stackoverflow.com/q/1', title: 'so', windowId: 2 });
    await steward.tidy({ trigger: 'test', allowModel: false });
    expect((await browser.tabGroups.query({ title: 'Dev' })).length).toBe(2);
    const moved = await steward.gatherGroups('Dev');
    expect(moved).toBe(2);
    expect((await browser.tabGroups.query({ title: 'Dev' })).length).toBe(1);
  });

  it('projects: save, end of day, restore', async () => {
    await browser.storage.session.set({ tabCreated: {} });
    await steward.tidy({ trigger: 'test', allowModel: false });
    const r = await steward.endOfDay();
    expect(r.project.groups.map((g) => g.title).sort()).toEqual(['Dev', 'News', 'Shopping']);
    expect(r.closed).toBeGreaterThan(0);
    expect((await browser.tabGroups.query({})).length).toBe(0);
    const winId = await steward.restoreProject(r.project.id);
    const restored = await browser.tabGroups.query({ windowId: winId });
    expect(restored.map((g) => g.title).sort()).toEqual(['Dev', 'News', 'Shopping']);
    const ov = await steward.overview();
    expect(ov.counts.groups).toBe(3);
    expect(ov.atticCount).toBeGreaterThan(0);
  });
});
