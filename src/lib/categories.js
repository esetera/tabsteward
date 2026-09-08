// Heuristic classifier: cheap, local, runs before the model is ever asked.
import { hostOf, hostMatches, isInternalUrl, safeUrl } from './urls.js';

export const CATEGORIES = [
  'Dev', 'Docs', 'Work', 'Mail', 'Chat', 'Search', 'News', 'Shopping', 'Media', 'Social',
  'Finance', 'Travel', 'Research', 'Reading', 'AI', 'Cloud', 'Misc'
];

export const CATEGORY_COLORS = {
  Dev: 'purple', Docs: 'blue', Work: 'blue', Mail: 'cyan', Chat: 'cyan', Search: 'grey',
  News: 'orange', Shopping: 'yellow', Media: 'red', Social: 'pink', Finance: 'green',
  Travel: 'green', Research: 'blue', Reading: 'orange', AI: 'purple', Cloud: 'grey', Misc: 'grey'
};

// Default hours-until-stale per category. Overridden by settings and rules.
export const DEFAULT_STALE_HOURS = {
  default: 168, Search: 24, News: 96, Shopping: 72, Media: 48, Social: 48, Reading: 96,
  Dev: 336, Docs: 240, Work: 240, Mail: 100000, Chat: 100000, Finance: 48, Travel: 120,
  Research: 168, AI: 96, Cloud: 240, Misc: 120
};

