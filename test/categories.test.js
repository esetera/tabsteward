import { describe, it, expect } from 'vitest';
import { classifyHeuristic, colorFor } from '../src/lib/categories.js';

describe('classifyHeuristic', () => {
  it('classifies known sites with high confidence', () => {
    expect(classifyHeuristic({ url: 'https://github.com/a/b', title: 'repo' })).toMatchObject({ category: 'Dev', confidence: 0.9 });
    expect(classifyHeuristic({ url: 'https://www.amazon.com/dp/123', title: 'thing' }).category).toBe('Shopping');
    expect(classifyHeuristic({ url: 'https://www.google.com/search?q=x', title: 'x' }).category).toBe('Search');
    expect(classifyHeuristic({ url: 'https://mail.google.com/mail/u/0/', title: 'Inbox' }).category).toBe('Mail');
  });
  it('uses path prefixes for google flights and maps', () => {
    expect(classifyHeuristic({ url: 'https://www.google.com/flights?x', title: '' }).category).toBe('Travel');
  });
  it('is unsure about unknown sites', () => {
    const r = classifyHeuristic({ url: 'https://random-site.example/thing', title: 'x' });
    expect(r.confidence).toBeLessThan(0.6);
  });
  it('maps categories to Firefox group colours', () => {
    expect(colorFor('Dev')).toBe('purple');
    expect(colorFor('Nope')).toBe('grey');
  });
});
