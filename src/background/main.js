// Background event page: wires browser events to the steward and serves the UI over runtime messages.
import * as steward from '../lib/steward.js';
import { getSettings, saveSettings, getState, setState, updateState, updateSession, getSession, setSession } from '../lib/store.js';
import { rebuildGroupKeys, touchGroup } from '../lib/groups.js';
import { setTabMeta, wasStewardMove } from '../lib/tabmeta.js';
import { restoreAttic, deleteAttic, pruneAttic, undoBatch } from '../lib/actions.js';
import { isInternalUrl, isEphemeral, isBlankTab } from '../lib/urls.js';
import { providerStatus, getSpend, runTask, discoverModels } from '../lib/llm.js';
import { PROVIDERS, resolveProvider, originForBase, isLocalProvider } from '../lib/providers.js';
import { describeRule, validateRules } from '../lib/rules.js';

const CONTENT_SCRIPT_ID = 'ts-formguard';

// ---------- pause badge and menus ----------

async function showPaused() {
  const paused = await steward.isPaused();
  try {
    await browser.action.setBadgeText({ text: paused ? 'II' : '' });
    await browser.action.setBadgeBackgroundColor({ color: '#8a6d00' });
    await browser.action.setTitle({ title: paused ? 'Tab Steward (paused: nothing automatic runs until you resume)' : 'Tab Steward' });
    await browser.menus.update('ts-pause', { title: paused ? 'Resume Tab Steward' : 'Pause Tab Steward' });
  } catch { /* menus not created yet */ }
}

async function createMenus() {
  await browser.menus.removeAll();
  browser.menus.create({ id: 'ts-keep-together', contexts: ['tab'], title: 'Keep these tabs together (Workbench)' });
  browser.menus.create({ id: 'ts-pause', contexts: ['action'], title: 'Pause Tab Steward' });
  await showPaused();
}

async function togglePause() {
  await steward.setPaused(!(await steward.isPaused()));
  await showPaused();
}

async function keepTogetherFrom(tab) {
  // Right-clicking one of several selected tabs keeps all the selected ones together.
  const ids = tab && tab.highlighted ? (await browser.tabs.query({ windowId: tab.windowId, highlighted: true })).map((t) => t.id) : tab ? [tab.id] : undefined;
  try { await steward.keepTogether(ids); } catch (e) { notify(String(e.message || e)); }
}

function notify(message) {
  try { browser.notifications.create({ type: 'basic', title: 'Tab Steward', message, iconUrl: browser.runtime.getURL('icons/icon.svg') }); } catch { /* notifications off */ }
}

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'ts-keep-together') await keepTogetherFrom(tab);
  else if (info.menuItemId === 'ts-pause') await togglePause();
});

async function scheduleTidy() {
  const settings = await getSettings();
  await browser.alarms.clear('tidy');
  if (settings.autoTidy) browser.alarms.create('tidy', { periodInMinutes: Math.max(5, settings.tidyIntervalMinutes || 15) });
  browser.alarms.create('attic-prune', { periodInMinutes: 24 * 60 });
}

async function ensureContentScript() {
  try {
    const granted = await browser.permissions.contains({ origins: ['<all_urls>'] });
    const registered = await browser.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (granted && !registered.length) {
      await browser.scripting.registerContentScripts([{ id: CONTENT_SCRIPT_ID, js: ['src/content/formguard.js'], matches: ['<all_urls>'], runAt: 'document_idle', persistAcrossSessions: true }]);
    } else if (!granted && registered.length) {
      await browser.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    }
  } catch { /* scripting unavailable */ }
}

// Local model servers (Ollama in particular) refuse browser requests whose Origin is an extension.
// Strip the Origin header on this extension's own requests to loopback hosts so a local model works
// without the user editing OLLAMA_ORIGINS. Only our requests are touched, and only to localhost.
const SELF = browser.runtime.getURL('').replace(/\/$/, '');
try {
  browser.webRequest.onBeforeSendHeaders.addListener((details) => {
    if (!(details.originUrl || '').startsWith(SELF) && !(details.documentUrl || '').startsWith(SELF)) return {};
    const requestHeaders = details.requestHeaders.filter((h) => h.name.toLowerCase() !== 'origin');
    return { requestHeaders };
  }, { urls: ['http://localhost/*', 'http://127.0.0.1/*'] }, ['blocking', 'requestHeaders']);
} catch { /* webRequest blocking unavailable; the user can set OLLAMA_ORIGINS instead */ }

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  await scheduleTidy();
  await rebuildGroupKeys();
  await ensureContentScript();
  await createMenus();
  if (reason === 'install') browser.runtime.openOptionsPage();
});

