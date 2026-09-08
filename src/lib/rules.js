// Policy rules. A rule is {id, match, effect, source}.
//   match:  { host?: 'github.com', category?: 'Shopping', title?: 'invoice', urlRegex?: '...' , any?: true }
//   effect: { protect?: true, closeAfterHours?: 72, group?: 'Work', confirmClose?: true,
//             neverSend?: true, neverHide?: true, neverSleep?: true, closeNever?: true }
// Rules are compiled once (by the model or by the fallback parser) and then run locally with no model call.
import { hostOf, hostMatches } from './urls.js';
import { CATEGORIES } from './categories.js';

const CATEGORY_WORDS = {
  shopping: 'Shopping', shop: 'Shopping', store: 'Shopping', news: 'News', docs: 'Docs', documentation: 'Docs',
  dev: 'Dev', development: 'Dev', code: 'Dev', coding: 'Dev', work: 'Work', mail: 'Mail', email: 'Mail',
  chat: 'Chat', search: 'Search', searches: 'Search', media: 'Media', video: 'Media', videos: 'Media', music: 'Media',
  social: 'Social', finance: 'Finance', bank: 'Finance', banking: 'Finance', travel: 'Travel', research: 'Research',
  reading: 'Reading', articles: 'Reading', article: 'Reading', ai: 'AI', cloud: 'Cloud'
};

let counter = 0;
export function ruleId() {
  counter += 1;
  return 'r' + Date.now().toString(36) + counter.toString(36);
}

function subjectToMatch(subjectRaw) {
  let subject = subjectRaw.trim().replace(/[.!]$/, '').replace(/\s+(?:to|with)\s+(?:the\s+)?(?:model|ai|llm|cloud|assistant)$/i, '').replace(/^(anything|everything|all|any|tabs?|my)\s+(on|from|at|about|in)?\s*/i, '').replace(/\s+tabs?$/i, '').replace(/[.!]$/, '').trim();
  if (!subject || /^(anything|everything|all|any tab|tabs?)$/i.test(subject)) return { any: true };
  const lower = subject.toLowerCase();
  if (CATEGORY_WORDS[lower]) return { category: CATEGORY_WORDS[lower] };
  if (CATEGORIES.map((c) => c.toLowerCase()).includes(lower)) return { category: CATEGORIES.find((c) => c.toLowerCase() === lower) };
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(subject)) return { host: subject.replace(/\/.*$/, '') };
  // "github" -> github.com style guess, only for single tokens
  if (/^[a-z0-9-]+$/i.test(subject) && subject.length > 2) return { host: lower + '.com', title: subject };
  return { title: subject };
}

function hoursFrom(n, unit) {
  const v = Number(n);
  if (/day/i.test(unit)) return v * 24;
  if (/week/i.test(unit)) return v * 24 * 7;
  if (/minute/i.test(unit)) return v / 60;
  return v;
}

