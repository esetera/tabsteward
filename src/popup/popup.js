import { send, h, clear, ago, hours, favicon, colorDot, usd, toast } from '../shared.js';

const params = new URLSearchParams(location.search);
const isPage = params.has('page') || params.has('sidebar');
if (isPage) { document.body.classList.remove('popup'); document.body.classList.add('wide'); }

const $ = (id) => document.getElementById(id);
let state = null;
let filter = '';

async function refresh() {
  try {
    state = await send('overview');
  } catch (e) {
    $('digest').textContent = 'Could not reach the steward: ' + e.message;
    return;
  }
  render();
}

function render() {
  renderProvider();
  renderOnboard();
  renderFocus();
  renderDigest();
  renderSuggestions();
  renderGroups();
  renderHidden();
  renderTabs();
  renderProjects();
  renderFooter();
}

function renderProvider() {
  const p = state.provider;
  const el = $('provider');
  el.textContent = p.ok ? p.model : 'no model';
  el.className = 'chip ' + (p.ok ? 'ok' : 'warn');
  el.title = p.ok ? `${p.label} · ${p.model}` : 'No model configured. Heuristics only. Open settings to add a key.';
}

function renderOnboard() {
  const el = $('onboard');
  el.hidden = state.onboarded || state.provider.ok;
  if (el.hidden) return;
  clear(el).appendChild(h('div', { class: 'banner' },
    h('b', { text: 'Welcome. ' }),
    'Tab Steward works without a model (known sites, duplicates, staleness). Add an API key for OpenAI, Anthropic, DeepSeek, Z.ai or a local model to get smart grouping and “ask your tabs”. ',
    h('button', { class: 'small', onClick: () => browser.runtime.openOptionsPage() }, 'Open settings'),
    ' ',
    h('button', { class: 'small', onClick: async () => { await send('settings:save', { patch: { onboarded: true } }); refresh(); } }, 'Dismiss')
  ));
}

function renderFocus() {
  const el = $('focus');
  const f = state.focus;
  el.hidden = !f;
  if (!f) return;
  const mins = Math.max(0, Math.round((f.endsAt - Date.now()) / 60000));
  clear(el).appendChild(h('div', { class: 'banner row' },
    h('span', { class: 'grow' }, h('b', { text: `Focus: ${f.title || 'group'}` }), ` · ${mins} min left · ${f.hiddenTabIds.length} tabs hidden`),
    h('button', { class: 'small', onClick: async () => { await send('focus:end'); toast('Focus ended, tabs are back'); refresh(); } }, 'End focus')
  ));
}

function renderDigest() {
  const c = state.counts;
  const el = clear($('digest'));
  const stats = h('div', { class: 'stats' },
    stat(c.tabs, 'tabs'), stat(c.groups, 'groups'), stat(c.sleeping, 'sleeping'),
    stat(state.closedSinceLastOpen.length, 'closed since last look', () => openAttic()),
    stat(c.staleSoon, 'closing within 24 h')
  );
  el.appendChild(stats);
  if (state.lastTidy) el.appendChild(h('div', { class: 'muted', style: { fontSize: '11px' } }, `Last tidy ${ago(state.lastTidy.ts)} (${state.lastTidy.trigger}): ${state.lastTidy.executed} done, ${state.lastTidy.suggested} suggested`));
  for (const n of state.streakNudges) {
    el.appendChild(h('div', { class: 'banner row' },
      h('span', { class: 'grow' }, `You have approved ${n.n} “${n.gate}” suggestions in a row. Let the steward do those on its own?`),
      h('button', { class: 'small primary', onClick: async () => { await send('settings:save', { patch: { autonomy: { ...state.autonomy, [n.gate]: 'auto' }, approvalStreaks: {} } }); toast(`${n.gate} is now automatic`); refresh(); } }, 'Yes, automate'),
      h('button', { class: 'small', onClick: async () => { await send('settings:save', { patch: { approvalStreaks: {} } }); refresh(); } }, 'Not now')
    ));
  }
  if (state.closedSinceLastOpen.length) {
    const d = h('details', {}, h('summary', {}, `What was closed since you last looked (${state.closedSinceLastOpen.length})`));
    for (const e of state.closedSinceLastOpen) {
      d.appendChild(h('div', { class: 'tab', onClick: () => send('attic:restore', { id: e.id, activate: true }).then(refresh) },
        favicon(e.favIconUrl), h('span', { class: 'title', title: e.reason }, e.title), h('span', { class: 'chip' }, e.reason.slice(0, 28))));
    }
    el.appendChild(d);
  }
}

