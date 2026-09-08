import { describe, it, expect } from 'vitest';
import { normalizeUrl, isEphemeral, hostMatches, hostOf, looksLikeArticle, isInternalUrl } from '../src/lib/urls.js';

describe('normalizeUrl', () => {
  it('strips tracking params, www, trailing slash and sorts the rest', () => {
    expect(normalizeUrl('http://www.Example.com/path/?b=2&utm_source=x&a=1&fbclid=zz')).toBe('https://example.com/path?a=1&b=2');
  });
  it('keeps SPA hash routes but drops anchors', () => {
    expect(normalizeUrl('https://app.example.com/#/inbox')).toBe('https://app.example.com/#/inbox');
    expect(normalizeUrl('https://docs.example.com/page#section')).toBe('https://docs.example.com/page');
  });
  it('returns input unchanged when not a URL', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank');
  });
});

describe('isEphemeral', () => {
  it('detects oauth callbacks and confirmation pages', () => {
    expect(isEphemeral({ url: 'https://id.example.com/oauth2/callback?code=abc&state=xyz', title: '' })).toBe(true);
    expect(isEphemeral({ url: 'https://shop.example.com/checkout/success', title: 'Order' })).toBe(true);
    expect(isEphemeral({ url: 'https://news.example.com/', title: 'Thanks for subscribing!' })).toBe(true);
  });
  it('leaves ordinary pages alone', () => {
    expect(isEphemeral({ url: 'https://github.com/foo/bar/pull/1', title: 'PR' })).toBe(false);
  });
});

describe('hostMatches', () => {
  it('matches host and subdomains, not lookalikes', () => {
    expect(hostMatches('docs.github.com', 'github.com')).toBe(true);
    expect(hostMatches('github.com', '*.github.com')).toBe(true);
    expect(hostMatches('notgithub.com', 'github.com')).toBe(false);
  });
  it('hostOf strips www', () => {
    expect(hostOf('https://www.bbc.co.uk/news')).toBe('bbc.co.uk');
  });
});

describe('looksLikeArticle / isInternalUrl', () => {
  it('spots article paths', () => {
    expect(looksLikeArticle({ url: 'https://example.com/2026/09/some-long-story-title', title: 'x' })).toBe(true);
    expect(looksLikeArticle({ url: 'https://example.com/', title: 'x' })).toBe(false);
  });
  it('recognises internal pages', () => {
    expect(isInternalUrl('about:newtab')).toBe(true);
    expect(isInternalUrl('moz-extension://abc/page.html')).toBe(true);
    expect(isInternalUrl('https://example.com')).toBe(false);
  });
});
