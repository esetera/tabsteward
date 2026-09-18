// The steward panel. One page, three modes: toolbar popup, sidebar, full page.
import { send, h, clear, ago, hours, favicon, colorDot, usd, toast } from '../shared.js';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'popup';
document.body.classList.add('mode-' + mode);
const isPopup = mode === 'popup';
const $ = (id) => document.getElementById(id);
const COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];

let state = null;
let filter = '';
let view = 'home';
let expanded = new Set();
try {
  view = localStorage.getItem('ts.view.' + mode) || (isPopup ? 'home' : 'groups');
  expanded = new Set(JSON.parse(localStorage.getItem('ts.expanded') || '[]'));
} catch { /* storage unavailable */ }
function remember() { try { localStorage.setItem('ts.view.' + mode, view); localStorage.setItem('ts.expanded', JSON.stringify([...expanded])); } catch { /* ignore */ } }

// ---------- data ----------
async function refresh() {
  try { state = await send('overview'); } catch (e) { $('view').textContent = 'Could not reach the steward: ' + e.message; return; }
  render();
}

function render() {
  renderHeader();
  renderNav();
  const views = { home: renderHome, groups: renderGroups, attic: renderAttic, projects: renderProjects, log: renderLog };
  (views[view] || renderHome)();
  renderFooter();
}

// ---------- header ----------
function renderHeader() {
  const pause = $('pause');
  pause.textContent = state.paused ? 'Resume' : 'Pause';
  pause.classList.toggle('warn', !!state.paused);
  pause.title = state.paused ? 'Resume the steward' : 'Pause everything automatic until you resume (Alt+Shift+X)';
  const p = state.provider;
  const el = $('provider');
  el.textContent = p.ok ? (p.local ? '⌂ ' : '') + p.model : 'no model';
  el.className = 'chip ' + (p.ok ? 'ok' : 'warn');
  el.title = p.ok ? `${p.label} · ${p.model}${p.local ? ' · runs on this machine' : ''}` : 'No model configured. Heuristics only. Open settings to add one.';
}

function renderNav() {
  const counts = { home: state.suggestions.length || null, groups: state.counts.groups, attic: state.atticCount, projects: null, log: null };
  document.querySelectorAll('#nav button').forEach((b) => {
    const v = b.dataset.view;
    b.classList.toggle('active', v === view);
    if (!b.dataset.label) b.dataset.label = b.textContent.trim();
    clear(b).append(b.dataset.label, counts[v] ? h('span', { class: 'count' }, String(counts[v])) : '');
  });
}
document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; remember(); render(); }));

