import { describe, it, expect } from 'vitest';
import { parsePolicyFallback, validateRules, effectivePolicy, describeRule } from '../src/lib/rules.js';

const policy = `Never close anything on github.com.
Shopping tabs die after 3 days.
Keep docs.python.org under Work.
Ask me before closing anything I typed into.
Never send mail.google.com to the model.
Protect calendar.google.com.
Close news after 12 hours.`;

describe('parsePolicyFallback', () => {
  const rules = validateRules(parsePolicyFallback(policy));
  it('compiles each supported sentence', () => {
    expect(rules.length).toBe(7);
  });
  it('protects github from closing', () => {
    const p = effectivePolicy(rules, { url: 'https://github.com/x/y', title: 'PR' }, 'Dev');
    expect(p.closeNever).toBe(true);
    expect(p.protect).toBe(false);
  });
  it('sets a shopping close threshold in hours', () => {
    const p = effectivePolicy(rules, { url: 'https://shop.example/x', title: '' }, 'Shopping');
    expect(p.closeAfterHours).toBe(72);
  });
  it('groups python docs under Work', () => {
    const p = effectivePolicy(rules, { url: 'https://docs.python.org/3/', title: 'docs' }, 'Docs');
    expect(p.group).toBe('Work');
  });
  it('never sends gmail and fully protects calendar', () => {
    expect(effectivePolicy(rules, { url: 'https://mail.google.com/', title: '' }, 'Mail').neverSend).toBe(true);
    const cal = effectivePolicy(rules, { url: 'https://calendar.google.com/', title: '' }, 'Work');
    expect(cal.protect).toBe(true);
    expect(cal.neverHide).toBe(true);
  });
  it('news closes after 12 hours', () => {
    expect(effectivePolicy(rules, { url: 'https://bbc.com/x', title: '' }, 'News').closeAfterHours).toBe(12);
  });
  it('describes rules readably', () => {
    expect(describeRule(rules[0])).toContain('github.com');
    expect(describeRule(rules[0])).toContain('never closed');
  });
});

describe('validateRules', () => {
  it('drops junk and bad regexes', () => {
    const out = validateRules([{ match: { urlRegex: '(' }, effect: { protect: true } }, { match: { host: 'a.com' }, effect: {} }, 'x', { match: { category: 'Nope', host: 'b.com' }, effect: { closeAfterHours: 5 } }]);
    expect(out.length).toBe(1);
    expect(out[0].match).toEqual({ host: 'b.com' });
  });
});