function stat(n, label, onClick) {
  const el = h('div', { class: 'stat', onClick }, h('b', { text: String(n) }), label);
  if (onClick) el.style.cursor = 'pointer';
  return el;
}

function renderSuggestions() {
  const el = clear($('suggestions'));
  const list = state.suggestions;
  el.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, `Suggestions (${list.length})`),
    list.length ? h('button', { class: 'small', onClick: async () => { for (const s of list) await send('approve', { id: s.id }); toast('All approved'); refresh(); } }, 'Approve all') : null,
    list.length ? h('button', { class: 'small', onClick: async () => { await send('dismissAll'); refresh(); } }, 'Dismiss all') : null));
  if (!list.length) { el.appendChild(h('div', { class: 'empty' }, 'Nothing waiting. The steward will suggest here when it is unsure.')); return; }
  for (const s of list) {
    const a = s.action;
    const card = h('div', { class: 'card suggestion' });
    card.appendChild(h('div', { class: 'row' },
      h('span', { class: 'badge ' + a.type }, labelFor(a)),
      h('span', { class: 'grow', style: { fontWeight: 600 } }, a.title ? `“${a.title}”` : ''),
      s.mode === 'confirm' ? h('span', { class: 'chip warn' }, 'needs OK') : null
    ));
    card.appendChild(h('div', { class: 'reason' }, a.reason));
    const tabs = s.tabs.slice(0, 4);
    for (const t of tabs) card.appendChild(h('div', { class: 'tab', onClick: () => jump(t.id) }, favicon(t.favIconUrl), h('span', { class: 'title' }, t.title)));
    if (s.tabs.length > 4) card.appendChild(h('div', { class: 'muted' }, `+${s.tabs.length - 4} more`));
    card.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'small primary', onClick: async () => { await send('approve', { id: s.id }); refresh(); } }, 'Approve'),
      h('button', { class: 'small', onClick: async () => { await send('dismiss', { id: s.id }); refresh(); } }, 'Dismiss')
    ));
    el.appendChild(card);
  }
}

function labelFor(a) {
  return { close: a.subtype === 'duplicate' ? 'close duplicate' : a.subtype === 'ephemeral' ? 'close leftover' : 'close stale', closeSilently: 'close empty', sleep: 'sleep', group: 'group', collapse: 'collapse', hide: 'hide', readLater: 'read later', rename: 'rename' }[a.type] || a.type;
}

function renderGroups() {
  const el = clear($('groups'));
  const groups = state.groups.filter((g) => !g.allHidden);
  el.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, `Groups (${groups.length})`),
    h('button', { class: 'small', title: 'Snapshot every group as a project, then close them', onClick: endOfDay }, 'End of day')));
  if (!groups.length) { el.appendChild(h('div', { class: 'empty' }, 'No groups yet. Tidy now, or add a model key for smarter grouping.')); return; }
  const byWindow = new Map();
  for (const g of groups) { if (!byWindow.has(g.windowId)) byWindow.set(g.windowId, []); byWindow.get(g.windowId).push(g); }
  const multi = byWindow.size > 1;
  for (const [wid, list] of byWindow) {
    if (multi) el.appendChild(h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, `Window ${wid}`));
    for (const g of list) el.appendChild(groupRow(g));
  }
}