// ---------- home ----------
function renderHome() {
  const el = clear($('view'));
  if (!state.onboarded && !state.provider.ok) {
    el.appendChild(h('div', { class: 'banner' }, h('b', { text: 'Welcome. ' }), 'Tab Steward works without a model (known sites, duplicates, staleness). Add a local model (Ollama, LM Studio) or an API key for smart grouping and instructions. ',
      h('button', { class: 'small', onClick: () => browser.runtime.openOptionsPage() }, 'Open settings'), ' ',
      h('button', { class: 'small', onClick: async () => { await send('settings:save', { patch: { onboarded: true } }); refresh(); } }, 'Dismiss')));
  }
  if (state.paused) {
    el.appendChild(h('div', { class: 'banner row' }, h('span', { class: 'grow' }, h('b', { text: 'Paused. ' }), `Nothing automatic runs (no sorting, folding, hiding or sleeping) until you resume. Since ${ago(state.paused.since)}.`),
      h('button', { class: 'small primary', onClick: async () => { await send('pause:set', { paused: false }); toast('Resumed'); refresh(); } }, 'Resume')));
  }
  const f = state.focus;
  if (f) {
    const mins = Math.max(0, Math.round((f.endsAt - Date.now()) / 60000));
    el.appendChild(h('div', { class: 'banner row' }, h('span', { class: 'grow' }, h('b', { text: `Focus: ${f.title || 'group'}` }), ` · ${mins} min left · ${f.hiddenTabIds.length} tabs hidden`),
      h('button', { class: 'small', onClick: async () => { await send('focus:end'); toast('Focus ended'); refresh(); } }, 'End focus')));
  }
  const c = state.counts;
  el.appendChild(h('div', { class: 'stats' },
    stat(c.tabs, 'tabs', () => { view = 'groups'; remember(); render(); }), stat(c.groups, 'groups', () => { view = 'groups'; remember(); render(); }), stat(c.sleeping, 'sleeping'),
    stat(state.closedSinceLastOpen.length, 'closed since last look', () => { view = 'attic'; remember(); render(); }), stat(c.staleSoon, 'closing within 24 h')));
  if (state.lastTidy) el.appendChild(h('div', { class: 'why' }, `Last tidy ${ago(state.lastTidy.ts)} (${state.lastTidy.trigger}): ${state.lastTidy.executed} done, ${state.lastTidy.suggested} suggested`));
  for (const n of state.streakNudges) {
    el.appendChild(h('div', { class: 'banner row' }, h('span', { class: 'grow' }, `You have approved ${n.n} “${n.gate}” suggestions in a row. Let the steward do those on its own?`),
      h('button', { class: 'small primary', onClick: async () => { await send('settings:save', { patch: { autonomy: { ...state.autonomy, [n.gate]: 'auto' }, approvalStreaks: {} } }); toast(`${n.gate} is now automatic`); refresh(); } }, 'Yes'),
      h('button', { class: 'small', onClick: async () => { await send('settings:save', { patch: { approvalStreaks: {} } }); refresh(); } }, 'Not now')));
  }
  // suggestions
  const list = state.suggestions;
  el.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, `Suggestions (${list.length})`),
    list.length ? h('button', { class: 'small', onClick: async () => { for (const s of list) await send('approve', { id: s.id }); toast('All approved'); refresh(); } }, 'Approve all') : null,
    list.length ? h('button', { class: 'small', onClick: async () => { await send('dismissAll'); refresh(); } }, 'Dismiss all') : null));
  if (!list.length) el.appendChild(h('div', { class: 'empty' }, 'Nothing waiting. The steward suggests here when it is unsure.'));
  for (const s of list) {
    const a = s.action;
    const card = h('div', { class: 'card suggestion' });
    card.appendChild(h('div', { class: 'row' }, h('span', { class: 'badge ' + a.type }, labelFor(a)), h('span', { class: 'grow', style: { fontWeight: 600 } }, a.title ? `“${a.title}”` : ''), s.mode === 'confirm' ? h('span', { class: 'chip warn' }, 'needs OK') : null));
    card.appendChild(h('div', { class: 'reason' }, a.reason));
    for (const t of s.tabs.slice(0, 4)) card.appendChild(h('div', { class: 'tab', onClick: () => jump(t.id) }, favicon(t.favIconUrl), h('span', { class: 'title' }, t.title)));
    if (s.tabs.length > 4) card.appendChild(h('div', { class: 'muted' }, `+${s.tabs.length - 4} more`));
    card.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'small primary', onClick: async () => { await send('approve', { id: s.id }); refresh(); } }, 'Approve'),
      h('button', { class: 'small', onClick: async () => { await send('dismiss', { id: s.id }); refresh(); } }, 'Dismiss')));
    el.appendChild(card);
  }
  // hidden groups
  if (state.hiddenGroups.length) {
    el.appendChild(h('h2', {}, `Hidden groups (${state.hiddenGroups.length})`));
    for (const r of state.hiddenGroups) el.appendChild(h('div', { class: 'group-row' }, colorDot(r.color), h('span', { class: 'title' }, r.title || 'Untitled'), h('span', { class: 'chip' }, `${r.tabIds.length} tabs`), h('span', { class: 'chip' }, ago(r.hiddenAt)),
      h('button', { class: 'small', onClick: async () => { await send('showHidden', { key: r.key }); refresh(); } }, 'Show')));
  }
  if (state.closedSinceLastOpen.length) {
    const d = h('details', {}, h('summary', {}, `Closed since you last looked (${state.closedSinceLastOpen.length})`));
    for (const e of state.closedSinceLastOpen) d.appendChild(h('div', { class: 'tab', onClick: () => send('attic:restore', { id: e.id, activate: true }).then(refresh) }, favicon(e.favIconUrl), h('span', { class: 'title', title: e.reason }, e.title), h('span', { class: 'chip' }, e.reason.slice(0, 28))));
    el.appendChild(d);
  }
}

function stat(n, label, onClick) {
  const el = h('div', { class: 'stat', onClick }, h('b', { text: String(n) }), label);
  if (onClick) el.style.cursor = 'pointer';
  return el;
}

function labelFor(a) {
  return { close: a.subtype === 'duplicate' ? 'close duplicate' : a.subtype === 'ephemeral' ? 'close leftover' : 'close stale', closeSilently: 'close empty', sleep: 'sleep', group: 'group', collapse: 'collapse', hide: 'hide', readLater: 'read later', rename: 'rename' }[a.type] || a.type;
}

// ---------- groups view: drag and drop home ----------
function whyTitle(t) {
  const parts = [t.url, `Category: ${t.category}`];
  if (t.idleHours >= 1) parts.push(`Idle ${hours(t.idleHours)}`);
  if (t.closesInHours !== null) parts.push(t.closesInHours === 0 ? 'Past its close threshold' : `Closes after ${hours(t.closesInHours)} more idle`);
  else parts.push('Never closed by the steward');
  for (const id of t.protectedBy) if (state.rules[id]) parts.push('Rule: ' + state.rules[id]);
  if (t.discarded) parts.push('Sleeping (unloaded)');
  if (t.note) parts.push('Note: ' + t.note);
  return parts.join('\n');
}

