import { send, h, clear, ago, usd, toast } from '../shared.js';

const $ = (id) => document.getElementById(id);
let settings = null;
let PROVIDERS = null;
let CATEGORY_LIST = ['Search', 'News', 'Shopping', 'Media', 'Social', 'Reading', 'Dev', 'Docs', 'Work', 'Finance', 'Travel', 'Research', 'AI', 'Cloud', 'Misc'];

document.querySelectorAll('.tabs-nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs-nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => { s.hidden = s.id !== 'tab-' + b.dataset.tab; });
  location.hash = b.dataset.tab;
}));
if (location.hash) { const b = document.querySelector(`.tabs-nav button[data-tab="${location.hash.slice(1)}"]`); if (b) b.click(); }

async function load() {
  settings = await send('settings:get');
  PROVIDERS = await send('provider:list');
  renderProvider();
  renderPolicy();
  renderAutonomy();
  renderTiming();
  renderPrivacy();
}

// ---------- model ----------
function renderProvider() {
  const sel = clear($('provider'));
  sel.appendChild(h('option', { value: 'none' }, 'No model (heuristics only)'));
  for (const [id, p] of Object.entries(PROVIDERS)) sel.appendChild(h('option', { value: id }, p.label));
  sel.value = settings.provider || 'none';
  sel.onchange = () => { settings.provider = sel.value; renderProviderFields(); };
  renderProviderFields();
}

function renderProviderFields() {
  const id = settings.provider;
  const box = clear($('provider-fields'));
  const help = $('provider-help');
  if (!id || id === 'none') { help.textContent = 'Duplicates, known sites, staleness and the policy parser still work. Smart grouping, naming and “ask your tabs” need a model.'; $('grant').hidden = $('fetch-models').hidden = $('test').hidden = true; return; }
  $('grant').hidden = $('fetch-models').hidden = $('test').hidden = false;
  const def = PROVIDERS[id];
  const cfg = settings.providers[id] || (settings.providers[id] = { apiKey: '', model: '' });
  help.textContent = def.help || (def.local ? 'Runs on this machine.' : 'Tab titles and URL paths are sent to this provider. Never-send sites are excluded.');
  if (def.local || id === 'custom') {
    box.appendChild(h('label', {}, 'Server URL (OpenAI-compatible base, ends in /v1)'));
    const url = h('input', { type: 'url', value: cfg.baseUrl || def.base, placeholder: def.base });
    url.oninput = () => { cfg.baseUrl = url.value.trim(); };
    box.appendChild(url);
  }
  box.appendChild(h('label', {}, def.local ? 'API key (usually blank for local servers)' : 'API key'));
  const key = h('input', { type: 'password', value: cfg.apiKey || '', placeholder: def.local ? 'optional' : 'sk-…', autocomplete: 'off' });
  key.oninput = () => { cfg.apiKey = key.value.trim(); };
  box.appendChild(key);
  if (def.keyUrl) box.appendChild(h('div', { class: 'hint' }, def.local ? 'Get it: ' : 'Get a key: ', h('a', { href: def.keyUrl, target: '_blank' }, def.keyUrl)));
  box.appendChild(h('label', {}, 'Model'));
  const models = [...new Set([...(def.models || []), ...(cfg.discovered || []), cfg.model].filter(Boolean))];
  const row = h('div', { class: 'row' });
  const modelSel = h('select', { style: { maxWidth: '320px' } });
  for (const m of models) modelSel.appendChild(h('option', { value: m }, m));
  modelSel.appendChild(h('option', { value: '__other' }, 'Other…'));
  const modelInput = h('input', { type: 'text', value: cfg.model || def.defaultModel || '', placeholder: 'model id', style: { maxWidth: '320px' } });
  modelSel.value = models.includes(cfg.model || def.defaultModel) ? (cfg.model || def.defaultModel) : '__other';
  modelInput.hidden = modelSel.value !== '__other';
  modelSel.onchange = () => { if (modelSel.value === '__other') { modelInput.hidden = false; modelInput.focus(); } else { modelInput.hidden = true; cfg.model = modelSel.value; } };
  modelInput.oninput = () => { cfg.model = modelInput.value.trim(); };
  if (!cfg.model) cfg.model = def.defaultModel;
  row.appendChild(modelSel); row.appendChild(modelInput);
  box.appendChild(row);
  if (id === 'anthropic') box.appendChild(h('div', { class: 'hint' }, 'Tab classification is a small job. claude-haiku-4-5 is the cheapest choice; claude-opus-5 is the default because it is the most capable.'));
}

async function saveProvider() {
  settings = await send('settings:save', { patch: { provider: settings.provider, providers: settings.providers } });
}