browser.runtime.onStartup.addListener(async () => {
  await createMenus();
  await scheduleTidy();
  await rebuildGroupKeys();
  await ensureContentScript();
});

browser.tabs.onCreated.addListener(async (tab) => {
  await updateSession('tabCreated', {}, (m) => ({ ...m, [tab.id]: Date.now() }));
});

browser.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status !== 'complete') return;
  if (tab.groupId !== -1 || tab.pinned || isInternalUrl(tab.url)) return;
  const seen = await getSession('classified', {});
  if (seen[tabId] === tab.url) return;
  await updateSession('classified', {}, (m) => ({ ...m, [tabId]: tab.url }));
  const settings = await getSettings();
  if (settings.autoGroupNewTabs) await steward.queueNewTab(tabId);
}, { properties: ['status'] });

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  // Hands off: a tab switched to is in use, so automatic grouping waits.
  await updateSession('tabUsed', {}, (m) => ({ ...m, [tabId]: Date.now() }));
  try {
    const t = await browser.tabs.get(tabId);
    await touchGroup(t.groupId);
  } catch { /* gone */ }
});

// A group change the steward did not make is the user's: that placement sticks.
browser.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!('groupId' in change)) return;
  if (await wasStewardMove(tabId)) return;
  await setTabMeta(tabId, { userPlaced: true, userPlacedAt: Date.now() });
  await updateSession('tabUsed', {}, (m) => ({ ...m, [tabId]: Date.now() }));
});

browser.tabs.onRemoved.addListener(async (tabId) => {
  await updateSession('tabCreated', {}, (m) => { const n = { ...m }; delete n[tabId]; return n; });
  await updateSession('classified', {}, (m) => { const n = { ...m }; delete n[tabId]; return n; });
  await updateSession('tabUsed', {}, (m) => { const n = { ...m }; delete n[tabId]; return n; });
});

browser.tabGroups.onRemoved.addListener(async (group) => {
  await updateSession('groupKeys', {}, (m) => { const n = { ...m }; delete n[group.id]; return n; });
  await updateSession('groupActivity', {}, (m) => { const n = { ...m }; delete n[group.id]; return n; });
});

browser.tabGroups.onCreated.addListener(async (group) => {
  await touchGroup(group.id);
});

browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'tidy') await steward.tidy({ trigger: 'scheduled' });
  else if (alarm.name === 'attic-prune') await pruneAttic();
  else if (alarm.name === 'focus-end') await steward.endFocus();
  else if (alarm.name === 'classify-pending') await steward.processPending();
});

browser.idle.onStateChanged.addListener(async (state) => {
  if (state !== 'idle') return;
  const settings = await getSettings();
  if (settings.autoTidy) await steward.tidy({ trigger: 'idle' });
});

browser.commands.onCommand.addListener(async (command) => {
  if (command === 'tidy-now') await steward.tidy({ trigger: 'shortcut' });
  else if (command === 'undo-last') await steward.undoLast();
  else if (command === 'cleanup') await steward.quick('cleanup');
  else if (command === 'minimise') await steward.quick('minimise');
  else if (command === 'keep-together') await keepTogetherFrom((await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0]);
  else if (command === 'pause') await togglePause();
});

browser.notifications.onClicked.addListener(async () => {
  await browser.tabs.create({ url: browser.runtime.getURL('src/panel/panel.html?mode=page') });
});

browser.permissions.onAdded.addListener(ensureContentScript);
browser.permissions.onRemoved.addListener(ensureContentScript);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) scheduleTidy();
});

async function testProvider(settings) {
  const provider = resolveProvider(settings);
  if (!provider) throw new Error('Provider not configured (missing key?)');
  const origin = provider.id === 'custom' || isLocalProvider(provider) ? originForBase(provider.base) : provider.def.origin;
  if (origin) {
    const ok = await browser.permissions.contains({ origins: [origin] });
    if (!ok) throw new Error(`Firefox has not granted access to ${origin}. Click "Grant access" first.`);
  }
  const r = await runTask('test', { system: 'Reply with JSON only.', user: 'Return {"ok": true}', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, maxTokens: 64 });
  return { ok: !!(r.json && r.json.ok), model: r.model, usage: r.usage, text: r.text.slice(0, 100) };
}

