// URL helpers. Pure functions, no browser APIs, so they are unit-testable.

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'dclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'ref', 'ref_src',
  '_ga', '_gl', 'yclid', 'twclid', 'ttclid', 's_kwcid', 'spm', 'si'
]);

const EPHEMERAL_PATH = [
  /\/oauth2?\//i, /\/callback\b/i, /\/auth\/(callback|return|complete)/i,
  /\/logout\b/i, /\/signed[-_]?out\b/i, /\/logged[-_]?out\b/i,
  /\/thank[-_]?you\b/i, /\/thanks\b/i, /\/confirmation\b/i, /\/order[-_]?(complete|confirmed)\b/i,
  /\/checkout\/(success|complete|thank)/i, /\/unsubscribe(d)?\b/i, /\/verify[-_]?email\b/i,
  /\/email[-_]?confirm(ed)?\b/i, /\/subscribed\b/i, /\/success\b/i
];
const EPHEMERAL_TITLE = [
  /thanks? for (subscribing|signing up|your order|registering|confirming)/i,
  /you(’|')?re (all set|signed in|logged in|logged out|subscribed)/i,
  /(order|payment|email) confirm(ed|ation)/i, /successfully (signed|logged) (in|out)/i,
  /^redirecting/i, /^signing you in/i
];
const EPHEMERAL_QUERY = ['code', 'state', 'oauth_token', 'SAMLResponse', 'session_state', 'id_token'];

export function safeUrl(u) {
  try { return new URL(u); } catch { return null; }
}

export function hostOf(u) {
  const url = safeUrl(u);
  if (!url) return '';
  return url.hostname.replace(/^www\./, '').toLowerCase();
}

export function isInternalUrl(u) {
  return !u || /^(about|moz-extension|chrome|resource|view-source|file|blob):/i.test(u);
}

// Canonical form for duplicate detection.
export function normalizeUrl(u) {
  const url = safeUrl(u);
  if (!url) return u || '';
  url.hostname = url.hostname.replace(/^www\./, '').toLowerCase();
  if (url.protocol === 'http:') url.protocol = 'https:';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key) || /^utm_/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  // Fragments are navigation-only on most sites, but SPA routers use them. Keep #/ style, drop the rest.
  if (url.hash && !url.hash.startsWith('#/')) url.hash = '';
  if (url.pathname.length > 1 && url.pathname.endsWith('/')) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function urlKey(u) {
  return normalizeUrl(u);
}

export function isEphemeral({ url, title }) {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  if (EPHEMERAL_PATH.some((re) => re.test(parsed.pathname))) return true;
  const qKeys = [...parsed.searchParams.keys()];
  const oauthish = EPHEMERAL_QUERY.filter((k) => qKeys.includes(k)).length;
  if (oauthish >= 2) return true;
  if (title && EPHEMERAL_TITLE.some((re) => re.test(title))) return true;
  return false;
}

export function isBlankTab(tab) {
  return !tab.url || tab.url === 'about:blank' || tab.url === 'about:newtab' || tab.url === 'about:home';
}

// Glob like "*.github.com" or "github.com" -> matches host and subdomains.
export function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  const p = pattern.toLowerCase().replace(/^\*\./, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const h = host.toLowerCase().replace(/^www\./, '');
  return h === p || h.endsWith('.' + p);
}

export function shortPath(u, max = 60) {
  const url = safeUrl(u);
  if (!url) return '';
  const p = url.pathname + (url.search ? '?' + url.search.slice(1, 40) : '');
  return p.length > max ? p.slice(0, max) + '…' : p;
}

export function looksLikeArticle({ url, title }) {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const path = parsed.pathname;
  if (/\/(article|articles|story|stories|blog|posts?|news|opinion|20\d\d\/\d\d)\//i.test(path)) return true;
  if (/-[a-z0-9]+-[a-z0-9]+-[a-z0-9]+/i.test(path) && path.split('/').filter(Boolean).length <= 4) return true;
  if (title && title.length > 50 && /\s[-|–—]\s/.test(title)) return true;
  return false;
}