function tabRow(t, { draggable = true } = {}) {
  const row = h('div', { class: 'tab' + (t.discarded ? ' discarded' : ''), draggable: draggable ? 'true' : null, title: whyTitle(t), onClick: () => jump(t.id) },
    favicon(t.favIconUrl), h('span', { class: 'title' }, t.title),
    t.note ? h('span', { class: 'chip', title: t.note }, '✎') : null,
    t.audible ? h('span', { class: 'chip' }, '♪') : null,
    t.pinned ? h('span', { class: 'chip' }, 'pinned') : null,
    t.protectedBy.length ? h('span', { class: 'chip ok', title: t.protectedBy.map((id) => state.rules[id]).join('\n') }, 'rule') : null,
    t.closesInHours !== null && t.closesInHours <= 24 ? h('span', { class: 'chip warn' }, `${t.closesInHours} h`) : (t.idleHours >= 1 ? h('span', { class: 'chip' }, hours(t.idleHours)) : null),
    h('span', { class: 'actions' },
      h('button', { class: 'icon', title: 'Note: why is this open?', onClick: (e) => { e.stopPropagation(); editNote(t); } }, '✎'),
      h('button', { class: 'icon', title: 'Sleep', onClick: (e) => { e.stopPropagation(); send('tabs:sleep', { tabIds: [t.id] }).then(refresh); } }, '☾'),
      h('button', { class: 'icon', title: 'Close (to the Attic)', onClick: (e) => { e.stopPropagation(); send('tabs:close', { tabIds: [t.id] }).then(refresh); } }, '✕')));
  if (draggable) {
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ tabId: t.id })); e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  }
  return row;
}

function dropTarget(el, onDrop) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault(); el.classList.remove('drop');
    let data;
    try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
    try { await onDrop(data); } catch (err) { toast(err.message, 'err'); }
    refresh();
  });
}

function renderGroups() {
  const el = clear($('view'));
  const q = filter.trim().toLowerCase();
  const match = (t) => !q || (t.title + ' ' + t.url + ' ' + t.note).toLowerCase().includes(q);
  const groups = state.groups.filter((g) => !g.allHidden);
  const tabsByGroup = new Map();
  for (const t of state.tabs) { if (t.hidden) continue; if (!tabsByGroup.has(t.groupId)) tabsByGroup.set(t.groupId, []); tabsByGroup.get(t.groupId).push(t); }
  const byWindow = new Map();
  for (const g of groups) { if (!byWindow.has(g.windowId)) byWindow.set(g.windowId, []); byWindow.get(g.windowId).push(g); }
  el.appendChild(h('div', { class: 'toolbar' }, h('h2', { class: 'grow', style: { margin: 0 } }, `Groups (${groups.length})`),
    h('button', { class: 'small', onClick: () => { groups.forEach((g) => expanded.add(g.id)); remember(); render(); } }, 'Show tabs'),
    h('button', { class: 'small', onClick: () => { expanded.clear(); remember(); render(); } }, 'Hide tabs'),
    h('button', { class: 'small', title: 'Snapshot every group as a project, then close them', onClick: endOfDay }, 'End of day')));
  const newZone = h('div', { class: 'dropzone' }, '＋ Drop a tab here to start a new group');
  dropTarget(newZone, async (d) => { if (!d.tabId) return; const t = state.tabs.find((x) => x.id === d.tabId); const title = prompt('New group title', t ? t.category : ''); if (!title) return; await send('createGroup', { tabIds: [d.tabId], title, windowId: t.windowId }); });
  el.appendChild(newZone);
  if (!groups.length) el.appendChild(h('div', { class: 'empty' }, 'No groups yet. Click Group, or drag a tab onto the zone above.'));
  const multi = byWindow.size > 1;
  for (const [wid, list] of byWindow) {
    if (multi) el.appendChild(h('div', { class: 'why', style: { marginTop: '6px' } }, `Window ${wid}`));
    for (const g of list) el.appendChild(groupBlock(g, (tabsByGroup.get(g.id) || []).filter(match)));
  }
  const ungrouped = state.tabs.filter((t) => !t.hidden && t.groupId === -1 && match(t));
  const uz = h('div', { class: 'ungrouped-zone' });
  uz.appendChild(h('div', { class: 'row' }, h('h2', { class: 'grow' }, q ? `Matching ungrouped (${ungrouped.length})` : `Ungrouped tabs (${ungrouped.length})`),
    q && ungrouped.length > 1 ? h('button', { class: 'small', onClick: async () => { const title = prompt('Group title', filter.trim()); if (!title) return; const byWin = new Map(); for (const t of ungrouped) { if (!byWin.has(t.windowId)) byWin.set(t.windowId, []); byWin.get(t.windowId).push(t.id); } for (const [w, ids] of byWin) await send('createGroup', { tabIds: ids, title, windowId: w }); refresh(); } }, 'Group these') : null,
    q && ungrouped.length ? h('button', { class: 'small danger', onClick: async () => { await send('tabs:close', { tabIds: ungrouped.map((t) => t.id), reason: 'you closed the search results' }); refresh(); } }, 'Close these') : null));
  dropTarget(uz, async (d) => { if (d.tabId) await send('tabs:ungroup', { tabIds: [d.tabId] }); });
  if (!ungrouped.length) uz.appendChild(h('div', { class: 'empty' }, q ? 'No ungrouped tab matches.' : 'Every tab is in a group. Drop a tab here to take it out of its group.'));
  for (const t of ungrouped.slice(0, 120)) uz.appendChild(tabRow(t));
  if (ungrouped.length > 120) uz.appendChild(h('div', { class: 'muted' }, `+${ungrouped.length - 120} more, refine the search`));
  el.appendChild(uz);
}