const handlers = {
  overview: () => steward.overview(),
  popupOpened: () => steward.markPopupOpen(),
  tidy: (m) => steward.tidy({ trigger: m.regroupAll ? 'rethink' : 'manual', allowModel: m.allowModel !== false, regroupAll: !!m.regroupAll }),
  preview: (m) => steward.preview({ allowModel: !!m.allowModel }),
  quick: (m) => steward.quick(m.kind),
  undoLast: () => steward.undoLast(),
  suggestions: () => steward.listSuggestions(),
  approve: (m) => steward.approveSuggestion(m.id),
  dismiss: (m) => steward.dismissSuggestion(m.id),
  dismissAll: () => steward.dismissAllSuggestions(),
  groupAction: (m) => steward.groupAction(m.kind, m),
  showHidden: (m) => steward.showHiddenGroup(m.key),
  gather: (m) => steward.gatherGroups(m.title),
  createGroup: (m) => steward.createGroupFromTabs(m.tabIds, m.title, m.windowId),
  'tabs:activate': async (m) => { const t = await browser.tabs.update(m.tabId, { active: true }); await browser.windows.update(t.windowId, { focused: true }); return true; },
  'tabs:close': (m) => steward.closeTabs(m.tabIds, m.reason),
  'tabs:ungroup': (m) => steward.ungroupTabs(m.tabIds),
  'tabs:moveToGroup': (m) => steward.moveTabsToGroup(m.tabIds, m.groupId),
  'group:reorder': (m) => steward.reorderGroup(m.groupId, m.beforeGroupId),
  'tabs:sleep': (m) => steward.sleepTabs(m.tabIds),
  ask: (m) => steward.ask(m.query),
  command: (m) => steward.command(m.text, { execute: m.execute !== false }),
  'command:run': (m) => steward.runPlan(m.steps, m.text || ''),
  'attic:list': () => getState('attic', []),
  'attic:restore': (m) => restoreAttic(m.id, { activate: !!m.activate }),
  'attic:restoreBatch': async (m) => { let n = 0; for (const id of m.ids) if (await restoreAttic(id)) n += 1; return n; },
  'attic:delete': (m) => deleteAttic(m.id),
  'attic:clear': () => setState('attic', []),
  'log:list': () => getState('log', []),
  'log:undo': (m) => undoBatch(m.batchId),
  'projects:list': () => steward.listProjects(),
  'projects:save': (m) => steward.saveProject(m.name, { windowId: m.windowId }),
  'projects:restore': (m) => steward.restoreProject(m.id),
  'projects:delete': (m) => steward.deleteProject(m.id),
  'projects:endOfDay': () => steward.endOfDay(),
  'focus:start': (m) => steward.startFocus(m.groupId, m.minutes),
  'focus:end': () => steward.endFocus(),
  'focus:status': () => steward.focusStatus(),
  'pause:get': () => steward.pauseStatus(),
  'pause:set': async (m) => { const r = await steward.setPaused(!!m.paused); await showPaused(); return r; },
  'workbench:keep': (m) => steward.keepTogether(m.tabIds),
  'workbench:dissolve': (m) => steward.dissolveWorkbench(m.groupId),
  'note:set': (m) => steward.setNote(m.tabId, m.note),
  'note:draft': (m) => steward.draftNote(m.tabId),
  'settings:get': () => getSettings(),
  'settings:save': (m) => saveSettings(m.patch),
  'policy:compile': (m) => steward.compilePolicy(m.text),
  'policy:describe': (m) => validateRules(m.rules).map(describeRule),
  'provider:test': async (m) => testProvider(m.settings || (await getSettings())),
  'provider:list': () => PROVIDERS,
  'provider:models': (m) => discoverModels(m.settings),
  'provider:status': () => providerStatus(),
  spend: () => getSpend(),
  'spend:reset': () => setState('spend', {}),
  sendLog: () => getState('sendLog', []),
  'sendLog:clear': () => setState('sendLog', []),
  'cache:clear': () => setState('classifyCache', {}),
  'permissions:contains': (m) => browser.permissions.contains({ origins: m.origins }),
  'windows:list': () => browser.windows.getAll({ populate: false }),
  diag: async () => {
    let sessionOk = false;
    try { await browser.storage.session.set({ __probe: 1 }); sessionOk = (await browser.storage.session.get('__probe')).__probe === 1; } catch { sessionOk = false; }
    const tabs = await browser.tabs.query({});
    return { sessionOk, tabCreated: await getSession('tabCreated', {}), tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, active: t.active, pinned: t.pinned, hidden: t.hidden, lastAccessed: t.lastAccessed, ephemeral: isEphemeral(t), blank: isBlankTab(t), internal: isInternalUrl(t.url) })) };
  },
  'reset': async () => { await browser.storage.local.clear(); await scheduleTidy(); return true; }
};

browser.runtime.onMessage.addListener((message, sender) => {
  const handler = handlers[message && message.type];
  if (!handler) return Promise.resolve({ error: 'unknown message ' + (message && message.type) });
  return Promise.resolve()
    .then(() => handler(message, sender))
    .then((result) => ({ ok: true, result }))
    .catch((e) => ({ ok: false, error: String(e && e.message ? e.message : e), kind: e && e.constructor ? e.constructor.name : 'Error' }));
});
