// Real-Firefox smoke test: node test/smoke.mjs [--visible]
// Launches Firefox with a throwaway profile, installs the add-on temporarily, opens some tabs,
// runs the steward through its own message API, and reports console errors from the extension.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Marionette } from './marionette.mjs';

const FIREFOX = process.env.FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const visible = process.argv.includes('--visible');
const withOllama = process.argv.includes('--ollama');
const quick = process.argv.includes('--quick');
const shot = process.argv.includes('--shot');
const SHOT_DIR = process.env.SCRATCH || tmpdir();
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const step = (name) => console.log('   … ' + name);
const profile = mkdtempSync(path.join(process.env.SCRATCH || tmpdir(), 'tabsteward-prof-'));
writeFileSync(path.join(profile, 'user.js'), [
  'user_pref("marionette.port", 2828);',
  'user_pref("remote.log.level", "Warn");',
  'user_pref("remote.system-access-check.enabled", false);',
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.webextensions.remote", true);',
  'user_pref("browser.tabs.groups.enabled", true);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("browser.startup.page", 0);',
  'user_pref("devtools.console.stdout.content", true);',
  'user_pref("browser.tabs.warnOnClose", false);'
].join('\n'));

try { (await import('node:child_process')).execSync('pkill -9 -f tabsteward-prof- || true'); } catch { /* none running */ }
const args = ['-marionette', '-remote-allow-system-access', '-no-remote', '-profile', profile, 'about:blank'];
if (!visible) args.unshift('-headless');
const ff = spawn(FIREFOX, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let stdout = '';
ff.stdout.on('data', (d) => { stdout += d; });
ff.stderr.on('data', (d) => { stdout += d; });

const m = new Marionette(2828);
const watchdog = setTimeout(() => { console.log('FAIL  watchdog: smoke run exceeded 520 s'); try { ff.kill('SIGKILL'); } catch { /* gone */ } process.exit(2); }, 520000);
let failures = 0;
const check = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`); if (!cond) failures += 1; };

try {
  await m.connect();
  await m.newSession();
  await m.send('WebDriver:SetTimeouts', { script: 180000, pageLoad: 60000, implicit: 0 });
  await m.chrome();

  const addonId = await m.execAsync(`
    const [dir, done] = arguments;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    AddonManager.installTemporaryAddon(new FileUtils.File(dir)).then((a) => done(a.id), (e) => done("ERROR: " + e));
  `, [ROOT]);
  check(addonId === 'tabsteward@pure.science', 'temporary add-on installed', addonId);
  await new Promise((r) => setTimeout(r, 2500));

  const uuid = await m.exec(`return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))["tabsteward@pure.science"];`);
  check(!!uuid, 'extension uuid resolved', uuid);
  const base = `moz-extension://${uuid}/`;

  // Grant the localhost host permission and open a mix of tabs the steward should act on.
  await m.execAsync(`
    const [urls, done] = arguments;
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    for (const u of urls) win.gBrowser.addTab(u, { triggeringPrincipal: principal });
    setTimeout(() => done(win.gBrowser.tabs.length), 3000);
  `, [[
    'https://example.com/', 'https://example.com/?utm_source=dup', 'https://example.com/about', 'https://example.org/',
    'https://www.iana.org/domains/reserved', 'https://example.net/oauth2/callback?code=1&state=2', 'about:newtab'
  ]]);

  // Drive the steward from its own page (content context, extension principal): every message the UI uses.
  await m.exec(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const tab = win.gBrowser.addTab(${JSON.stringify(base + 'src/panel/panel.html?mode=page')}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
  `);
  await new Promise((r) => setTimeout(r, 2500));
  await m.content();
  const handles = await m.send('WebDriver:GetWindowHandles');
  let found = false;
  for (const hnd of handles) {
    await m.send('WebDriver:SwitchToWindow', { handle: hnd });
    const url = await m.send('WebDriver:GetCurrentURL');
    if (String(url.value).startsWith(base + 'src/panel')) { found = true; break; }
  }
  check(found, 'switched to the steward page');

  const call = (type, payload = {}) => (step(type), m.execAsync(`
    const [msg, done] = arguments;
    if (msg.type === '__open') { (window.browser || browser).tabs.create({ url: msg.url, active: false }).then((t) => done(JSON.stringify({ ok: true, result: t.id })), (e) => done(JSON.stringify({ ok: false, error: String(e) }))); return; }
    const b = (typeof browser !== 'undefined' && browser) || window.browser || (window.wrappedJSObject && window.wrappedJSObject.browser);
    if (!b) return done(JSON.stringify({ ok: false, error: 'no browser global; typeof browser=' + typeof browser + ' keys=' + Object.getOwnPropertyNames(window).filter(k => /browser|chrome/.test(k)).join(',') }));
    b.runtime.sendMessage(msg).then((r) => done(JSON.stringify(r)), (e) => done(JSON.stringify({ ok: false, error: String(e) })));
  `, [{ type, ...payload }], 90000).then((s) => JSON.parse(s)));

  const ov = await call('overview');
  check(ov.ok, 'overview responds', ov.error);
  check(ov.ok && ov.result.counts.tabs >= 8, 'sees the opened tabs', ov.ok ? `${ov.result.counts.tabs} tabs` : '');
  step('read page text');
  let pageText = '';
  try { pageText = await m.exec(`return document.title + ' | ' + (document.body ? document.body.textContent.slice(0, 400) : '');`); } catch (e) { pageText = 'EXEC FAILED: ' + e.message; }
  check(/Tab Steward/.test(pageText) && !/Could not reach|EXEC FAILED/.test(pageText), 'steward page rendered', pageText.replace(/\s+/g, ' ').slice(0, 120));

  // Make the model-free steward decisive for the smoke run: auto everything, tiny thresholds.
  const saved = await call('settings:save', { patch: { autonomy: { group: 'auto', rename: 'auto', collapse: 'auto', hide: 'suggest', sleep: 'auto', close: 'confirm', dedupe: 'auto', ephemeral: 'auto' }, ephemeralMinutes: 0.001, minGroupSize: 2, provider: 'none' } });
  check(saved.ok, 'settings saved');
  const compiled = await call('policy:compile', { text: 'Never close iana.org.\nKeep example.com under Examples.' });
  check(compiled.ok && compiled.result.rules.length === 2, 'policy compiled with fallback parser', compiled.ok ? compiled.result.via : compiled.error);

  const diag = await call('diag');
  check(diag.ok && diag.result.sessionOk, 'storage.session works', diag.ok ? `created=${Object.keys(diag.result.tabCreated).length} tabs=${JSON.stringify(diag.result.tabs)}` : diag.error);
  const plan = await call('preview', { allowModel: false });
  check(plan.ok && plan.result.length >= 3, 'preview lists the planned actions', plan.ok ? plan.result.map((a) => `${a.type}${a.subtype ? '/' + a.subtype : ''}[${a.mode}] ${a.reason} <${a.tabs.map((t) => t.url).join(',')}>`).join(' ; ') : plan.error);
  if (quick) throw new Error('quick mode: stopping after the plan');
  const tidy = await call('tidy', { allowModel: false });
  check(tidy.ok, 'tidy ran', tidy.error);
  const after = await call('overview');
  const titles = after.result.groups.map((g) => g.title);
  check(after.result.counts.tabs < ov.result.counts.tabs, 'duplicate / leftover / blank tabs were closed', `${ov.result.counts.tabs} -> ${after.result.counts.tabs}`);
  const atticNow = await call('attic:list');
  check(after.result.atticCount >= 2, 'closed tabs landed in the Attic', `${after.result.atticCount} entries: ${atticNow.result.map((e) => e.action + ' ' + e.url).join('; ')} | remaining: ${after.result.tabs.map((t) => t.url).join(', ')}`);
  check(titles.includes('Examples'), 'native tab group created from the policy rule', titles.join(', '));

  const groupsNative = await (async () => { await m.chrome(); const n = await m.exec(`const win = Services.wm.getMostRecentWindow("navigator:browser"); return win.gBrowser.tabGroups.map(g => g.label);`); await m.content(); return n; })();
  check(Array.isArray(groupsNative) && groupsNative.includes('Examples'), 'group visible in the real tab strip', JSON.stringify(groupsNative));

  const ex = after.result.groups.find((g) => g.title === 'Examples');
  if (ex) {
    const col = await call('groupAction', { kind: 'collapse', groupId: ex.id });
    check(col.ok, 'collapse group', col.error);
    const hid = await call('groupAction', { kind: 'hide', groupId: ex.id });
    check(hid.ok, 'hide group', hid.error);
    const hidden = await call('overview');
    check(hidden.result.hiddenGroups.length === 1, 'hidden group listed', String(hidden.result.hiddenGroups.length));
    const shown = await call('showHidden', { key: hidden.result.hiddenGroups[0].key });
    check(shown.ok, 'show hidden group', shown.error);
    const focus = await call('focus:start', { groupId: ex.id, minutes: 1 });
    check(focus.ok, 'focus mode started', focus.error);
    const endf = await call('focus:end');
    check(endf.ok, 'focus mode ended', endf.error);
    const ren = await call('groupAction', { kind: 'rename', groupId: ex.id, title: 'Renamed' });
    check(ren.ok, 'rename group', ren.error);
    const mv = await call('groupAction', { kind: 'moveToNewWindow', groupId: ex.id });
    check(mv.ok, 'move group to new window', mv.error);
    const gathered = await call('gather', { title: 'Renamed' });
    check(gathered.ok, 'gather groups', gathered.error);
  }
  const g1 = (await call('overview')).result.groups;
  if (g1.length >= 2) {
    const ro = await call('group:reorder', { groupId: g1[0].id, beforeGroupId: g1[1].id });
    check(ro.ok, 'drag: reorder groups', ro.error);
  }
  const ug = (await call('overview')).result.tabs.find((t) => t.groupId === -1 && !t.pinned && /^https?:/.test(t.url));
  if (ug && g1.length) {
    const mv = await call('tabs:moveToGroup', { tabIds: [ug.id], groupId: g1[0].id });
    check(mv.ok, 'drag: tab into group', mv.error);
    const out = await call('tabs:ungroup', { tabIds: [ug.id] });
    check(out.ok, 'drag: tab out of group', out.error);
  }
  const qm = await call('quick', { kind: 'minimise' });
  check(qm.ok && qm.result.executed >= 1, 'quick: minimise', qm.ok ? `${qm.result.executed} actions` : qm.error);
  const qe = await call('quick', { kind: 'expandAll' });
  check(qe.ok, 'quick: expand all', qe.error);
  const qc = await call('quick', { kind: 'cleanup' });
  check(qc.ok, 'quick: clean up', qc.error);
  const attic = await call('attic:list');
  const first = attic.result[0];
  const restored = await call('attic:restore', { id: first.id });
  check(restored.ok && restored.result && restored.result.id, 'restore from Attic', restored.error);
  const proj = await call('projects:save', { name: 'Smoke' });
  check(proj.ok && proj.result.groups.length >= 1, 'project saved', proj.error);
  const rest = await call('projects:restore', { id: proj.result.id });
  check(rest.ok, 'project restored into a new window', rest.error);
  const eod = await call('projects:endOfDay');
  check(eod.ok, 'end of day', eod.error);
  const undo = await call('undoLast');
  check(undo.ok, 'undo last', undo.error);
  const ask = await call('ask', { query: 'which tab is iana' });
  check(!ask.ok && ask.kind === 'NoProviderError', 'ask without a provider fails cleanly', ask.error);
  const note = await call('note:set', { tabId: after.result.tabs[0].id, note: 'smoke' });
  check(note.ok, 'tab note stored', note.error);
  const suggestions = await call('suggestions');
  check(suggestions.ok, 'suggestions listed', suggestions.ok ? `${suggestions.result.length}` : suggestions.error);
  const log = await call('log:list');
  check(log.ok && log.result.length > 5 && log.result.every((e) => e.reason), 'activity log has reasons', log.ok ? `${log.result.length} entries` : '');

  if (withOllama) {
    step('grant localhost host permission');
    await m.chrome();
    await m.execAsync(`
      const [done] = arguments;
      const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
      ExtensionPermissions.add("tabsteward@pure.science", { permissions: [], origins: ["http://localhost/*", "http://127.0.0.1/*"] }).then(() => done(true), (e) => done(String(e)));
    `);
    await m.content();
    const set = await call('settings:save', { patch: { provider: 'ollama', providers: { ollama: { apiKey: '', model: OLLAMA_MODEL, baseUrl: 'http://localhost:11434/v1' } }, minGroupSize: 2 } });
    check(set.ok, 'ollama provider configured', set.error);
    const models = await call('provider:models');
    check(models.ok && models.result.includes(OLLAMA_MODEL), 'model list fetched from Ollama', models.ok ? models.result.slice(0, 4).join(', ') : models.error);
    const test = await call('provider:test');
    check(test.ok && test.result.ok, 'Ollama answers the JSON probe', test.ok ? `${test.result.model} ${JSON.stringify(test.result.usage)}` : test.error);
    const status = await call('provider:status');
    check(status.ok && status.result.local && status.result.seesEverything, 'local provider recognised as private', JSON.stringify(status.result));
    await call('settings:save', { patch: { autonomy: { group: 'auto', rename: 'auto', collapse: 'auto', hide: 'suggest', sleep: 'auto', close: 'confirm', dedupe: 'auto', ephemeral: 'auto' } } });
    for (const u of ['https://developer.mozilla.org/en-US/docs/Web/API/fetch', 'https://developer.mozilla.org/en-US/docs/Web/JavaScript', 'https://www.rust-lang.org/learn', 'https://doc.rust-lang.org/book/', 'https://www.booking.com/', 'https://www.airbnb.com/']) {
      await call('__open', { url: u });
    }
    await new Promise((r) => setTimeout(r, 2500));
    const t2 = await call('tidy', { allowModel: true });
    check(t2.ok, 'tidy with the local model ran', t2.error);
    const ov2 = await call('overview');
    check(ov2.ok && ov2.result.groups.length >= 2, 'model produced groups', ov2.ok ? ov2.result.groups.map((g) => `${g.title}(${g.count})`).join(', ') : '');
    const spend = await call('spend');
    check(spend.ok && spend.result.calls >= 2 && spend.result.usd === 0, 'local calls metered at zero cost', spend.ok ? `${spend.result.calls} calls, $${spend.result.usd}` : spend.error);
    const sendLog = await call('sendLog');
    check(sendLog.ok && sendLog.result.every((e) => e.local && !/https?:\/\//.test(e.payload)), 'send log marks local calls and payloads carry no full URLs', sendLog.ok ? `${sendLog.result.length} entries` : sendLog.error);
    const ask = await call('ask', { query: 'which tabs are about rust?' });
    check(ask.ok && ask.result.tabs.length >= 1, 'ask your tabs (local model)', ask.ok ? `${ask.result.intent}: ${ask.result.answer.slice(0, 80)} [${ask.result.tabs.length} tabs]` : ask.error);
    const g0 = ov2.result.groups[0];
    if (g0) { const nm = await call('groupAction', { kind: 'autoName', groupId: g0.id }); check(nm.ok, 'model names a group', nm.ok ? nm.result.title : nm.error); }
    const anyTab = ov2.result.tabs.find((t) => /rust|mozilla/.test(t.url));
    if (anyTab) { const dn = await call('note:draft', { tabId: anyTab.id }); check(dn.ok && dn.result.length > 3, 'model drafts a tab note', dn.ok ? dn.result : dn.error); }
    const before = (await call('overview')).result.groups;
    const target = before.find((g) => g.count >= 2) || before[0];
    if (target) {
      const c1 = await call('command', { text: `rename the group "${target.title}" to Renamed By Command` });
      check(c1.ok && c1.result.ran && c1.result.results.every((x) => x.ok), 'command: rename group', c1.ok ? JSON.stringify(c1.result.results) : c1.error);
      const g2 = (await call('overview')).result.groups.map((g) => g.title);
      check(g2.includes('Renamed By Command'), 'command result visible', g2.join(', '));
    }
    const c2 = await call('command', { text: 'make a new group called Rust Study with the rust-lang tabs' });
    check(c2.ok && c2.result.ran && (await call('overview')).result.groups.some((g) => /rust study/i.test(g.title)), 'command: create group with tabs', c2.ok ? c2.result.summary : c2.error);
    const c3 = await call('command', { text: 'close the airbnb tab' });
    check(c3.ok && !c3.result.ran && c3.result.destructive && c3.result.steps.length === 1, 'command: destructive plan waits for OK', c3.ok ? c3.result.steps.map((x) => x.text).join('; ') : c3.error);
    if (c3.ok && c3.result.steps.length) { const run = await call('command:run', { steps: c3.result.steps, text: 'close the airbnb tab' }); check(run.ok && run.result.results.every((x) => x.ok), 'command: run approved plan', run.ok ? '' : run.error); }
    const pol = await call('policy:compile', { text: 'Never close anything on rust-lang.org. Travel tabs die after 2 days. Keep developer.mozilla.org under Docs.' });
    check(pol.ok && pol.result.rules.length >= 2, 'policy compiled by the local model', pol.ok ? `${pol.result.rules.length} rules via ${pol.result.via}` : pol.error);
  }

  if (shot) {
    const { writeFileSync: wf } = await import('node:fs');
    for (const [name, url, w, hgt] of [['popup', base + 'src/panel/panel.html?mode=popup', 470, 640], ['sidebar', base + 'src/panel/panel.html?mode=sidebar', 380, 820]]) {
      await m.send('WebDriver:SetWindowRect', { width: w, height: hgt });
      await m.send('WebDriver:Navigate', { url });
      await new Promise((r) => setTimeout(r, 1800));
      if (name === 'sidebar') { await m.exec(`document.querySelector('#nav [data-view="groups"]').click();`); await new Promise((r) => setTimeout(r, 1200)); await m.exec(`document.querySelectorAll('.twisty').forEach(t => t.click());`); await new Promise((r) => setTimeout(r, 800)); }
      const png = await m.send('WebDriver:TakeScreenshot', { full: true });
      const file = path.join(SHOT_DIR, `panel-${name}.png`);
      wf(file, Buffer.from(png.value, 'base64'));
      console.log('SHOT  ' + file);
    }
  }

  // Options and Attic pages load without script errors.
  for (const page of ['src/options/options.html', 'src/attic/attic.html']) {
    await m.send('WebDriver:Navigate', { url: base + page });
    await new Promise((r) => setTimeout(r, 1500));
    const text = await m.exec(`return document.body.innerText.slice(0, 300);`);
    check(!/Could not load|error/i.test(text) && text.length > 40, `${page} renders`, text.replace(/\s+/g, ' ').slice(0, 80));
  }

  await m.chrome();
  const console_ = await m.exec(`
    return Services.console.getMessageArray().map(m => m.message).filter(t => /moz-extension|tabsteward|Tab Steward/i.test(t) && /error|exception|uncaught|failed/i.test(t)).slice(0, 20);
  `);
  check(console_.length === 0, 'no extension errors in the browser console', console_.join(' | ').slice(0, 600));
} catch (e) {
  failures += 1;
  console.log('FAIL  harness error —', e.stack || e);
} finally {
  clearTimeout(watchdog);
  try { m.close(); } catch { /* ignore */ }
  ff.kill('SIGTERM');
  setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* gone */ } }, 3000);
  const noisy = stdout.split('\n').filter((l) => /moz-extension|tabsteward/i.test(l) && /error|exception/i.test(l));
  if (noisy.length) console.log('stderr from Firefox:\n' + noisy.slice(0, 20).join('\n'));
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll smoke checks passed');
  process.exit(failures ? 1 : 0);
}
