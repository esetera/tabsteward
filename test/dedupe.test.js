import { describe, it, expect } from 'vitest';
import { findDuplicates } from '../src/lib/dedupe.js';

describe('findDuplicates', () => {
  it('keeps the most recently used copy and closes the rest', () => {
    const tabs = [
      { id: 1, url: 'https://example.com/a?utm_source=x', lastAccessed: 10, windowId: 1 },
      { id: 2, url: 'https://www.example.com/a/', lastAccessed: 50, windowId: 1 },
      { id: 3, url: 'https://example.com/b', lastAccessed: 5, windowId: 1 },
      { id: 4, url: 'https://example.com/a', lastAccessed: 99, windowId: 2, audible: true }
    ];
    const sets = findDuplicates(tabs);
    expect(sets.length).toBe(1);
    expect(sets[0].keep.id).toBe(4);
    expect(sets[0].close.map((t) => t.id).sort()).toEqual([1, 2]);
  });
  it('prefers the active tab and ignores pinned/internal', () => {
    const tabs = [
      { id: 1, url: 'https://x.com/a', lastAccessed: 100, windowId: 1 },
      { id: 2, url: 'https://x.com/a', lastAccessed: 1, windowId: 1, active: true },
      { id: 3, url: 'https://x.com/a', pinned: true, windowId: 1 },
      { id: 4, url: 'about:blank', windowId: 1 }, { id: 5, url: 'about:blank', windowId: 1 }
    ];
    const sets = findDuplicates(tabs);
    expect(sets.length).toBe(1);
    expect(sets[0].keep.id).toBe(2);
    expect(sets[0].close.map((t) => t.id)).toEqual([1]);
  });
});