function groupBlock(g, tabs) {
  const open = expanded.has(g.id) || !!filter.trim();
  const block = h('div', { class: 'group-block' + (open ? '' : ' collapsed-list') });
  const twisty = h('span', { class: 'twisty', title: open ? 'Hide tabs' : 'Show tabs', onClick: () => { if (expanded.has(g.id)) expanded.delete(g.id); else expanded.add(g.id); remember(); render(); } }, open ? '▾' : '▸');
  const swatch = h('span', { class: 'swatch', style: { background: `var(--${g.color || 'grey'})` }, title: 'Colour' });
  swatch.addEventListener('click', (e) => { e.stopPropagation(); showPalette(swatch, g); });
  const title = h('span', { class: 'title', title: 'Click to rename' }, g.title || 'Untitled');
  title.addEventListener('click', () => {
    const input = h('input', { type: 'text', value: g.title });
    title.replaceWith(input); input.focus(); input.select();
    let done = false;
    const commit = async () => { if (done) return; done = true; const v = input.value.trim(); if (v && v !== g.title) await send('groupAction', { kind: 'rename', groupId: g.id, title: v }); refresh(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { done = true; refresh(); } });
    input.addEventListener('blur', commit);
  });
  const header = h('div', { class: 'group-row', draggable: 'true', title: `${g.workbench ? 'Workbench: the steward leaves these tabs alone' : g.category} · ${g.count} tabs${g.idleHours >= 1 ? ' · idle ' + hours(g.idleHours) : ''}\nDrag to reorder, drop tabs here to add them` },
    twisty, swatch, title,
    g.workbench ? h('span', { class: 'chip ok', title: 'Never regrouped, folded, hidden, slept or closed by the steward' }, 'left alone') : null,
    h('span', { class: 'chip' }, String(g.count)),
    g.idleHours >= 1 ? h('span', { class: 'chip' }, hours(g.idleHours)) : null,
    h('button', { class: 'icon', title: g.collapsed ? 'Expand in the tab strip' : 'Collapse in the tab strip', onClick: (e) => { e.stopPropagation(); act(g.collapsed ? 'expand' : 'collapse', g); } }, g.collapsed ? '▹' : '▿'),
    h('button', { class: 'icon', title: 'Focus on this group for 50 min (hides everything else)', onClick: async (e) => { e.stopPropagation(); await send('focus:start', { groupId: g.id, minutes: 50 }); toast('Focus started'); refresh(); } }, '◎'),
    h('button', { class: 'icon', title: 'Hide this group (Home lists hidden groups)', onClick: (e) => { e.stopPropagation(); act('hide', g, 'Hidden. See Home to bring it back.'); } }, '⌄'),
    h('div', { class: 'menu' },
      h('button', { class: 'icon', onClick: (e) => { e.stopPropagation(); closeMenus(); e.currentTarget.parentElement.classList.toggle('open'); } }, '⋯'),
      h('div', { class: 'menu-list' },
        h('button', { onClick: () => act('autoName', g, 'Named by the model') }, 'Name with the model'),
        h('button', { onClick: () => act('sleep', g, 'Group put to sleep') }, 'Sleep all tabs'),
        h('button', { onClick: () => act('moveToNewWindow', g, 'Moved to its own window') }, 'Move to new window'),
        h('button', { onClick: async () => { const n = await send('gather', { title: g.title }); toast(n ? `Gathered ${n} tabs` : 'Nothing to gather'); refresh(); } }, 'Gather same-named groups here'),
        g.workbench ? h('button', { onClick: async () => { try { const r = await send('workbench:dissolve', { groupId: g.id }); toast(`Workbench dissolved: ${r.tabCount} tabs loose again`); } catch (e) { toast(e.message, 'err'); } refresh(); } }, 'Dissolve workbench') : null,
        h('button', { onClick: () => act('ungroup', g, 'Ungrouped') }, 'Ungroup'),
        h('button', { class: 'danger', onClick: () => act('close', g, 'Group closed (in the Attic)') }, 'Close group'))));
  header.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', JSON.stringify({ groupId: g.id })); e.dataTransfer.effectAllowed = 'move'; });
  dropTarget(block, async (d) => {
    if (d.tabId) await send('tabs:moveToGroup', { tabIds: [d.tabId], groupId: g.id });
    else if (d.groupId && d.groupId !== g.id) await send('group:reorder', { groupId: d.groupId, beforeGroupId: g.id });
  });
  block.appendChild(header);
  const list = h('div', { class: 'group-tabs' });
  if (!tabs.length) list.appendChild(h('div', { class: 'empty' }, filter.trim() ? 'No match in this group.' : 'Empty'));
  for (const t of tabs) list.appendChild(tabRow(t));
  block.appendChild(list);
  return block;
}

