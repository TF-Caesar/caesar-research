import { describe, it, expect, vi, afterEach } from 'vitest';
import { synthesize } from './synthesize.js';
import { formatSources } from './research.js';
import type { Citation } from './caesar.js';

/** fetch stub that captures the prompt sent to the model and returns a canned answer. */
function captureFetch(captured: { prompt?: string }): typeof fetch {
  return (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    captured.prompt = body.messages[0].content;
    return {
      ok: true,
      json: async () => ({ content: [{ text: 'Grounded answer [1][2].' }] }),
    };
  }) as unknown as typeof fetch;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe('synthesize evidence numbering', () => {
  // Rank 2's read FAILED (no text, no passage, no captureTime): it must be
  // dropped from evidence AND from Sources, and the display indices the model
  // is told to cite must match formatSources exactly.
  const citations: Citation[] = [
    {
      rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1',
      captureTime: '2026-06-21T14:03:00Z',
      text: 'Argentina won the 2022 FIFA World Cup, defeating France on penalties. '.repeat(4),
    },
    { rank: 2, title: 'Failed read', canonicalUrl: 'https://failed.com/b', docId: 'd2' },
    {
      rank: 3, title: 'Reuters', canonicalUrl: 'https://reuters.com/c', docId: 'd3',
      captureTime: '2026-06-21T14:04:00Z',
      text: 'Lionel Messi lifted the World Cup trophy for Argentina in Qatar. '.repeat(4),
    },
  ];

  it('labels evidence blocks with display indices that agree with formatSources when a read failed', async () => {
    const captured: { prompt?: string } = {};
    const narrative = await synthesize('Who won the 2022 FIFA World Cup?', citations, {
      apiKey: 'test-key',
      fetchImpl: captureFetch(captured),
    });
    expect(narrative).toBe('Grounded answer [1][2].');

    // The model sees [1] AP and [2] Reuters (rank 3 renumbered to 2)...
    expect(captured.prompt).toContain('[1] AP News (https://ap.com/a)');
    expect(captured.prompt).toContain('[2] Reuters (https://reuters.com/c)');
    expect(captured.prompt).not.toContain('[3]');
    expect(captured.prompt).not.toContain('https://failed.com/b');

    // ...and the rendered Sources list assigns the exact same numbers.
    const sources = formatSources(citations);
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ index: 1, url: 'https://ap.com/a' });
    expect(sources[1]).toMatchObject({ index: 2, url: 'https://reuters.com/c' });
  });

  it('includes short-but-real read text (200 chars or less, no passage) as evidence', async () => {
    const short: Citation[] = [{
      rank: 1, title: 'Short', canonicalUrl: 'https://short.com/a', docId: 'd1',
      captureTime: '2026-06-21T14:03:00Z',
      text: 'Argentina won the 2022 FIFA World Cup in Qatar.',
    }];
    const captured: { prompt?: string } = {};
    const narrative = await synthesize('Who won the 2022 World Cup?', short, {
      apiKey: 'test-key',
      fetchImpl: captureFetch(captured),
    });
    expect(narrative).not.toBeNull();
    expect(captured.prompt).toContain('Argentina won the 2022 FIFA World Cup in Qatar.');
  });

  it('returns null without a key and never calls fetch', async () => {
    vi.stubEnv('CAESAR_RESEARCH_LLM_KEY', '');
    const fetchImpl = vi.fn();
    const out = await synthesize('q', citations, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
