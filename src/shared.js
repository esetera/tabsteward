// Small helpers shared by the popup, options and Attic pages.
export async function send(type, payload = {}) {
  const r = await browser.runtime.sendMessage({ type, ...payload });
  if (!r) throw new Error('No response from background');
  if (!r.ok) { const e = new Error(r.error || 'Failed'); e.kind = r.kind; throw e; }
  return r.result;
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === false || v === null || v === undefined) continue;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function ago(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function hours(n) {
  if (n === null || n === undefined) return '';
  if (n < 1) return '<1 h';
  if (n < 48) return `${Math.round(n)} h`;
  return `${Math.round(n / 24)} d`;
}

export function favicon(url) {
  const img = h('img', { src: url || '', alt: '' });
  img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
  if (!url) img.style.visibility = 'hidden';
  return img;
}

export function colorDot(color) {
  return h('span', { class: 'dot', style: { background: `var(--${color || 'grey'})` } });
}

export function usd(n) { return '$' + (n || 0).toFixed(n >= 1 ? 2 : 3); }

export function toast(msg, kind = '') {
  let t = document.getElementById('toast');
  if (!t) { t = h('div', { id: 'toast', style: { position: 'fixed', bottom: '10px', left: '50%', transform: 'translateX(-50%)', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '8px', padding: '6px 12px', zIndex: 20, boxShadow: '0 4px 14px rgba(0,0,0,.2)' } }); document.body.appendChild(t); }
  t.textContent = msg;
  t.style.color = kind === 'err' ? 'var(--danger)' : 'var(--text)';
  t.style.display = 'block';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.display = 'none'; }, 2600);
}