function showPalette(anchor, g) {
  document.querySelectorAll('.palette').forEach((p) => p.remove());
  const pal = h('div', { class: 'palette' });
  for (const c of COLORS) pal.appendChild(h('span', { class: 'swatch', style: { background: `var(--${c})` }, title: c, onClick: async () => { pal.remove(); await send('groupAction', { kind: 'rename', groupId: g.id, title: g.title || 'Untitled', color: c }); refresh(); } }));
  const r = anchor.getBoundingClientRect();
  Object.assign(pal.style, { left: Math.min(r.left, window.innerWidth - 130) + 'px', top: (r.bottom + window.scrollY + 4) + 'px' });
  document.body.appendChild(pal);
  setTimeout(() => document.addEventListener('click', () => pal.remove(), { once: true }), 0);
}

async function act(kind, g, msg) {
  try { await send('groupAction', { kind, groupId: g.id }); if (msg) toast(msg); } catch (e) { toast(e.message, 'err'); }
  refresh();
}

// ---------- attic view ----------
let atticCache = null;
let atticReason = '';
async function renderAttic() {
  const el = clear($('view'));
  if (!atticCache) { try { atticCache = await send('attic:list'); } catch { atticCache = []; } }
  const q = filter.trim().toLowerCase();
  const reasons = [...new Set(atticCache.map((e) => e.action))].sort();
  const sel = h('select', { style: { maxWidth: '150px' }, onChange: (e) => { atticReason = e.target.value; renderAttic(); } }, h('option', { value: '' }, 'All reasons'), ...reasons.map((r) => h('option', { value: r, selected: r === atticReason }, labelAction(r))));
  const shown = atticCache.filter((e) => (!atticReason || e.action === atticReason) && (!q || `${e.title} ${e.url} ${e.groupTitle} ${e.reason} ${e.note}`.toLowerCase().includes(q)));
  el.appendChild(h('div', { class: 'toolbar' }, h('h2', { class: 'grow', style: { margin: 0 } }, `Attic (${shown.length}${shown.length !== atticCache.length ? ' of ' + atticCache.length : ''})`), sel,
    shown.length ? h('button', { class: 'small', onClick: async () => { if (shown.length > 20 && !confirm(`Restore ${shown.length} tabs?`)) return; const n = await send('attic:restoreBatch', { ids: shown.map((e) => e.id) }); toast(`Restored ${n}`); atticCache = null; refresh(); } }, 'Restore shown') : null,
    atticCache.length ? h('button', { class: 'small danger', onClick: async () => { if (!confirm('Empty the Attic?')) return; await send('attic:clear'); atticCache = null; refresh(); } }, 'Empty') : null));
  el.appendChild(h('div', { class: 'why' }, q ? 'Filtered by the search box above.' : 'Type in the box above to search closed tabs by title, site, group or reason.'));
  if (!shown.length) { el.appendChild(h('div', { class: 'empty' }, atticCache.length ? 'No match.' : 'Empty. Closed tabs land here with the reason they were closed.')); return; }
  for (const e of shown.slice(0, 200)) {
    el.appendChild(h('div', { class: 'tab', title: `${e.url}\n${e.reason}` },
      favicon(e.favIconUrl), h('span', { class: 'title' }, e.title),
      e.groupTitle ? h('span', { class: 'chip' }, e.groupTitle) : null,
      h('span', { class: 'chip', title: e.reason }, labelAction(e.action)), h('span', { class: 'chip' }, ago(e.closedAt)),
      h('button', { class: 'small', onClick: async (ev) => { ev.stopPropagation(); await send('attic:restore', { id: e.id, activate: false }); toast('Restored'); atticCache = null; refresh(); } }, 'Restore'),
      h('button', { class: 'icon danger', title: 'Forget', onClick: async (ev) => { ev.stopPropagation(); await send('attic:delete', { id: e.id }); atticCache = null; refresh(); } }, '✕')));
  }
  if (shown.length > 200) el.appendChild(h('div', { class: 'muted' }, `+${shown.length - 200} more, narrow the search`));
}
function labelAction(a) { return { close: 'closed', duplicate: 'duplicate', ephemeral: 'leftover', stale: 'stale', readLater: 'read later' }[a] || a; }

