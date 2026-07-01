import { describe, it, expect } from 'vitest';
import { buildNewsletterQuery, buildNewsletterClassifyPrompt, newsletterToDoc, mergeNewsletterDocs, NEWSLETTER_FOLDER } from '../utils/newsletters';
import type { LibraryDoc } from '../types';
import type { NormalizedMessage } from '../utils/email';

let n = 0;
const stamp = () => ({ id: `doc-${++n}`, createdAt: '2026-06-24' });
const msg = (subject: string, from = 'EverOut <hi@everout.com>', snippet = 'VegFest is Saturday at the Seattle Center.'): NormalizedMessage =>
  ({ from, subject, snippet });

describe('buildNewsletterQuery', () => {
  it('scopes to recent bulk/promotional mail with an unsubscribe link', () => {
    const q = buildNewsletterQuery(14);
    expect(q).toMatch(/newer_than:14d/);
    expect(q).toMatch(/unsubscribe/);
    expect(q).toMatch(/category:promotions/);
  });
});

describe('buildNewsletterClassifyPrompt', () => {
  it('asks for an index+keep+title+summary verdict per email, with the local-content rule', () => {
    const p = buildNewsletterClassifyPrompt([msg('VegFest'), msg('50% off sneakers', 'Shoes <promo@shoes.com>', 'Flash sale ends tonight.')]);
    expect(p).toMatch(/"index"/);          // the model must echo the 1-based email number for safe re-join
    expect(p).toMatch(/"keep"/);
    expect(p).toMatch(/local/i);
    expect(p).toMatch(/never reorder or merge/i);
    // both emails are embedded (numbered "Email N") for the model to judge
    expect(p).toMatch(/--- Email 1 ---/);
    expect(p).toMatch(/VegFest/);
    expect(p).toMatch(/sneakers/);
  });
});

describe('newsletterToDoc', () => {
  it('maps a newsletter email into a Library doc in the Newsletters folder', () => {
    const doc = newsletterToDoc(msg('Eastside Weekend Guide'), stamp)!;
    expect(doc.folder).toBe(NEWSLETTER_FOLDER);
    expect(doc.name).toBe('Eastside Weekend Guide');
    expect(doc.text).toMatch(/VegFest is Saturday/);
    expect(doc.id).toMatch(/^doc-/);
  });
  it('drops a subjectless email', () => {
    expect(newsletterToDoc(msg('   '), stamp)).toBeNull();
  });
});

describe('mergeNewsletterDocs', () => {
  it('adds new newsletters and dedupes by subject within the Newsletters folder', () => {
    const existing: LibraryDoc[] = [{ id: 'd0', folder: NEWSLETTER_FOLDER, name: 'Eastside Weekend Guide', text: 'old' }];
    const out = mergeNewsletterDocs(existing, [
      msg('Eastside Weekend Guide'),  // dup → skip
      msg('ParentMap This Week'),     // new
    ], stamp);
    expect(out.filter(d => d.folder === NEWSLETTER_FOLDER).map(d => d.name).sort())
      .toEqual(['Eastside Weekend Guide', 'ParentMap This Week']);
  });

  it("leaves the user's own (non-newsletter) docs untouched", () => {
    const existing: LibraryDoc[] = [{ id: 'u1', folder: 'School', name: 'Band calendar', text: '...' }];
    const out = mergeNewsletterDocs(existing, [msg('City Updates')], stamp);
    expect(out.find(d => d.folder === 'School')).toBeTruthy();
    expect(out.find(d => d.folder === NEWSLETTER_FOLDER)?.name).toBe('City Updates');
  });

  it('returns the same list when nothing new arrives', () => {
    const existing: LibraryDoc[] = [{ id: 'd0', folder: NEWSLETTER_FOLDER, name: 'X', text: 'x' }];
    expect(mergeNewsletterDocs(existing, [msg('X')], stamp)).toBe(existing);
  });
});
