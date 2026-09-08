// Thin storage layer. storage.local for durable state, storage.session for runtime maps that must
// survive the event page being suspended but not a browser restart.
import { DEFAULT_NEVER_SEND } from './privacy.js';

export const DEFAULT_SETTINGS = {
  provider: 'none',
  providers: {
    ollama: { apiKey: '', model: '', baseUrl: 'http://localhost:11434/v1' },
    lmstudio: { apiKey: '', model: '', baseUrl: 'http://localhost:1234/v1' },
    openai: { apiKey: '', model: '' },
    anthropic: { apiKey: '', model: '' },
    deepseek: { apiKey: '', model: '' },
    zai: { apiKey: '', model: '' },
    custom: { apiKey: '', model: '', baseUrl: 'http://localhost:8080/v1' }
  },
  autonomy: { group: 'auto', rename: 'auto', collapse: 'auto', hide: 'suggest', sleep: 'auto', close: 'confirm', dedupe: 'auto', ephemeral: 'auto' },
  policyText: '',
  rules: [],
  neverSend: DEFAULT_NEVER_SEND,
  sendContent: false,
  localSeesEverything: true,
  staleHours: {},
  sleepFraction: 0.5,
  readLaterDays: 4,
  ephemeralMinutes: 10,
  collapseIdleHours: 2,
  hideIdleHours: 24,
  atticDays: 30,
  monthlyCapUsd: 5,
  tidyIntervalMinutes: 15,
  autoGroupNewTabs: true,
  autoTidy: true,
  minGroupSize: 2,
  notifications: true,
  approvalStreaks: {},
  onboarded: false
};

const local = () => browser.storage.local;
const session = () => browser.storage.session;

export async function getSettings() {
  const { settings } = await local().get('settings');
  return mergeSettings(settings);
}

export function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  s.providers = { ...DEFAULT_SETTINGS.providers, ...(saved?.providers || {}) };
  for (const k of Object.keys(DEFAULT_SETTINGS.providers)) s.providers[k] = { ...DEFAULT_SETTINGS.providers[k], ...(s.providers[k] || {}) };
  s.autonomy = { ...DEFAULT_SETTINGS.autonomy, ...(saved?.autonomy || {}) };
  s.staleHours = { ...(saved?.staleHours || {}) };
  s.approvalStreaks = { ...(saved?.approvalStreaks || {}) };
  if (!Array.isArray(s.rules)) s.rules = [];
  if (!Array.isArray(s.neverSend)) s.neverSend = [...DEFAULT_NEVER_SEND];
  return s;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings({ ...current, ...patch });
  await local().set({ settings: next });
  return next;
}

export async function getState(key, fallback) {
  const r = await local().get(key);
  return r[key] === undefined ? fallback : r[key];
}

export async function setState(key, value) {
  await local().set({ [key]: value });
  return value;
}

// Read-modify-write helpers are serialised per key so concurrent events (eight tabs restored at once,
// say) cannot overwrite each other's updates.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(key, run.catch(() => {}));
  return run;
}

export async function updateState(key, fallback, fn) {
  return withLock('local:' + key, async () => {
    const cur = await getState(key, fallback);
    const next = fn(cur);
    await local().set({ [key]: next });
    return next;
  });
}

export async function getSession(key, fallback) {
  try {
    const r = await session().get(key);
    return r[key] === undefined ? fallback : r[key];
  } catch { return fallback; }
}

export async function setSession(key, value) {
  try { await session().set({ [key]: value }); } catch { /* session storage unavailable */ }
  return value;
}

export async function updateSession(key, fallback, fn) {
  return withLock('session:' + key, async () => {
    const cur = await getSession(key, fallback);
    const next = fn(cur);
    await setSession(key, next);
    return next;
  });
}

export function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