// ---------- projects view ----------
async function renderProjects() {
  const el = clear($('view'));
  let projects = [];
  try { projects = await send('projects:list'); } catch { /* ignore */ }
  el.appendChild(h('div', { class: 'toolbar' }, h('h2', { class: 'grow', style: { margin: 0 } }, `Projects (${projects.length})`),
    h('button', { class: 'small', onClick: async () => { const name = prompt('Project name', ''); if (name === null) return; await send('projects:save', { name }); toast('Saved'); render(); } }, 'Save current groups'),
    h('button', { class: 'small', onClick: endOfDay }, 'End of day')));
  el.appendChild(h('div', { class: 'why' }, 'A project is a snapshot of groups you can bring back later in a fresh window. End of day saves everything and closes it into the Attic.'));
  if (!projects.length) { el.appendChild(h('div', { class: 'empty' }, 'No projects yet.')); return; }
  for (const p of projects) {
    const d = h('details', { class: 'card' }, h('summary', {}, h('b', {}, p.name), ` · ${p.groups.length} groups · ${p.groups.reduce((n, g) => n + g.tabs.length, 0)} tabs · ${ago(p.createdAt)}`));
    for (const g of p.groups) d.appendChild(h('div', { class: 'why' }, `${g.title}: ${g.tabs.slice(0, 4).map((t) => t.title).join(', ')}${g.tabs.length > 4 ? ` +${g.tabs.length - 4}` : ''}`));
    d.appendChild(h('div', { class: 'row', style: { marginTop: '6px' } },
      h('button', { class: 'small primary', onClick: async () => { await send('projects:restore', { id: p.id }); toast('Restored in a new window'); } }, 'Restore'),
      h('button', { class: 'small danger', onClick: async () => { await send('projects:delete', { id: p.id }); render(); } }, 'Delete')));
    el.appendChild(d);
  }
}

async function endOfDay() {
  if (!confirm('Save every group as today\'s project and close their tabs? Everything goes to the Attic and the project can be restored.')) return;
  const r = await send('projects:endOfDay');
  toast(`Saved “${r.project.name}”, closed ${r.closed} tabs`);
  refresh();
}

// ---------- activity log ----------
async function renderLog() {
  const el = clear($('view'));
  let log = [];
  try { log = await send('log:list'); } catch { /* ignore */ }
  el.appendChild(h('div', { class: 'toolbar' }, h('h2', { class: 'grow', style: { margin: 0 } }, 'Activity'), h('span', { class: 'why' }, 'Every action with its reason. Undo works per batch.')));
  if (!log.length) { el.appendChild(h('div', { class: 'empty' }, 'Nothing yet.')); return; }
  const q = filter.trim().toLowerCase();
  for (const e of log.filter((x) => !q || `${x.type} ${x.reason} ${x.title || ''} ${(x.tabs || []).map((t) => t.title).join(' ')}`.toLowerCase().includes(q)).slice(0, 200)) {
    el.appendChild(h('div', { class: 'log-row' }, h('span', { class: 'when' }, ago(e.ts)),
      h('span', {}, h('span', { class: 'badge ' + e.type }, e.type), e.title ? ` “${e.title}”` : '', e.trigger && e.trigger !== 'steward' ? h('span', { class: 'why' }, ` ${e.trigger}`) : null, h('div', { class: 'why' }, e.reason), (e.tabs || []).slice(0, 3).map((t) => h('div', { class: 'why', title: t.url }, '· ' + t.title)), (e.tabs || []).length > 3 ? h('div', { class: 'why' }, `+${e.tabs.length - 3}`) : null),
      e.undo && !e.undone ? h('button', { class: 'small', onClick: async () => { const n = await send('log:undo', { batchId: e.batchId }); toast(`Undid ${n}`); refresh(); } }, 'Undo') : e.undone ? h('span', { class: 'chip' }, 'undone') : h('span')));
  }
}