// Deterministic parser for the common sentence shapes. The model handles anything richer.
export function parsePolicyFallback(text) {
  const rules = [];
  const sentences = (text || '').split(/[\n;]+|\.\s+(?=[A-Z])/).map((s) => s.trim().replace(/[.!]+$/, '').trim()).filter(Boolean);
  for (const s of sentences) {
    let m;
    if ((m = s.match(/^(?:never|don't|do not)\s+(?:ever\s+)?(close|touch|hide|sleep|discard|unload|send)\s+(.+)$/i))) {
      const verb = m[1].toLowerCase();
      const match = subjectToMatch(m[2]);
      const effect = verb === 'touch' ? { protect: true } : verb === 'close' ? { closeNever: true } : verb === 'hide' ? { neverHide: true } : verb === 'send' ? { neverSend: true } : { neverSleep: true };
      rules.push({ id: ruleId(), match, effect, source: s });
      continue;
    }
    if ((m = s.match(/^(?:always\s+)?(?:protect|keep)\s+(.+?)\s+(?:open|safe|around)$/i)) || (m = s.match(/^(?:always\s+)?protect\s+(.+)$/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { protect: true }, source: s });
      continue;
    }
    if ((m = s.match(/^(.+?)\s+(?:tabs?\s+)?(?:die|dies|expire|expires|close|closes|can close|can be closed|should close|get closed|go)\s+after\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|weeks?|minutes?)/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { closeAfterHours: hoursFrom(m[2], m[3]) }, source: s });
      continue;
    }
    if ((m = s.match(/^close\s+(.+?)\s+after\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|days?|weeks?|minutes?)/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { closeAfterHours: hoursFrom(m[2], m[3]) }, source: s });
      continue;
    }
    if ((m = s.match(/^ask(?:\s+me)?\s+(?:first\s+)?before\s+closing\s+(.+)$/i)) || (m = s.match(/^confirm\s+before\s+closing\s+(.+)$/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { confirmClose: true }, source: s });
      continue;
    }
    if ((m = s.match(/^(?:keep|put|group|file)\s+(.+?)\s+(?:under|in|into|with)\s+(?:the\s+)?(?:group\s+)?["“']?([A-Za-z0-9 &/-]{2,30}?)["”']?(?:\s+group)?$/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { group: m[2].trim() }, source: s });
      continue;
    }
    if ((m = s.match(/^(.+?)\s+(?:stays?|belongs?|goes?)\s+(?:grouped\s+)?(?:under|in|into|with)\s+(?:the\s+)?(?:group\s+)?["“']?([A-Za-z0-9 &/-]{2,30}?)["”']?(?:\s+group)?$/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { group: m[2].trim() }, source: s });
      continue;
    }
    if ((m = s.match(/^(?:don't|do not|never)\s+(?:share|send|upload)\s+(.+?)(?:\s+(?:to|with)\s+(?:the\s+)?(?:model|ai|llm|cloud))?$/i))) {
      rules.push({ id: ruleId(), match: subjectToMatch(m[1]), effect: { neverSend: true }, source: s });
      continue;
    }
  }
  return rules;
}

export function validateRules(input) {
  const out = [];
  for (const r of Array.isArray(input) ? input : []) {
    if (!r || typeof r !== 'object') continue;
    const match = {};
    const m = r.match || {};
    if (typeof m.host === 'string' && m.host) match.host = m.host.toLowerCase();
    if (typeof m.category === 'string' && CATEGORIES.includes(m.category)) match.category = m.category;
    if (typeof m.title === 'string' && m.title) match.title = m.title;
    if (typeof m.urlRegex === 'string' && m.urlRegex) {
      try { new RegExp(m.urlRegex); match.urlRegex = m.urlRegex; } catch { /* drop bad regex */ }
    }
    if (m.any === true) match.any = true;
    if (Object.keys(match).length === 0) continue;
    const effect = {};
    const e = r.effect || {};
    for (const flag of ['protect', 'confirmClose', 'neverSend', 'neverHide', 'neverSleep', 'closeNever']) {
      if (e[flag] === true) effect[flag] = true;
    }
    if (typeof e.closeAfterHours === 'number' && e.closeAfterHours > 0) effect.closeAfterHours = e.closeAfterHours;
    if (typeof e.group === 'string' && e.group.trim()) effect.group = e.group.trim().slice(0, 40);
    if (Object.keys(effect).length === 0) continue;
    out.push({ id: typeof r.id === 'string' ? r.id : ruleId(), match, effect, source: typeof r.source === 'string' ? r.source : '' });
  }
  return out;
}

export function ruleMatches(rule, tab, category) {
  const m = rule.match;
  if (m.any) return true;
  const host = hostOf(tab.url || '');
  if (m.host && !hostMatches(host, m.host)) return false;
  if (m.category && m.category !== category) return false;
  if (m.title && !(tab.title || '').toLowerCase().includes(m.title.toLowerCase())) return false;
  if (m.urlRegex) {
    try { if (!new RegExp(m.urlRegex, 'i').test(tab.url || '')) return false; } catch { return false; }
  }
  return true;
}

// Merge every matching rule into one effective policy for a tab. Later rules win for scalar fields.
export function effectivePolicy(rules, tab, category) {
  const policy = { protect: false, confirmClose: false, neverSend: false, neverHide: false, neverSleep: false, closeNever: false, closeAfterHours: null, group: null, matched: [] };
  for (const rule of rules || []) {
    if (!ruleMatches(rule, tab, category)) continue;
    policy.matched.push(rule.id);
    for (const [k, v] of Object.entries(rule.effect)) policy[k] = v;
  }
  if (policy.protect) { policy.closeNever = true; policy.neverHide = true; policy.neverSleep = true; }
  return policy;
}

export function describeRule(rule) {
  const m = rule.match;
  const subject = m.any ? 'every tab' : m.host ? m.host : m.category ? m.category + ' tabs' : m.title ? `tabs titled "${m.title}"` : m.urlRegex ? `URLs matching /${m.urlRegex}/` : 'tabs';
  const e = rule.effect;
  const parts = [];
  if (e.protect) parts.push('never touched');
  if (e.closeNever) parts.push('never closed');
  if (e.neverHide) parts.push('never hidden');
  if (e.neverSleep) parts.push('never put to sleep');
  if (e.neverSend) parts.push('never sent to the model');
  if (e.confirmClose) parts.push('closing needs confirmation');
  if (e.closeAfterHours) parts.push(`closed after ${e.closeAfterHours >= 48 ? Math.round(e.closeAfterHours / 24) + ' days' : e.closeAfterHours + ' hours'} idle`);
  if (e.group) parts.push(`grouped under "${e.group}"`);
  return `${subject}: ${parts.join(', ')}`;
}