function groupRow(g) {
  const title = h('span', { class: 'title', title: 'Click to rename' }, g.title || 'Untitled');
  title.addEventListener('click', () => {
    const input = h('input', { type: 'text', value: g.title });
    title.replaceWith(input);
    input.focus();
    const commit = async () => { const v = input.value.trim(); if (v && v !== g.title) await send('groupAction', { kind: 'rename', groupId: g.id, title: v }); refresh(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') refresh(); });
    input.addEventListener('blur', commit);
  });
  const menu = h('div', { class: 'menu' },
    h('button', { class: 'icon', onClick: (e) => { e.stopPropagation(); closeMenus(); e.currentTarget.parentElement.classList.toggle('open'); } }, '⋯'),
    h('div', { class: 'menu-list' },
      h('button', { onClick: () => act('autoName', g, 'Named by the model') }, 'Name with the model'),
      h('button', { onClick: () => act('sleep', g, 'Group put to sleep') }, 'Sleep all tabs'),
      h('button', { onClick: () => act('moveToNewWindow', g, 'Moved to its own window') }, 'Move to new window'),
      h('button', { onClick: async () => { const n = await send('gather', { title: g.title }); toast(n ? `Gathered ${n} tabs` : 'Nothing to gather'); refresh(); } }, 'Gather same-named groups here'),
      h('button', { onClick: () => act('ungroup', g, 'Ungrouped') }, 'Ungroup'),
      h('button', { class: 'danger', onClick: () => act('close', g, 'Group closed (in the Attic)') }, 'Close group')
    ));
  return h('div', { class: 'group-row' },
    colorDot(g.color), title,
    h('span', { class: 'chip', title: 'tabs' }, String(g.count)),
    g.idleHours >= 1 ? h('span', { class: 'chip', title: 'idle' }, hours(g.idleHours)) : null,
    h('button', { class: 'icon', title: g.collapsed ? 'Expand' : 'Collapse', onClick: () => act(g.collapsed ? 'expand' : 'collapse', g) }, g.collapsed ? '▸' : '▾'),
    h('button', { class: 'icon', title: 'Focus on this group for 50 min (hides everything else)', onClick: async () => { await send('focus:start', { groupId: g.id, minutes: 50 }); toast('Focus started'); refresh(); } }, '◎'),
    h('button', { class: 'icon', title: 'Hide this group (bring it back from the Hidden list)', onClick: () => act('hide', g, 'Hidden. Find it under Hidden groups.') }, '⌄'),
    menu
  );
}

async function act(kind, g, msg) {
  try { await send('groupAction', { kind, groupId: g.id }); if (msg) toast(msg); } catch (e) { toast(e.message, 'err'); }
  refresh();
}

function renderHidden() {
  const el = clear($('hidden'));
  const list = state.hiddenGroups;
  if (!list.length) return;
  el.appendChild(h('h2', {}, `Hidden groups (${list.length})`));
  for (const r of list) {
    el.appendChild(h('div', { class: 'group-row' }, colorDot(r.color), h('span', { class: 'title' }, r.title || 'Untitled'), h('span', { class: 'chip' }, `${r.tabIds.length} tabs`), h('span', { class: 'chip' }, ago(r.hiddenAt)),
      h('button', { class: 'small', onClick: async () => { await send('showHidden', { key: r.key }); refresh(); } }, 'Show')));
  }
}

function renderTabs() {
  const el = clear($('tabs'));
  const q = filter.trim().toLowerCase();
  let tabs = state.tabs.filter((t) => !t.hidden);
  if (q) tabs = tabs.filter((t) => (t.title + ' ' + t.url + ' ' + t.note).toLowerCase().includes(q));
  else tabs = tabs.filter((t) => t.groupId === -1);
  el.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, q ? `Matching tabs (${tabs.length})` : `Ungrouped tabs (${tabs.length})`),
    q && tabs.length > 1 ? h('button', { class: 'small', onClick: async () => { const title = prompt('Group title', filter.trim()); if (!title) return; const byWin = new Map(); for (const t of tabs) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t.id); } for (const [w, ids] of byWin) await send('createGroup', { tabIds: ids, title, windowId: w }); toast('Grouped'); refresh(); } }, 'Group these') : null,
    q && tabs.length ? h('button', { class: 'small danger', onClick: async () => { await send('tabs:close', { tabIds: tabs.map((t) => t.id), reason: 'you closed the search results' }); refresh(); } }, 'Close these') : null));
  if (!tabs.length) { el.appendChild(h('div', { class: 'empty' }, q ? 'No tab matches. Press Ask to let the model look.' : 'Every tab is in a group.')); return; }
  for (const t of tabs.slice(0, 80)) el.appendChild(tabRow(t));
  if (tabs.length > 80) el.appendChild(h('div', { class: 'muted' }, `+${tabs.length - 80} more, refine the search`));
}

