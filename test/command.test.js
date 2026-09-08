import { describe, it, expect, beforeEach } from 'vitest';
import { makeFakeBrowser } from './fakeBrowser.js';

let browser;
let steward;
let actions;
let groups;

const fixture = () => ({
  tabs: [
    { id: 1, url: 'https://a.example/1', title: 't1', groupId: 10, windowId: 1, active: true },
    { id: 2, url: 'https://a.example/2', title: 't2', groupId: 10, windowId: 1 },
    { id: 3, url: 'https://a.example/3', title: 't3', groupId: 10, windowId: 1 },
    { id: 4, url: 'https://b.example/4', title: 't4', groupId: 11, windowId: 1 },
    { id: 5, url: 'https://b.example/5', title: 't5', groupId: 11, windowId: 1 },
    { id: 6, url: 'https://c.example/6', title: 't6', windowId: 1 },
    { id: 7, url: 'https://d.example/7', title: 't7', groupId: 12, windowId: 2 }
  ],
  groups: [
    { id: 10, windowId: 1, title: 'Alpha', color: 'blue', collapsed: false },
    { id: 11, windowId: 1, title: 'Beta', color: 'red', collapsed: false },
    { id: 12, windowId: 2, title: 'Far', color: 'green', collapsed: false }
  ]
});

async function boot() {
  browser = makeFakeBrowser(fixture());
  globalThis.browser = browser;
  steward = await import('../src/lib/steward.js');
  actions = await import('../src/lib/actions.js');
  groups = await import('../src/lib/groups.js');
}

const step = (op, extra) => ({ op, title: '', groupId: null, groupIds: [], tabIds: [], text: '', ...extra });
const groupOf = async (tabId) => (await browser.tabs.get(tabId)).groupId;
const byTitle = async (title) => (await browser.tabGroups.query({ title }))[0] || null;

describe('commands that create groups', () => {
  beforeEach(boot);

  it('creating a group from one tab leaves its old group intact and picks an unused colour', async () => {
    const r = await steward.runPlan([step('createGroup', { title: 'Fresh', tabIds: [2] })], 'new group Fresh with t2');
    expect(r.results.every((x) => x.ok)).toBe(true);
    const fresh = await byTitle('Fresh');
    expect(fresh).toBeTruthy();
    expect(fresh.windowId).toBe(1);
    expect(fresh.color).toBe('yellow'); // blue and red are taken by Alpha and Beta
    expect(await groupOf(2)).toBe(fresh.id);
    expect(await groupOf(1)).toBe(10);
    expect(await groupOf(3)).toBe(10);
    expect((await browser.tabGroups.query({ title: 'Alpha' })).length).toBe(1);
    expect((await browser.tabGroups.query({ title: 'Beta' })).length).toBe(1);
  });

  it('a new group goes in the focused window, not the window of the first listed tab', async () => {
    const r = await steward.runPlan([step('createGroup', { title: 'Pulled', tabIds: [7, 3] })], 'x');
    expect(r.results[0].ok).toBe(true);
    const pulled = await byTitle('Pulled');
    expect(pulled.windowId).toBe(1);
    expect((await browser.tabs.get(7)).windowId).toBe(1);
    expect(await groupOf(7)).toBe(pulled.id);
    expect(await groupOf(3)).toBe(pulled.id);
  });

  it('creating a group whose title already exists adds to it', async () => {
    await steward.runPlan([step('createGroup', { title: 'alpha', tabIds: [6] })], 'x');
    expect(await groupOf(6)).toBe(10);
    expect((await browser.tabGroups.query({ windowId: 1 })).length).toBe(2);
  });

  it('assessPlan flags tabs leaving other groups, cross-window moves, and title clashes', async () => {
    const tabs = await browser.tabs.query({});
    const list = await groups.listGroups();
    const loose = await steward.assessPlan([step('createGroup', { title: 'Fresh', tabIds: [6] })], list, tabs);
    expect(loose).toEqual([]);
    const notes = await steward.assessPlan([step('createGroup', { title: 'Mixed', tabIds: [1, 4, 5, 6, 7] })], list, tabs);
    expect(notes).toContain('Takes 1 tab out of “Alpha”');
    expect(notes).toContain('Takes 2 tabs out of “Beta”, which empties it');
    expect(notes).toContain('Moves 1 tab in from another window');
    const clash = await steward.assessPlan([step('createGroup', { title: 'Beta', tabIds: [6] })], list, tabs);
    expect(clash[0]).toMatch(/already exists/);
    const add = await steward.assessPlan([step('addToGroup', { groupId: 10, tabIds: [2, 6] })], list, tabs);
    expect(add).toEqual([]);
    const un = await steward.assessPlan([step('ungroup', { tabIds: [1, 2] })], list, tabs);
    expect(un).toEqual(['Ungroups 2 tabs']);
  });

  it('undo rebuilds a group that the command emptied, and sends tabs back to their window', async () => {
    const r = await steward.runPlan([step('createGroup', { title: 'Mixed', tabIds: [4, 5, 7] })], 'x');
    expect(await byTitle('Beta')).toBeNull();
    expect(await byTitle('Far')).toBeNull();
    const n = await actions.undoBatch(r.batchId);
    expect(n).toBe(3);
    const beta = await byTitle('Beta');
    expect(beta).toBeTruthy();
    expect(beta.color).toBe('red');
    expect(await groupOf(4)).toBe(beta.id);
    expect(await groupOf(5)).toBe(beta.id);
    const far = await byTitle('Far');
    expect(far).toBeTruthy();
    expect(far.windowId).toBe(2);
    expect((await browser.tabs.get(7)).windowId).toBe(2);
    expect(await groupOf(7)).toBe(far.id);
    expect(await byTitle('Mixed')).toBeNull();
  });
});
