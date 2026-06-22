import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMock = vi.fn();
const readMock = vi.fn();
vi.mock('caesar-search', () => ({
  Caesar: vi.fn().mockImplementation(() => ({ search: searchMock, read: readMock })),
}));

import { CaesarClient } from './caesar.js';

beforeEach(() => { searchMock.mockReset(); readMock.mockReset(); });

describe('CaesarClient.searchAndRead (SDK mocked, no network)', () => {
  it('grounds citations on full read text even when passages are absent (anonymous tier)', async () => {
    searchMock.mockResolvedValue({
      search_id: 's1',
      results: [{ rank: 1, title: 'AP', canonical_url: 'https://ap.com/a', doc_id: 'd1', snippet: 'snip' }],
    });
    // Anonymous tier: content.text present, NO passages.
    readMock.mockResolvedValue({
      doc: { doc_id: 'd1', canonical_url: 'https://ap.com/a' },
      content: { text: 'Argentina won the 2022 FIFA World Cup. '.repeat(10) },
      passages: [],
      provenance: { capture_id: 'cap1', capture_time: '2026-06-21T14:03:00Z' },
    });
    const r = await new CaesarClient().searchAndRead('q', { readTopN: 1 });
    expect(r.citations[0].passage).toBeUndefined();
    expect(r.citations[0].text).toContain('Argentina');
    expect(r.citations[0].captureTime).toBe('2026-06-21T14:03:00Z');
    expect(r.evidence).toContain('https://ap.com/a');
  });

  it('tolerates a read failure (e.g. 429) without throwing', async () => {
    searchMock.mockResolvedValue({ results: [{ rank: 1, title: 'T', canonical_url: 'https://x.com/1', doc_id: 'd1', snippet: 'snip' }] });
    readMock.mockRejectedValue(new Error('429'));
    const r = await new CaesarClient().searchAndRead('q', { readTopN: 1 });
    expect(r.citations[0].canonicalUrl).toBe('https://x.com/1');
    expect(r.citations[0].passage).toBeUndefined();
  });
});