function tabRow(t) {
  const row = h('div', { class: 'tab' + (t.discarded ? ' discarded' : ''), onClick: () => jump(t.id) },
    favicon(t.favIconUrl),
    h('span', { class: 'title', title: t.url + (t.note ? '\nNote: ' + t.note : '') }, t.title),
    t.note ? h('span', { class: 'chip', title: t.note }, '✎') : null,
    t.audible ? h('span', { class: 'chip' }, '♪') : null,
    t.pinned ? h('span', { class: 'chip' }, 'pinned') : null,
    t.protectedBy.length ? h('span', { class: 'chip ok', title: 'protected by a policy rule' }, 'rule') : null,
    t.closesInHours !== null && t.closesInHours <= 24 ? h('span', { class: 'chip warn', title: 'closes when idle this long' }, `${t.closesInHours} h`) : (t.idleHours >= 1 ? h('span', { class: 'chip' }, hours(t.idleHours)) : null),
    h('span', { class: 'actions' },
      h('button', { class: 'icon', title: 'Note: why is this open?', onClick: (e) => { e.stopPropagation(); editNote(t); } }, '✎'),
      h('button', { class: 'icon', title: 'Sleep', onClick: (e) => { e.stopPropagation(); send('tabs:sleep', { tabIds: [t.id] }).then(refresh); } }, '☾'),
      h('button', { class: 'icon', title: 'Close (to the Attic)', onClick: (e) => { e.stopPropagation(); send('tabs:close', { tabIds: [t.id] }).then(refresh); } }, '✕')
    ));
  return row;
}

async function editNote(t) {
  const current = t.note || '';
  const v = prompt('Why is this tab open? (leave empty and press OK to ask the model)', current);
  if (v === null) return;
  try {
    if (v.trim() === '' && !current) { const note = await send('note:draft', { tabId: t.id }); toast('Note: ' + note); }
    else await send('note:set', { tabId: t.id, note: v });
  } catch (e) { toast(e.message, 'err'); }
  refresh();
}

async function jump(tabId) {
  try { await send('tabs:activate', { tabId }); if (!isPage) window.close(); } catch (e) { toast(e.message, 'err'); }
}

let projects = [];
async function renderProjects() {
  const el = clear($('projects'));
  el.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Projects'),
    h('button', { class: 'small', onClick: async () => { const name = prompt('Project name', ''); if (name === null) return; await send('projects:save', { name }); toast('Saved'); renderProjects(); } }, 'Save groups as project')));
  try { projects = await send('projects:list'); } catch { projects = []; }
  if (!projects.length) { el.appendChild(h('div', { class: 'empty' }, 'Save a project to bring back a set of groups later, in a fresh window.')); return; }
  for (const p of projects.slice(0, 8)) {
    el.appendChild(h('div', { class: 'group-row' }, h('span', { class: 'title' }, p.name), h('span', { class: 'chip' }, `${p.groups.length} groups · ${p.groups.reduce((n, g) => n + g.tabs.length, 0)} tabs`), h('span', { class: 'chip' }, ago(p.createdAt)),
      h('button', { class: 'small', onClick: async () => { await send('projects:restore', { id: p.id }); toast('Restored in a new window'); } }, 'Restore'),
      h('button', { class: 'icon danger', title: 'Delete', onClick: async () => { await send('projects:delete', { id: p.id }); renderProjects(); } }, '✕')));
  }
}

async function endOfDay() {
  if (!confirm('Save every group as today\'s project and close their tabs? Everything goes to the Attic and the project can be restored.')) return;
  const r = await send('projects:endOfDay');
  toast(`Saved “${r.project.name}”, closed ${r.closed} tabs`);
  refresh();
}

function renderFooter() {
  const s = state.spend;
  const cap = state.monthlyCapUsd;
  clear($('footer')).appendChild(h('div', { class: 'row', style: { fontSize: '11px', marginTop: '8px' } },
    h('span', { class: 'grow' }, state.provider.ok ? `Model spend this month ${usd(s.usd)}${cap ? ' of ' + usd(cap) : ''} · ${s.calls} calls` : 'Heuristics only, no model calls'),
    h('a', { href: '#', onClick: (e) => { e.preventDefault(); openAttic(); } }, `Attic (${state.atticCount})`)));
}