// ---------- shared bits ----------
async function editNote(t) {
  const current = t.note || '';
  const v = prompt('Why is this tab open? (leave empty and press OK to ask the model)', current);
  if (v === null) return;
  try {
    if (v.trim() === '' && !current) { const note = await send('note:draft', { tabId: t.id }); toast('Note: ' + note); } else await send('note:set', { tabId: t.id, note: v });
  } catch (e) { toast(e.message, 'err'); }
  refresh();
}

async function jump(tabId) {
  try { await send('tabs:activate', { tabId }); if (isPopup) window.close(); } catch (e) { toast(e.message, 'err'); }
}

function renderFooter() {
  const s = state.spend;
  const cap = state.monthlyCapUsd;
  clear($('footer')).appendChild(h('div', { class: 'row', style: { fontSize: '11px' } },
    h('span', { class: 'grow' }, state.provider.ok ? (state.provider.local ? `Local model · ${s.calls} calls this month · nothing leaves this machine` : `Model spend this month ${usd(s.usd)}${cap ? ' of ' + usd(cap) : ''} · ${s.calls} calls`) : 'Heuristics only, no model calls'),
    h('a', { href: '#', onClick: (e) => { e.preventDefault(); browser.runtime.openOptionsPage(); } }, 'Settings')));
}

function closeMenus() { document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenus(); });
$('more-btn').addEventListener('click', (e) => { e.stopPropagation(); closeMenus(); $('more').classList.toggle('open'); });
$('more').querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
  const what = b.dataset.open;
  $('more').classList.remove('open');
  if (what === 'preview') { previewPlan(); return; }
  if (what === 'rethink') { rethink(); return; }
  if (what === 'options') browser.runtime.openOptionsPage();
  else if (what === 'page') browser.tabs.create({ url: browser.runtime.getURL('src/panel/panel.html?mode=page') });
  else if (what === 'sidebar') browser.sidebarAction.open().catch(() => toast('Press Alt+Shift+P, or View → Sidebar → Tab Steward', 'err'));
  if (isPopup) window.close();
}));

$('pause').addEventListener('click', async () => {
  const paused = !state.paused;
  await send('pause:set', { paused });
  toast(paused ? 'Paused until you resume' : 'Resumed');
  refresh();
});
$('keep').addEventListener('click', async () => {
  try { const r = await send('workbench:keep'); toast(`${r.tabCount} tab${r.tabCount === 1 ? '' : 's'} kept together in “${r.title}”`); } catch (e) { toast(e.message, 'err'); }
  refresh();
});

document.querySelectorAll('#quick [data-quick]').forEach((b) => b.addEventListener('click', async () => {
  const kind = b.dataset.quick;
  if (kind === 'closeStale' && !confirm('Close every tab past its staleness threshold? They go to the Attic and can be restored.')) return;
  const label = b.textContent;
  b.disabled = true; b.textContent = '…';
  try {
    const r = await send('quick', { kind });
    toast(r.skipped ? 'Already busy' : r.executed ? `${r.executed} action${r.executed === 1 ? '' : 's'}, ${r.tabs} tab${r.tabs === 1 ? '' : 's'}` : 'Nothing to do');
  } catch (e) { toast(e.message, 'err'); }
  b.disabled = false; b.textContent = label;
  refresh();
}));

$('tidy').addEventListener('click', async () => {
  $('tidy').disabled = true; $('tidy').textContent = 'Tidying…';
  try { const r = await send('tidy'); toast(r.skipped ? 'Already tidying' : `${r.executed.length} done, ${r.suggested.length} suggested`); } catch (e) { toast(e.message, 'err'); }
  $('tidy').disabled = false; $('tidy').textContent = 'Tidy now';
  refresh();
});

async function rethink() {
  if (!confirm('Let the model look at every tab, including ones already in groups, and reorganise them? Your groups stay as candidates; tabs may move. Undo reverses it.')) return;
  $('tidy').disabled = true; $('tidy').textContent = 'Rethinking…';
  try { const r = await send('tidy', { regroupAll: true }); toast(r.skipped ? 'Already tidying' : `${r.executed.length} done, ${r.suggested.length} suggested`); } catch (e) { toast(e.message, 'err'); }
  $('tidy').disabled = false; $('tidy').textContent = 'Tidy now';
  refresh();
}

