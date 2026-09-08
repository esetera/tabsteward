// Experiment: what does a `createGroup` step do to neighbouring native groups in real Firefox?
// node test/experiment-group.mjs [--visible]
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Marionette } from './marionette.mjs';

const FIREFOX = process.env.FIREFOX_BIN || '/Applications/Firefox.app/Contents/MacOS/firefox';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const visible = process.argv.includes('--visible');
const profile = mkdtempSync(path.join(process.env.SCRATCH || tmpdir(), 'tabsteward-exp-'));
writeFileSync(path.join(profile, 'user.js'), [
  'user_pref("marionette.port", 2829);',
  'user_pref("remote.system-access-check.enabled", false);',
  'user_pref("xpinstall.signatures.required", false);',
  'user_pref("extensions.webextensions.remote", true);',
  'user_pref("browser.tabs.groups.enabled", true);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("browser.startup.homepage", "about:blank");',
  'user_pref("browser.startup.page", 0);',
  'user_pref("browser.tabs.warnOnClose", false);'
].join('\n'));
try { execSync('pkill -9 -f tabsteward-exp- || true'); } catch { /* none */ }
const args = ['-marionette', '-remote-allow-system-access', '-no-remote', '-profile', profile, 'about:blank'];
if (!visible) args.unshift('-headless');
const ff = spawn(FIREFOX, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
ff.stdout.on('data', (d) => { out += d; });
ff.stderr.on('data', (d) => { out += d; });
const m = new Marionette(2829);
const wd = setTimeout(() => { console.log('watchdog'); ff.kill('SIGKILL'); process.exit(2); }, 240000);

try {
  await m.connect();
  await m.newSession();
  await m.send('WebDriver:SetTimeouts', { script: 120000, pageLoad: 60000, implicit: 0 });
  await m.chrome();
  const addonId = await m.execAsync(`
    const [dir, done] = arguments;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    AddonManager.installTemporaryAddon(new FileUtils.File(dir)).then((a) => done(a.id), (e) => done("ERROR: " + e));
  `, [ROOT]);
  console.log('addon', addonId);
  await new Promise((r) => setTimeout(r, 2500));
  const uuid = await m.exec(`return JSON.parse(Services.prefs.getStringPref("extensions.webextensions.uuids"))["tabsteward@pure.science"];`);
  const base = `moz-extension://${uuid}/`;

  await m.execAsync(`
    const [urls, done] = arguments;
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    for (const u of urls) win.gBrowser.addTab(u, { triggeringPrincipal: principal });
    setTimeout(() => done(win.gBrowser.tabs.length), 2000);
  `, [[1, 2, 3, 4, 5, 6, 7].map((i) => `https://example.com/t${i}`)]);

  await m.exec(`
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    const tab = win.gBrowser.addTab(${JSON.stringify(base + 'src/panel/panel.html?mode=page')}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });
    win.gBrowser.selectedTab = tab;
  `);
  await new Promise((r) => setTimeout(r, 2500));
  await m.content();
  for (const hnd of await m.send('WebDriver:GetWindowHandles')) {
    await m.send('WebDriver:SwitchToWindow', { handle: hnd });
    const url = await m.send('WebDriver:GetCurrentURL');
    if (String(url.value).startsWith(base + 'src/panel')) break;
  }

  // Run arbitrary code with the extension's `browser` inside the panel page.
  const ext = (code) => m.execAsync(`
    const [code, done] = arguments;
    const b = (typeof browser !== 'undefined' && browser) || window.browser;
    (async () => { try { done(JSON.stringify({ ok: true, v: await (new Function('browser', 'return (async () => {' + code + '})()'))(b) })); } catch (e) { done(JSON.stringify({ ok: false, e: String(e && e.stack || e) })); } })();
  `, [code], 60000).then((s) => { const r = JSON.parse(s); if (!r.ok) throw new Error(r.e); return r.v; });
  const send = (type, payload = {}) => ext(`return browser.runtime.sendMessage(${JSON.stringify({ type, ...payload })});`);

  // Native view of the strip: index, url, group label, collapsed, and the strip's own per-group tab lists.
  const strip = async (label) => {
    await m.chrome();
    const v = await m.exec(`
      const out = [];
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        const tabs = Array.from(win.gBrowser.tabs).map((t, i) => ({ i, url: (t.linkedBrowser.currentURI.spec || '').replace('https://example.com/', ''), g: t.group ? t.group.label : null, gid: t.group ? t.group.id : null, hidden: t.hidden, vis: !!t.visible }));
        const groups = win.gBrowser.tabGroups.map((g) => ({ label: g.label, id: g.id, collapsed: g.collapsed, tabs: g.tabs.map((t) => (t.linkedBrowser.currentURI.spec || '').replace('https://example.com/', '')) }));
        out.push({ tabs, groups });
      }
      return JSON.stringify(out);
    `);
    await m.content();
    for (const hnd of await m.send('WebDriver:GetWindowHandles')) {
      await m.send('WebDriver:SwitchToWindow', { handle: hnd });
      const url = await m.send('WebDriver:GetCurrentURL');
      if (String(url.value).startsWith(base + 'src/panel')) break;
    }
    const w = JSON.parse(v);
    console.log(`\n== ${label}`);
    w.forEach((win, n) => {
      console.log(` window ${n}: ` + win.tabs.map((t) => `${t.i}:${t.url || 'blank'}${t.g ? '[' + t.g + ']' : ''}${t.hidden ? '(hidden)' : ''}${t.vis ? '' : '(invis)'}`).join('  '));
      console.log(`   groups: ` + win.groups.map((g) => `${g.label}${g.collapsed ? '(collapsed)' : ''}=[${g.tabs.join(',')}]`).join('  '));
    });
    return w;
  };

  const ids = await ext(`const ts = await browser.tabs.query({}); return Object.fromEntries(ts.filter(t => /example\\.com\\/t/.test(t.url)).map(t => [t.url.replace('https://example.com/', ''), t.id]));`);
  console.log('tab ids', ids);
  const win = await ext(`return (await browser.windows.getLastFocused()).id;`);

  // Build two groups the way Firefox itself would: Alpha = t1,t2,t3  Beta = t4,t5. t6, t7 loose.
  await ext(`const g = await browser.tabs.group({ tabIds: [${ids.t1},${ids.t2},${ids.t3}], createProperties: { windowId: ${win} } }); await browser.tabGroups.update(g, { title: 'Alpha', color: 'blue' });`);
  await ext(`const g = await browser.tabs.group({ tabIds: [${ids.t4},${ids.t5}], createProperties: { windowId: ${win} } }); await browser.tabGroups.update(g, { title: 'Beta', color: 'red' });`);
  await strip('baseline: Alpha[t1,t2,t3] Beta[t4,t5] loose t6,t7');

  // A. "Create a new group with t2" (a tab from the middle of Alpha), through the steward's own command path.
  let r = await send('command:run', { steps: [{ op: 'createGroup', title: 'Fresh', tabIds: [ids.t2], groupId: null, groupIds: [], text: '' }], text: 'create a new group called Fresh with t2' });
  console.log('command:run ->', JSON.stringify(r));
  await strip('A. after createGroup Fresh <- t2');
  const fresh = await ext(`return (await browser.tabGroups.query({ title: 'Fresh' }))[0];`);
  console.log('Fresh via API', JSON.stringify(fresh), 'members', JSON.stringify(await ext(`return (await browser.tabs.query({ groupId: ${fresh.id} })).map(t => [t.index, t.url.replace('https://example.com/', '')]);`)));
  await ext(`await browser.tabGroups.update(${fresh.id}, { collapsed: true });`);
  await strip('A2. Fresh collapsed');
  await ext(`await browser.tabGroups.update(${fresh.id}, { collapsed: false });`);

  // B. Create a group spanning both existing groups plus a loose tab.
  r = await send('command:run', { steps: [{ op: 'createGroup', title: 'Mixed', tabIds: [ids.t1, ids.t4, ids.t6], groupId: null, groupIds: [], text: '' }], text: 'x' });
  console.log('command:run ->', JSON.stringify(r));
  await strip('B. after createGroup Mixed <- t1(Alpha), t4(Beta), t6');

  // C. Undo that batch.
  r = await send('log:undo', { batchId: r.result.batchId });
  console.log('undo ->', JSON.stringify(r));
  await strip('C. after undo of B');

  // D. Cross-window: put t7 in a group in a second window, then createGroup in window 1 pulling it back.
  const w2 = await ext(`const w = await browser.windows.create({ tabId: ${ids.t7} }); return w.id;`);
  await new Promise((r) => setTimeout(r, 1000));
  await ext(`const g = await browser.tabs.group({ tabIds: [${ids.t7}], createProperties: { windowId: ${w2} } }); await browser.tabGroups.update(g, { title: 'Far', color: 'green' });`);
  await strip('D0. t7 grouped as Far in window 2');
  r = await send('command:run', { steps: [{ op: 'createGroup', title: 'Pulled', tabIds: [ids.t7, ids.t3], groupId: null, groupIds: [], text: '' }], text: 'x' });
  console.log('command:run ->', JSON.stringify(r));
  await strip('D. after createGroup Pulled <- t7(window2/Far), t3');
  r = await send('log:undo', { batchId: r.result.batchId });
  console.log('undo ->', JSON.stringify(r));
  await strip('D1. after undo of D (Far should be back in its own window, t3 back in Alpha)');

  // E. Plain tabs.move of a loose tab to an index inside a group's range.
  await ext(`await browser.tabs.move(${ids.t6}, { index: 1 });`);
  await strip('E. after tabs.move(t6, index 1)');
  console.log('\nE tab via API', JSON.stringify(await ext(`const t = await browser.tabs.get(${ids.t6}); return { index: t.index, groupId: t.groupId };`)));
} catch (e) {
  console.log('ERROR', e && e.stack || e);
} finally {
  clearTimeout(wd);
  try { await m.send('Marionette:Quit', { flags: ['eForceQuit'] }); } catch { /* */ }
  ff.kill('SIGKILL');
  const errs = out.split('\n').filter((l) => /tabsteward|moz-extension/.test(l) && /error|exception/i.test(l));
  if (errs.length) console.log('\nconsole errors:\n' + errs.join('\n'));
}