$('grant').addEventListener('click', async () => {
  await saveProvider();
  const id = settings.provider;
  const def = PROVIDERS[id];
  const base = settings.providers[id]?.baseUrl || def.base;
  let origin = def.origin;
  try { const u = new URL(base); origin = `${u.protocol}//${u.host}/*`; } catch { /* keep default */ }
  if (!origin) return;
  try {
    const ok = await browser.permissions.request({ origins: [origin] });
    setStatus('test-status', ok ? `Access granted for ${origin}` : `Access to ${origin} was not granted`, ok);
  } catch (e) { setStatus('test-status', e.message, false); }
});

$('fetch-models').addEventListener('click', async () => {
  await saveProvider();
  setStatus('test-status', 'Fetching models…');
  try {
    const list = await send('provider:models', { settings });
    const cfg = settings.providers[settings.provider];
    cfg.discovered = list;
    if (!list.includes(cfg.model) && list.length) cfg.model = list[0];
    await saveProvider();
    renderProviderFields();
    setStatus('test-status', list.length ? `${list.length} models found` : 'The server returned no models', list.length > 0);
  } catch (e) { setStatus('test-status', 'Could not list models: ' + e.message, false); }
});

$('test').addEventListener('click', async () => {
  await saveProvider();
  setStatus('test-status', 'Testing…');
  try {
    const r = await send('provider:test', { settings });
    setStatus('test-status', r.ok ? `Works. ${r.model} answered in JSON (${r.usage.input}+${r.usage.output} tokens).` : `Reply was not the expected JSON: ${r.text}`, r.ok);
    if (r.ok) await send('settings:save', { patch: { onboarded: true } });
  } catch (e) { setStatus('test-status', e.message, false); }
});

function setStatus(id, msg, ok) {
  const el = $(id);
  el.textContent = msg;
  el.className = 'status ' + (ok === true ? 'ok' : ok === false ? 'err' : '');
}

// ---------- policy ----------
function renderPolicy() {
  $('policy').value = settings.policyText || '';
  renderRules(settings.rules || []);
}

async function renderRules(rules) {
  const el = clear($('rules'));
  if (!rules.length) { el.appendChild(h('div', { class: 'empty' }, 'No rules yet.')); return; }
  const descriptions = await send('policy:describe', { rules });
  const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'From'), h('th', {}, ''))));
  const body = h('tbody');
  rules.forEach((r, i) => body.appendChild(h('tr', {}, h('td', {}, descriptions[i] || JSON.stringify(r)), h('td', { class: 'muted' }, r.source || ''),
    h('td', { class: 'nowrap' }, h('button', { class: 'small danger', onClick: async () => { const next = rules.filter((x) => x.id !== r.id); settings = await send('settings:save', { patch: { rules: next } }); renderRules(next); } }, 'Remove')))));
  table.appendChild(body);
  el.appendChild(table);
}

$('compile').addEventListener('click', async () => {
  setStatus('compile-status', 'Compiling…');
  try {
    const r = await send('policy:compile', { text: $('policy').value });
    settings.rules = r.rules;
    settings.policyText = $('policy').value;
    renderRules(r.rules);
    setStatus('compile-status', `${r.rules.length} rule${r.rules.length === 1 ? '' : 's'} via ${r.via}`, true);
  } catch (e) { setStatus('compile-status', e.message, false); }
});

// ---------- autonomy ----------
const GATES = [
  ['group', 'Group tabs'], ['rename', 'Rename groups'], ['collapse', 'Collapse idle groups'], ['hide', 'Hide idle groups'],
  ['sleep', 'Sleep idle tabs'], ['dedupe', 'Close duplicates'], ['ephemeral', 'Close leftover pages'], ['close', 'Close stale tabs']
];
function renderAutonomy() {
  const el = clear($('dials'));
  for (const [gate, label] of GATES) {
    const opts = h('div', { class: 'opts' });
    for (const mode of ['suggest', 'confirm', 'auto']) {
      const b = h('button', { class: 'small' + (settings.autonomy[gate] === mode ? ' on' : ''), onClick: async () => { settings.autonomy[gate] = mode; settings = await send('settings:save', { patch: { autonomy: settings.autonomy } }); renderAutonomy(); } }, mode);
      opts.appendChild(b);
    }
    el.appendChild(h('div', { class: 'dial' }, h('span', {}, label), opts));
  }
  for (const id of ['autoTidy', 'autoGroupNewTabs', 'notifications']) {
    $(id).checked = !!settings[id];
    $(id).onchange = async () => { settings = await send('settings:save', { patch: { [id]: $(id).checked } }); toast('Saved'); };
  }
  $('attic-days-inline').textContent = settings.atticDays;
}

