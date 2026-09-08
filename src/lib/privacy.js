import { hostOf, hostMatches } from './urls.js';

// Tabs on these hosts are never described to a model, not even by title. Heuristics only.
export const DEFAULT_NEVER_SEND = [
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.proton.me', 'fastmail.com', 'mail.yahoo.com',
  'paypal.com', 'stripe.com', 'wise.com', 'coinbase.com', 'binance.com', 'chase.com', 'bankofamerica.com', 'wellsfargo.com',
  'hsbc.com', 'revolut.com', 'monzo.com', 'anz.co.nz', 'asb.co.nz', 'kiwibank.co.nz', 'westpac.co.nz', 'bnz.co.nz',
  'xero.com', 'quickbooks.intuit.com', 'myir.ird.govt.nz', 'irs.gov', 'health.govt.nz', 'mygov.au',
  'accounts.google.com', 'login.microsoftonline.com', 'auth0.com', 'okta.com', '1password.com', 'bitwarden.com', 'lastpass.com'
];

// local = the model runs on this machine and the user has allowed it to see everything. Then only an
// explicit "never send" rule holds a tab back.
export function isNeverSend(tab, neverSendList, policy, { local = false } = {}) {
  if (policy && policy.neverSend) return true;
  const host = hostOf(tab.url || '');
  if (!host) return true; // internal pages never leave the browser
  if (local) return false;
  return (neverSendList || []).some((p) => hostMatches(host, p));
}

// The only shape of tab data that ever leaves the browser.
export function tabForModel(tab, { includeContent = false, content = '' } = {}) {
  const out = { id: tab.id, title: (tab.title || '').slice(0, 120), host: hostOf(tab.url || ''), path: pathFor(tab.url) };
  if (includeContent && content) out.excerpt = content.slice(0, 600);
  return out;
}

function pathFor(u) {
  try {
    const url = new URL(u);
    const p = url.pathname;
    return p.length > 80 ? p.slice(0, 80) + '…' : p;
  } catch { return ''; }
}

export function redactApiKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return key.slice(0, 4) + '••••' + key.slice(-4);
}