function openAttic() { browser.tabs.create({ url: browser.runtime.getURL('src/attic/attic.html') }); if (!isPage) window.close(); }

function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

$('more-btn').addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); $('more').classList.toggle('open'); });
$('more').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
  const what = b.dataset.open;
  if (what === 'options') browser.runtime.openOptionsPage();
  else if (what === 'attic') openAttic();
  else if (what === 'page') browser.tabs.create({ url: browser.runtime.getURL('src/popup/popup.html?page=1') });
  else if (what === 'sidebar') browser.sidebarAction.open().catch(() => toast('Use View → Sidebar → Tab Steward', 'err'));
  if (!isPage) window.close();
}));

$('tidy').addEventListener('click', async () => {
  $('tidy').disabled = true; $('tidy').textContent = 'Tidying…';
  try {
    const r = await send('tidy');
    toast(r.skipped ? 'Already tidying' : `${r.executed.length} done, ${r.suggested.length} suggested`);
  } catch (e) { toast(e.message, 'err'); }
  $('tidy').disabled = false; $('tidy').textContent = 'Tidy now';
  refresh();
});

$('undo').addEventListener('click', async () => {
  const n = await send('undoLast');
  toast(n ? `Undid ${n} change${n === 1 ? '' : 's'}` : 'Nothing to undo');
  refresh();
});

$('ask').addEventListener('input', (e) => { filter = e.target.value; renderTabs(); });
$('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') askModel(); if (e.key === 'Escape') { filter = ''; e.target.value = ''; $('answer').hidden = true; renderTabs(); } });
$('ask-btn').addEventListener('click', askModel);

async function askModel() {
  const q = $('ask').value.trim();
  if (!q) return;
  const el = $('answer');
  el.hidden = false;
  clear(el).appendChild(h('div', { class: 'banner' }, 'Asking the model…'));
  try {
    const r = await send('ask', { query: q });
    clear(el);
    const card = h('div', { class: 'banner' });
    card.appendChild(h('div', { class: 'row' }, h('span', { class: 'badge' }, r.intent), h('span', { class: 'grow answer' }, r.answer || '')));
    for (const t of r.tabs.slice(0, 12)) card.appendChild(h('div', { class: 'tab', onClick: () => jump(t.id) }, favicon(t.favIconUrl), h('span', { class: 'title' }, t.title)));
    const ids = r.tabs.map((t) => t.id);
    const actions = h('div', { class: 'row', style: { marginTop: '6px' } });
    if (ids.length) {
      if (r.intent === 'close') actions.appendChild(h('button', { class: 'small danger', onClick: async () => { await send('tabs:close', { tabIds: ids, reason: `you asked: “${q}”` }); el.hidden = true; refresh(); } }, `Close ${ids.length}`));
      if (r.intent === 'group' || ids.length > 1) actions.appendChild(h('button', { class: 'small', onClick: async () => { const title = prompt('Group title', r.groupTitle || q); if (!title) return; const byWin = new Map(); for (const t of r.tabs) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t.id); } for (const [w, tids] of byWin) await send('createGroup', { tabIds: tids, title, windowId: w }); el.hidden = true; refresh(); } }, `Group ${ids.length}`));
      if (r.intent === 'find' && ids.length === 1) actions.appendChild(h('button', { class: 'small primary', onClick: () => jump(ids[0]) }, 'Jump'));
    }
    actions.appendChild(h('button', { class: 'small', onClick: () => { el.hidden = true; } }, 'Close'));
    card.appendChild(actions);
    el.appendChild(card);
  } catch (e) {
    clear(el).appendChild(h('div', { class: 'banner' }, e.kind === 'NoProviderError' ? 'Add a model key in settings to ask questions. Local search still works as you type.' : 'Model error: ' + e.message));
  }
}

send('popupOpened').catch(() => {});
refresh();
if (isPage) setInterval(refresh, 15000);