const DOMAIN_RULES = [
  ['Mail', ['mail.google.com', 'outlook.live.com', 'outlook.office.com', 'mail.proton.me', 'fastmail.com', 'mail.yahoo.com', 'icloud.com/mail']],
  ['Chat', ['slack.com', 'discord.com', 'teams.microsoft.com', 'web.whatsapp.com', 'web.telegram.org', 'messenger.com', 'zoom.us', 'meet.google.com']],
  ['Dev', ['github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'npmjs.com', 'pypi.org', 'crates.io', 'rubygems.org', 'localhost', '127.0.0.1', 'vercel.com', 'netlify.com', 'codepen.io', 'codesandbox.io', 'replit.com', 'huggingface.co', 'jsfiddle.net', 'bugzilla.mozilla.org', 'addons.mozilla.org']],
  ['Docs', ['developer.mozilla.org', 'docs.python.org', 'docs.rs', 'docs.github.com', 'learn.microsoft.com', 'developer.apple.com', 'developer.android.com', 'docs.aws.amazon.com', 'cloud.google.com', 'react.dev', 'nodejs.org', 'devdocs.io', 'readthedocs.io', 'docs.anthropic.com', 'platform.openai.com', 'api-docs.deepseek.com', 'docs.z.ai', 'kubernetes.io', 'docs.docker.com', 'wiki.archlinux.org', 'man7.org']],
  ['Work', ['docs.google.com', 'drive.google.com', 'sheets.google.com', 'notion.so', 'atlassian.net', 'jira.com', 'confluence.com', 'linear.app', 'asana.com', 'trello.com', 'monday.com', 'figma.com', 'miro.com', 'airtable.com', 'clickup.com', 'basecamp.com', 'office.com', 'sharepoint.com', 'dropbox.com', 'box.com', 'calendar.google.com', 'hubspot.com', 'salesforce.com', 'zendesk.com', 'intercom.com', 'canva.com']],
  ['Search', ['google.com/search', 'bing.com/search', 'duckduckgo.com', 'search.brave.com', 'startpage.com', 'kagi.com', 'ecosia.org', 'yandex.com/search', 'perplexity.ai']],
  ['AI', ['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'chat.deepseek.com', 'chat.z.ai', 'poe.com', 'copilot.microsoft.com', 'grok.com', 'mistral.ai', 'character.ai']],
  ['News', ['news.ycombinator.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'reuters.com', 'apnews.com', 'bloomberg.com', 'ft.com', 'wsj.com', 'cnn.com', 'economist.com', 'theverge.com', 'arstechnica.com', 'techcrunch.com', 'wired.com', 'stuff.co.nz', 'nzherald.co.nz', 'rnz.co.nz', 'abc.net.au', 'smh.com.au', 'lobste.rs', 'engadget.com', '9to5mac.com', 'macrumors.com']],
  ['Shopping', ['amazon.com', 'amazon.co.uk', 'amazon.com.au', 'amazon.de', 'ebay.com', 'etsy.com', 'aliexpress.com', 'walmart.com', 'target.com', 'bestbuy.com', 'trademe.co.nz', 'shopify.com', 'temu.com', 'ikea.com', 'apple.com/shop', 'noel-leeming.co.nz', 'pbtech.co.nz', 'mightyape.co.nz', 'wish.com', 'newegg.com']],
  ['Media', ['youtube.com', 'youtu.be', 'netflix.com', 'spotify.com', 'twitch.tv', 'vimeo.com', 'soundcloud.com', 'music.apple.com', 'tv.apple.com', 'disneyplus.com', 'primevideo.com', 'hulu.com', 'plex.tv', 'bandcamp.com', 'podcasts.apple.com']],
  ['Social', ['twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'reddit.com', 'linkedin.com', 'threads.net', 'bsky.app', 'mastodon.social', 'tiktok.com', 'pinterest.com', 'tumblr.com', 'snapchat.com']],
  ['Finance', ['paypal.com', 'stripe.com', 'wise.com', 'coinbase.com', 'binance.com', 'xero.com', 'quickbooks.intuit.com', 'anz.co.nz', 'asb.co.nz', 'kiwibank.co.nz', 'westpac.co.nz', 'bnz.co.nz', 'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'hsbc.com', 'revolut.com', 'monzo.com', 'sharesies.nz', 'robinhood.com']],
  ['Travel', ['booking.com', 'airbnb.com', 'expedia.com', 'kayak.com', 'skyscanner.com', 'google.com/flights', 'google.com/travel', 'airnewzealand.co.nz', 'qantas.com', 'jetstar.com', 'tripadvisor.com', 'hotels.com', 'maps.google.com', 'google.com/maps', 'rome2rio.com']],
  ['Research', ['scholar.google.com', 'arxiv.org', 'pubmed.ncbi.nlm.nih.gov', 'nature.com', 'science.org', 'sciencedirect.com', 'springer.com', 'wiley.com', 'jstor.org', 'researchgate.net', 'semanticscholar.org', 'biorxiv.org', 'medrxiv.org', 'ssrn.com', 'plos.org', 'elifesciences.org', 'pnas.org', 'wikipedia.org', 'zotero.org', 'connectedpapers.com']],
  ['Reading', ['medium.com', 'substack.com', 'getpocket.com', 'instapaper.com', 'readwise.io', 'longreads.com', 'aeon.co', 'newyorker.com', 'theatlantic.com', 'goodreads.com']],
  ['Cloud', ['console.aws.amazon.com', 'console.cloud.google.com', 'portal.azure.com', 'cloudflare.com', 'digitalocean.com', 'hetzner.com', 'fly.io', 'render.com', 'railway.app', 'supabase.com', 'firebase.google.com', 'heroku.com', 'linode.com', 'vultr.com', 'dash.cloudflare.com']]
];

function matchDomainRule(url) {
  const host = hostOf(url);
  const parsed = safeUrl(url);
  const path = parsed ? parsed.pathname : '';
  for (const [category, patterns] of DOMAIN_RULES) {
    for (const p of patterns) {
      const slash = p.indexOf('/');
      if (slash >= 0) {
        const pHost = p.slice(0, slash);
        const pPath = p.slice(slash);
        if (hostMatches(host, pHost) && path.startsWith(pPath)) return category;
      } else if (hostMatches(host, p)) {
        return category;
      }
    }
  }
  return null;
}

// Returns {category, confidence, reason}. Confidence < 0.6 means "ask the model if you can".
export function classifyHeuristic(tab) {
  const url = tab.url || '';
  const title = tab.title || '';
  if (isInternalUrl(url)) return { category: 'Misc', confidence: 1, reason: 'browser page' };
  const byDomain = matchDomainRule(url);
  if (byDomain) return { category: byDomain, confidence: 0.9, reason: 'known site' };
  const host = hostOf(url);
  if (/^(docs?|developer|dev|api|wiki|help|support|learn)\./.test(host)) return { category: 'Docs', confidence: 0.7, reason: 'docs-style subdomain' };
  if (/\/(docs?|api|reference|manual|guide)s?(\/|$)/i.test(url)) return { category: 'Docs', confidence: 0.65, reason: 'docs-style path' };
  if (/\.(edu|ac\.[a-z]{2})$/.test(host)) return { category: 'Research', confidence: 0.6, reason: 'academic domain' };
  if (/\/(cart|checkout|basket|product|products|shop|store)(\/|$)/i.test(url)) return { category: 'Shopping', confidence: 0.65, reason: 'shop-style path' };
  if (/(news|times|post|herald|gazette|tribune|journal|daily)\b/i.test(host)) return { category: 'News', confidence: 0.6, reason: 'news-style domain' };
  if (/\?q=|\/search\?/i.test(url)) return { category: 'Search', confidence: 0.7, reason: 'search query URL' };
  if (/\b(login|sign in|sign up|log in)\b/i.test(title)) return { category: 'Misc', confidence: 0.5, reason: 'auth page' };
  return { category: 'Misc', confidence: 0.3, reason: 'unknown site' };
}

export function colorFor(category) {
  return CATEGORY_COLORS[category] || 'grey';
}