async function previewPlan() {
  const el = $('plan');
  el.hidden = false;
  clear(el).appendChild(h('div', { class: 'banner' }, 'Planning…'));
  try {
    const plan = await send('preview', { allowModel: false });
    clear(el);
    const card = h('div', { class: 'banner' });
    card.appendChild(h('div', { class: 'row' }, h('b', { class: 'grow' }, plan.length ? `Tidy would take ${plan.length} action${plan.length === 1 ? '' : 's'} (without the model)` : 'Nothing to tidy right now'), h('button', { class: 'small', onClick: () => { el.hidden = true; } }, 'Close')));
    for (const a of plan) card.appendChild(h('div', { class: 'tab', title: a.tabs.map((t) => t.title).join('\n') }, h('span', { class: 'badge ' + a.type }, labelFor(a)), h('span', { class: 'title' }, (a.title ? `“${a.title}” · ` : '') + a.reason), h('span', { class: 'chip' + (a.mode === 'auto' ? ' ok' : ' warn') }, a.mode), a.tabs.length > 1 ? h('span', { class: 'chip' }, `${a.tabs.length} tabs`) : null));
    el.appendChild(card);
  } catch (e) { clear(el).appendChild(h('div', { class: 'banner' }, 'Could not plan: ' + e.message)); }
}

$('undo').addEventListener('click', async () => { const n = await send('undoLast'); toast(n ? `Undid ${n} change${n === 1 ? '' : 's'}` : 'Nothing to undo'); refresh(); });

$('ask').addEventListener('input', (e) => { filter = e.target.value; if (view === 'home' && filter.trim()) { view = 'groups'; remember(); } render(); });
$('ask').addEventListener('keydown', (e) => { if (e.key === 'Enter') askModel(); if (e.key === 'Escape') { filter = ''; e.target.value = ''; $('answer').hidden = true; render(); } });
$('ask-btn').addEventListener('click', askModel);

async function askModel() {
  const q = $('ask').value.trim();
  if (!q) return;
  const el = $('answer');
  el.hidden = false;
  clear(el).appendChild(h('div', { class: 'banner' }, 'Working out what to do…'));
  try { const r = await send('command', { text: q }); renderPlan(r, q); if (r.ran) refresh(); } catch (e) {
    clear(el).appendChild(h('div', { class: 'banner' }, e.kind === 'NoProviderError' ? 'Add a model in settings to give instructions. Search still works as you type.' : 'Model error: ' + e.message));
  }
}

function renderPlan(r, q) {
  const el = clear($('answer'));
  const card = h('div', { class: 'banner' });
  const needsOk = r.needsOk || r.destructive;
  card.appendChild(h('div', { class: 'row' }, h('b', { class: 'grow' }, r.ran ? 'Done' : r.steps.length ? (needsOk ? 'Plan (needs your OK)' : 'Plan') : 'No action'), h('button', { class: 'small', onClick: () => { el.hidden = true; } }, 'Close')));
  if (r.summary) card.appendChild(h('div', { class: 'answer muted' }, r.summary));
  if (!r.ran && r.notes && r.notes.length) card.appendChild(h('div', { class: 'answer' }, h('span', { class: 'chip warn' }, 'Heads up'), ' ' + r.notes.join('. ') + '.'));
  for (const s of (r.ran ? r.results : r.steps)) card.appendChild(h('div', { class: 'tab' }, h('span', { class: 'badge' + (r.ran ? (s.ok ? ' ok' : ' close') : '') }, r.ran ? (s.ok ? 'ok' : 'failed') : 'step'), h('span', { class: 'title', style: { whiteSpace: 'normal' } }, s.text)));
  const findOnly = r.steps.every((s) => s.op === 'find' || s.op === 'answer');
  if (findOnly || !r.ran) for (const t of r.tabs.slice(0, 12)) card.appendChild(h('div', { class: 'tab', onClick: () => jump(t.id) }, favicon(t.favIconUrl), h('span', { class: 'title' }, t.title)));
  const actions = h('div', { class: 'row', style: { marginTop: '6px' } });
  if (!r.ran && r.steps.length && !findOnly) actions.appendChild(h('button', { class: 'small primary', onClick: async () => { const done = await send('command:run', { steps: r.steps, text: q }); renderPlan({ ...r, ...done }, q); refresh(); } }, 'Do it'));
  if (r.ran && r.batchId) actions.appendChild(h('button', { class: 'small', onClick: async () => { const n = await send('log:undo', { batchId: r.batchId }); toast(`Undid ${n}`); el.hidden = true; refresh(); } }, 'Undo this'));
  if (r.tabs.length === 1 && findOnly) actions.appendChild(h('button', { class: 'small primary', onClick: () => jump(r.tabs[0].id) }, 'Jump'));
  card.appendChild(actions);
  el.appendChild(card);
}

send('popupOpened').catch(() => {});
refresh();
if (!isPopup) setInterval(refresh, 10000);
browser.tabs.onUpdated.addListener(() => { if (!isPopup) refreshSoon(); });
browser.tabs.onRemoved.addListener(() => { if (!isPopup) refreshSoon(); });
let refreshTimer = null;
function refreshSoon() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 800); }
