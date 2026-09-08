// Staleness decisions. Everything here is pure: pass in tabs, policies, and "now".
import { DEFAULT_STALE_HOURS } from './categories.js';
import { looksLikeArticle } from './urls.js';

export function hoursIdle(tab, now) {
  const last = tab.lastAccessed || now;
  return Math.max(0, (now - last) / 3600000);
}

export function staleThresholdHours(category, settings, policy) {
  if (policy && policy.closeAfterHours) return policy.closeAfterHours;
  const table = { ...DEFAULT_STALE_HOURS, ...(settings.staleHours || {}) };
  return table[category] ?? table.default;
}

// Returns null (leave alone) or {action: 'sleep'|'close'|'readLater', reason}
export function stalenessDecision(tab, { category, policy, settings, now, snoozedUntil = 0, dirty = false, inFocus = false }) {
  if (tab.active || tab.pinned || tab.audible || tab.highlighted && tab.active) return null;
  if (tab.sharingState && (tab.sharingState.camera || tab.sharingState.microphone || tab.sharingState.screen)) return null;
  if (inFocus) return null;
  if (policy.protect) return null;
  if (snoozedUntil > now) return null;
  if (dirty) return null;
  const idle = hoursIdle(tab, now);
  const threshold = staleThresholdHours(category, settings, policy);
  const sleepAt = threshold * (settings.sleepFraction ?? 0.5);
  const readLaterHours = (settings.readLaterDays ?? 4) * 24;

  if (!policy.closeNever && idle >= threshold) {
    return { action: 'close', reason: `idle ${fmtHours(idle)}, ${category} tabs close after ${fmtHours(threshold)}`, needsConfirm: !!policy.confirmClose };
  }
  if (!policy.closeNever && looksLikeArticle(tab) && idle >= readLaterHours && idle < threshold) {
    return { action: 'readLater', reason: `article open ${fmtHours(idle)} without being read` };
  }
  if (!policy.neverSleep && !tab.discarded && idle >= sleepAt) {
    return { action: 'sleep', reason: `idle ${fmtHours(idle)}, sleeping to free memory` };
  }
  return null;
}

export function fmtHours(h) {
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}
