import { send, h, clear, ago, favicon, toast } from '../shared.js';

const $ = (id) => document.getElementById(id);
let entries = [];
let shown = [];

document.querySelectorAll('.tabs-nav button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs-nav button').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('section').forEach((s) => { s.hidden = s.id !== 'tab-' + b.dataset.tab; });
  if (b.dataset.tab === 'log') renderLog();
}));
$('open-settings').addEventListener('click', () => browser.runtime.openOptionsPage());

async function load() {
  entries = await send('attic:list');
  const reasons = [...new Set(entries.map((e) => e.action))].sort();
  const sel = $('reason-filter');
  while (sel.options.length > 1) sel.remove(1);
  for (const r of reasons) sel.appendChild(h('option', { value: r }, labelAction(r)));
  render();
}

function labelAction(a) {
  return { close: 'closed', duplicate: 'duplicate', ephemeral: 'leftover page', stale: 'stale', readLater: 'read later', endOfDay: 'end of day' }[a] || a;
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

function render() {
  const q = $('search').value.trim().toLowerCase();
  const f = $('reason-filter').value;
  shown = entries.filter((e) => (!f || e.action === f) && (!q || `${e.title} ${e.url} ${e.groupTitle} ${e.reason} ${e.note}`.toLowerCase().includes(q)));
  const el = clear($('attic'));
  if (!shown.length) { el.appendChild(h('div', { class: 'empty' }, entries.length ? 'No match.' : 'The Attic is empty. Closed tabs will appear here with the reason they were closed.')); return; }
  const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Tab'), h('th', {}, 'Group'), h('th', {}, 'Why'), h('th', {}, 'When'), h('th', {}, ''))));
  const body = h('tbody');
  for (const e of shown.slice(0, 500)) {
    body.appendChild(h('tr', {},
      h('td', {}, h('div', { class: 'tab', onClick: () => restore(e, true) }, favicon(e.favIconUrl), h('span', { class: 'title', title: e.url }, e.title)), h('div', { class: 'muted' }, host(e.url), e.note ? ` · ✎ ${e.note}` : '')),
      h('td', {}, e.groupTitle || h('span', { class: 'muted' }, '—')),
      h('td', {}, h('span', { class: 'badge' }, labelAction(e.action)), ' ', e.reason),
      h('td', { class: 'nowrap muted' }, ago(e.closedAt)),
      h('td', { class: 'nowrap' }, h('button', { class: 'small', onClick: () => restore(e, false) }, 'Restore'), ' ', h('button', { class: 'small danger', onClick: async () => { await send('attic:delete', { id: e.id }); load(); } }, 'Forget'))
    ));
  }
  table.appendChild(body);
  el.appendChild(table);
  if (shown.length > 500) el.appendChild(h('div', { class: 'muted' }, `Showing 500 of ${shown.length}. Narrow the search.`));
}

async function restore(e, activate) {
  await send('attic:restore', { id: e.id, activate });
  toast(`Restored “${e.title.slice(0, 40)}”`);
  load();
}

$('search').addEventListener('input', render);
$('reason-filter').addEventListener('change', render);
$('restore-shown').addEventListener('click', async () => {
  if (!shown.length) return;
  if (shown.length > 20 && !confirm(`Restore ${shown.length} tabs?`)) return;
  const n = await send('attic:restoreBatch', { ids: shown.map((e) => e.id) });
  toast(`Restored ${n} tabs`);
  load();
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Empty the Attic? These tabs cannot be restored from here afterwards (browser history still has them).')) return;
  await send('attic:clear'); load();
});

async function renderLog() {
  const log = await send('log:list');
  const el = clear($('log'));
  if (!log.length) { el.appendChild(h('div', { class: 'empty' }, 'No activity yet.')); return; }
  const table = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Action'), h('th', {}, 'Why'), h('th', {}, 'Tabs'), h('th', {}, ''))));
  const body = h('tbody');
  for (const e of log.slice(0, 300)) {
    body.appendChild(h('tr', {},
      h('td', { class: 'nowrap muted' }, ago(e.ts)),
      h('td', { class: 'nowrap' }, h('span', { class: 'badge ' + e.type }, e.type), e.title ? ` “${e.title}”` : '', e.trigger && e.trigger !== 'steward' ? h('span', { class: 'muted' }, ` (${e.trigger})`) : null),
      h('td', {}, e.reason),
      h('td', {}, (e.tabs || []).slice(0, 5).map((t) => h('div', { class: 'muted', title: t.url }, t.title)), (e.tabs || []).length > 5 ? h('div', { class: 'muted' }, `+${e.tabs.length - 5}`) : null),
      h('td', { class: 'nowrap' }, e.undo && !e.undone ? h('button', { class: 'small', onClick: async () => { const n = await send('log:undo', { batchId: e.batchId }); toast(`Undid ${n}`); renderLog(); load(); } }, 'Undo batch') : e.undone ? h('span', { class: 'chip' }, 'undone') : null)
    ));
  }
  table.appendChild(body);
  el.appendChild(table);
}

load().catch((e) => { document.body.appendChild(h('div', { class: 'status err' }, e.message)); });