// ---------- timing ----------
const TIMING = ['tidyIntervalMinutes', 'ephemeralMinutes', 'collapseIdleHours', 'hideIdleHours', 'sleepFraction', 'readLaterDays', 'atticDays', 'minGroupSize'];
function renderTiming() {
  for (const id of TIMING) $(id).value = settings[id];
  const el = clear($('stale'));
  for (const c of CATEGORY_LIST) {
    const input = h('input', { type: 'number', min: '1', id: 'stale-' + c, value: settings.staleHours[c] ?? '' });
    el.appendChild(h('div', {}, h('label', {}, c), input));
  }
}
$('save-timing').addEventListener('click', async () => {
  const patch = {};
  for (const id of TIMING) { const v = parseFloat($(id).value); if (!Number.isNaN(v)) patch[id] = v; }
  const staleHours = {};
  for (const c of CATEGORY_LIST) { const v = parseFloat($('stale-' + c).value); if (!Number.isNaN(v) && v > 0) staleHours[c] = v; }
  patch.staleHours = staleHours;
  settings = await send('settings:save', { patch });
  setStatus('timing-status', 'Saved', true);
  $('attic-days-inline').textContent = settings.atticDays;
});

// ---------- privacy ----------
async function renderPrivacy() {
  $('localSeesEverything').checked = settings.localSeesEverything !== false;
  $('sendContent').checked = !!settings.sendContent;
  $('neverSend').value = (settings.neverSend || []).join('\n');
  $('monthlyCapUsd').value = settings.monthlyCapUsd;
  const granted = await send('permissions:contains', { origins: ['<all_urls>'] });
  setStatus('content-status', granted ? 'All-sites access granted. Unsaved-form protection and excerpts are active.' : 'Not granted. Without it the steward cannot tell whether you typed into a page.', granted ? true : undefined);
  renderSpend();
  renderSendLog();
}
$('grant-content').addEventListener('click', async () => {
  const ok = await browser.permissions.request({ origins: ['<all_urls>'] });
  setStatus('content-status', ok ? 'Granted' : 'Not granted', ok);
});
$('save-privacy').addEventListener('click', async () => {
  const neverSend = $('neverSend').value.split(/\n+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  settings = await send('settings:save', { patch: { neverSend, sendContent: $('sendContent').checked, localSeesEverything: $('localSeesEverything').checked } });
  setStatus('privacy-status', 'Saved', true);
});
$('save-cap').addEventListener('click', async () => {
  settings = await send('settings:save', { patch: { monthlyCapUsd: parseFloat($('monthlyCapUsd').value) || 0 } });
  toast('Cap saved'); renderSpend();
});
$('reset-spend').addEventListener('click', async () => { await send('spend:reset'); renderSpend(); });
$('clear-cache').addEventListener('click', async () => { await send('cache:clear'); toast('Cache cleared'); });
$('clear-log').addEventListener('click', async () => { await send('sendLog:clear'); renderSendLog(); });
$('reset').addEventListener('click', async () => {
  if (!confirm('Reset all Tab Steward data? Keys, rules, Attic, projects and logs will be erased.')) return;
  await send('reset'); location.reload();
});

async function renderSpend() {
  const s = await send('spend');
  const el = clear($('spend'));
  const cap = settings.monthlyCapUsd;
  el.appendChild(h('div', {}, h('b', {}, usd(s.usd)), ` estimated this month (${s.month}) · ${s.calls} calls · ${s.input.toLocaleString()} in / ${s.output.toLocaleString()} out tokens`));
  if (cap) { el.appendChild(h('div', { class: 'meter' }, h('div', { style: { width: Math.min(100, (s.usd / cap) * 100) + '%' } }))); }
  const byModel = Object.entries(s.byModel || {});
  if (byModel.length) el.appendChild(h('div', { class: 'muted' }, byModel.map(([m, v]) => `${m}: ${usd(v)}`).join(' · ')));
  const byTask = Object.entries(s.byTask || {});
  if (byTask.length) el.appendChild(h('div', { class: 'muted' }, 'Calls by task: ' + byTask.map(([t, n]) => `${t} ${n}`).join(' · ')));
}

async function renderSendLog() {
  const log = await send('sendLog');
  const el = clear($('sendlog'));
  if (!log.length) { el.appendChild(h('div', { class: 'empty' }, 'Nothing has been sent yet.')); return; }
  for (const e of log) {
    const d = h('details', {}, h('summary', {}, `${ago(e.ts)} · ${e.task} · ${e.provider}/${e.model}${e.local ? ' (local)' : ''} · ${e.ok ? `${e.usage?.input || 0}+${e.usage?.output || 0} tokens · ${usd(e.usd)}` : 'failed: ' + e.error} · ${e.ms} ms`),
      h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px' } }, e.payload));
    el.appendChild(d);
  }
}

load().catch((e) => { document.body.appendChild(h('div', { class: 'status err' }, 'Could not load settings: ' + e.message)); });
