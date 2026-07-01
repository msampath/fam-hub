import { describe, it, expect } from 'vitest';
import { parseDuckDuckGoHtml, htmlToText, searchWeb, extractLinks, registrableDomain, trustedBookingLinks } from '../utils/webResearch';

describe('webResearch — keyless DuckDuckGo HTML parse', () => {
  const html = `
    <div class="result">
      <a class="result__a" href="https://www.recreation.gov/timed-entry/mount-rainier">Mount Rainier Timed Entry</a>
      <a class="result__snippet">A reservation is required.</a>
    </div>
    <div class="result">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fwww.nps.gov%2Fmora%2Findex.htm&rut=abc">Mount Rainier National Park</a>
    </div>`;

  it('extracts title + URL pairs and unwraps DDG redirect links', () => {
    const r = parseDuckDuckGoHtml(html, 5);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ title: 'Mount Rainier Timed Entry', url: 'https://www.recreation.gov/timed-entry/mount-rainier' });
    expect(r[1].url).toBe('https://www.nps.gov/mora/index.htm'); // uddg= unwrapped + decoded
  });

  it('honors the max cap', () => {
    expect(parseDuckDuckGoHtml(html, 1)).toHaveLength(1);
  });

  it('drops non-http(s) targets', () => {
    const bad = '<a class="result__a" href="javascript:alert(1)">x</a>';
    expect(parseDuckDuckGoHtml(bad, 5)).toHaveLength(0);
  });
});

describe('webResearch — htmlToText', () => {
  it('strips scripts/styles/tags and decodes entities, capped', () => {
    const t = htmlToText('<style>x{}</style><script>evil()</script><p>Hello &amp; welcome</p><div>Line</div>', 1000);
    expect(t).not.toMatch(/evil|<p>|<script/);
    expect(t).toMatch(/Hello & welcome/);
    expect(t).toMatch(/Line/);
  });

  it('truncates past the cap', () => {
    const t = htmlToText('<p>' + 'a'.repeat(50) + '</p>', 10);
    expect(t.length).toBeLessThan(40);
    expect(t).toMatch(/truncated/);
  });
});

describe('webResearch — extractLinks (fetch_page links for the handoff provenance gate)', () => {
  const html = `<a href="/about">About</a>
    <a href="https://www.yelp.com/reservations/din-tai-fung-bellevue-4?from_reserve_now=1"><span>Reserve</span></a>
    <a href="#top">skip</a><a href="mailto:a@b.c">mail</a><a href="javascript:void(0)">x</a>`;
  const links = extractLinks(html, 'https://dtf.com/en-us/locations/bellevue');

  it('surfaces the booking (Reserve) link first', () => {
    expect(links[0].href).toContain('yelp.com/reservations/din-tai-fung-bellevue-4');
    expect(links[0].text).toBe('Reserve');
  });

  it('resolves relative links to absolute and drops junk (anchors/mailto/js)', () => {
    const hrefs = links.map(l => l.href);
    expect(hrefs).toContain('https://dtf.com/about');
    expect(hrefs.some(h => /^(mailto|javascript)/i.test(h) || h.includes('#top'))).toBe(false);
  });
});

describe('webResearch — registrableDomain (handoff provenance origin)', () => {
  it('reduces a host to eTLD+1, stripping www and subdomains', () => {
    expect(registrableDomain('www.opentable.com')).toBe('opentable.com');
    expect(registrableDomain('book.venue.com')).toBe('venue.com');
    expect(registrableDomain('opentable.com')).toBe('opentable.com');
  });
  it('handles multi-part public suffixes', () => {
    expect(registrableDomain('reserve.venue.co.uk')).toBe('venue.co.uk');
    expect(registrableDomain('venue.co.uk')).toBe('venue.co.uk');
  });
  it('treats an IP literal as its own domain; empty → null', () => {
    expect(registrableDomain('8.8.8.8')).toBe('8.8.8.8');
    expect(registrableDomain('')).toBeNull();
  });
});

describe('webResearch — trustedBookingLinks (provenance-poisoning fix)', () => {
  const page = 'https://www.somerestaurant.com/locations/bellevue';
  it('keeps same-domain + known-provider links and DROPS planted cross-domain links', () => {
    const out = trustedBookingLinks(page, [
      'https://www.somerestaurant.com/reserve',        // same registrable domain → trusted
      'https://reserve.somerestaurant.com/now',        // subdomain, same domain → trusted
      'https://www.opentable.com/r/somerestaurant',    // known booking provider → trusted
      'https://phishing.com/fake-login',               // attacker-planted → DROPPED
      'https://evil.example/login',                    // cross-domain → DROPPED
    ]);
    expect(out).toEqual([
      'https://www.somerestaurant.com/reserve',
      'https://reserve.somerestaurant.com/now',
      'https://www.opentable.com/r/somerestaurant',
    ]);
  });
  it('returns [] for a non-array input', () => {
    expect(trustedBookingLinks(page, undefined as any)).toEqual([]);
  });
});

describe('webResearch — searchWeb chain', () => {
  it('returns an empty outcome for a blank query without touching the network', async () => {
    const r = await searchWeb('   ');
    expect(r).toEqual({ provider: 'none', results: [] });
  });
});
