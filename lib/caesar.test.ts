import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const searchMock = vi.fn();
const readMock = vi.fn();
vi.mock('caesar-search', () => ({
  // Mirror caesar-search 0.2.0: construction THROWS when no key is configured
  // (the public API is keyed-only), so the unconfigured path stays testable.
  Caesar: vi.fn().mockImplementation((opts: { apiKey?: string } = {}) => {
    if (!opts.apiKey) throw Object.assign(new Error('Missing API key'), { code: 'missing_api_key' });
    return { search: searchMock, read: readMock };
  }),
}));

import { CaesarClient, classifyCaesarError } from './caesar.js';

beforeEach(() => { searchMock.mockReset(); readMock.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('CaesarClient.searchAndRead (SDK mocked, no network)', () => {
  it('grounds citations on full read text even when passages are absent', async () => {
    searchMock.mockResolvedValue({
      search_id: 's1',
      results: [{ rank: 1, title: 'AP', canonical_url: 'https://ap.com/a', doc_id: 'd1', snippet: 'snip' }],
    });
    // Some reads return content.text with NO passages.
    readMock.mockResolvedValue({
      doc: { doc_id: 'd1', canonical_url: 'https://ap.com/a' },
      content: { text: 'Argentina won the 2022 FIFA World Cup. '.repeat(10) },
      passages: [],
      provenance: { capture_id: 'cap1', capture_time: '2026-06-21T14:03:00Z' },
    });
    const r = await new CaesarClient({ apiKey: 'test-key' }).searchAndRead('q', { readTopN: 1 });
    expect(r.citations[0].passage).toBeUndefined();
    expect(r.citations[0].text).toContain('Argentina');
    expect(r.citations[0].captureTime).toBe('2026-06-21T14:03:00Z');
    expect(r.evidence).toContain('https://ap.com/a');
  });

  it('forwards caller query rewrites as SearchRequest.search_queries', async () => {
    searchMock.mockResolvedValue({ results: [] });
    await new CaesarClient({ apiKey: 'test-key' }).search('original question', { searchQueries: ['rewrite one', 'rewrite two'] });
    expect(searchMock).toHaveBeenCalledWith('original question', expect.objectContaining({
      extraBody: expect.objectContaining({ search_queries: ['rewrite one', 'rewrite two'] }),
    }));
  });

  it('carries passage offsets and section heading onto the citation when Caesar pins them', async () => {
    searchMock.mockResolvedValue({
      results: [{ rank: 1, title: 'Docs', canonical_url: 'https://x.com/pricing', doc_id: 'd1' }],
    });
    readMock.mockResolvedValue({
      doc: { doc_id: 'd1', canonical_url: 'https://x.com/pricing' },
      content: { text: 'Full page text about plan pricing. '.repeat(10) },
      passages: [{
        passage_id: 'p1', text: 'The Pro plan pricing is $49 per month.',
        char_start: 1204, char_end: 1377, section_heading: 'Pricing',
      }],
      provenance: { capture_id: 'cap1', capture_time: '2026-07-01T00:00:00Z' },
    });
    const r = await new CaesarClient({ apiKey: 'test-key' }).searchAndRead('plan pricing', { readTopN: 1 });
    expect(r.citations[0]).toMatchObject({
      passageId: 'p1', passageStart: 1204, passageEnd: 1377, passageSection: 'Pricing',
    });
  });

  it('leaves offsets and section absent on a first-ever capture (Caesar returns none)', async () => {
    searchMock.mockResolvedValue({
      results: [{ rank: 1, title: 'Docs', canonical_url: 'https://x.com/new', doc_id: 'd1' }],
    });
    readMock.mockResolvedValue({
      doc: { doc_id: 'd1', canonical_url: 'https://x.com/new' },
      content: { text: 'Fresh page about plan pricing. '.repeat(10) },
      passages: [{ passage_id: 'p1', text: 'The plan pricing changed today.' }],
      provenance: { capture_id: 'cap1', capture_time: '2026-07-01T00:00:00Z' },
    });
    const r = await new CaesarClient({ apiKey: 'test-key' }).searchAndRead('plan pricing', { readTopN: 1 });
    expect(r.citations[0].passageId).toBe('p1');
    expect(r.citations[0].passageStart).toBeUndefined();
    expect(r.citations[0].passageEnd).toBeUndefined();
    expect(r.citations[0].passageSection).toBeUndefined();
  });

  it('tolerates a read failure (e.g. 429) without throwing', async () => {
    searchMock.mockResolvedValue({ results: [{ rank: 1, title: 'T', canonical_url: 'https://x.com/1', doc_id: 'd1', snippet: 'snip' }] });
    readMock.mockRejectedValue(new Error('429'));
    const r = await new CaesarClient({ apiKey: 'test-key' }).searchAndRead('q', { readTopN: 1 });
    expect(r.citations[0].canonicalUrl).toBe('https://x.com/1');
    expect(r.citations[0].passage).toBeUndefined();
  });
});

describe('classifyCaesarError', () => {
  it("maps an unconfigured client's first-call error to 'not_configured'", async () => {
    // Blank both env fallbacks so the client is genuinely unconfigured.
    vi.stubEnv('CAESAR_SEARCH_API_KEY', '');
    vi.stubEnv('CAESAR_API_KEY', '');
    const client = new CaesarClient();
    expect(client.keyed).toBe(false);
    const err = await client.search('q').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('CAESAR_SEARCH_API_KEY');
    expect(classifyCaesarError(err)).toBe('not_configured');
  });

  it('maps SDK status codes to auth, balance, and rate_limited', () => {
    expect(classifyCaesarError({ statusCode: 401 })).toBe('auth');
    expect(classifyCaesarError({ statusCode: 403 })).toBe('auth');
    expect(classifyCaesarError({ statusCode: 402 })).toBe('balance');
    expect(classifyCaesarError({ statusCode: 429 })).toBe('rate_limited');
    expect(classifyCaesarError(new Error('boom'))).toBe('other');
  });
});
