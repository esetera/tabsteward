import { describe, it, expect } from 'vitest';
import { stalenessDecision } from '../src/lib/staleness.js';

const H = 3600000;
const now = Date.now();
const settings = { staleHours: {}, sleepFraction: 0.5, readLaterDays: 4 };
const open = { protect: false, closeNever: false, neverSleep: false, confirmClose: false, closeAfterHours: null };

describe('stalenessDecision', () => {
  it('sleeps at half the threshold and closes at the threshold', () => {
    const tab = { url: 'https://example.com/x', title: 'x', lastAccessed: now - 40 * H };
    expect(stalenessDecision(tab, { category: 'Shopping', policy: open, settings, now }).action).toBe('sleep');
    tab.lastAccessed = now - 80 * H;
    expect(stalenessDecision(tab, { category: 'Shopping', policy: open, settings, now }).action).toBe('close');
  });
  it('never touches active, pinned, audible, protected or snoozed tabs', () => {
    const base = { url: 'https://example.com/x', title: 'x', lastAccessed: now - 500 * H };
    expect(stalenessDecision({ ...base, active: true }, { category: 'News', policy: open, settings, now })).toBeNull();
    expect(stalenessDecision({ ...base, pinned: true }, { category: 'News', policy: open, settings, now })).toBeNull();
    expect(stalenessDecision({ ...base, audible: true }, { category: 'News', policy: open, settings, now })).toBeNull();
    expect(stalenessDecision(base, { category: 'News', policy: { ...open, protect: true }, settings, now })).toBeNull();
    expect(stalenessDecision(base, { category: 'News', policy: open, settings, now, snoozedUntil: now + H })).toBeNull();
    expect(stalenessDecision(base, { category: 'News', policy: open, settings, now, dirty: true })).toBeNull();
  });
  it('respects closeNever but still sleeps', () => {
    const tab = { url: 'https://example.com/x', title: 'x', lastAccessed: now - 900 * H };
    expect(stalenessDecision(tab, { category: 'News', policy: { ...open, closeNever: true }, settings, now }).action).toBe('sleep');
  });
  it('flags confirmation when the policy asks', () => {
    const tab = { url: 'https://example.com/x', title: 'x', lastAccessed: now - 900 * H };
    expect(stalenessDecision(tab, { category: 'News', policy: { ...open, confirmClose: true }, settings, now }).needsConfirm).toBe(true);
  });
  it('offers read later for old articles before closing them', () => {
    const tab = { url: 'https://example.com/2026/09/a-long-story-about-things', title: 'A long story about things - Example News', lastAccessed: now - 5 * 24 * H };
    expect(stalenessDecision(tab, { category: 'Dev', policy: open, settings, now }).action).toBe('readLater');
  });
});
