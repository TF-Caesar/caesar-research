import { describe, it, expect } from 'vitest';
import {
  keyTerms,
  hardTokens,
  cleanMarkdown,
  scoreSentence,
  bestSnippet,
  summarize,
  citationBody,
  readCitations,
  formatSources,
} from './research.js';
import type { Citation } from './caesar.js';

describe('keyTerms', () => {
  it('drops stopwords and short tokens, lowercases', () => {
    expect(keyTerms('Who won the 2022 FIFA World Cup?')).toEqual(['won', '2022', 'fifa', 'world', 'cup']);
  });
});

describe('hardTokens', () => {
  it('captures numbers and ALL-CAPS acronyms', () => {
    expect(hardTokens('GDP grew 3.5% per NATO report')).toEqual(['3.5%', 'GDP', 'NATO']);
  });
});

describe('cleanMarkdown', () => {
  it('strips links, marks, headings, bullets', () => {
    expect(cleanMarkdown('## **Bold** [link](http://x) text')).toBe('Bold link text');
    expect(cleanMarkdown('- a *bullet* item')).toBe('a bullet item');
  });
});

describe('scoreSentence', () => {
  const terms = keyTerms('Argentina won the 2022 World Cup');
  const hards = hardTokens('Argentina won the 2022 World Cup');
  it('rewards term overlap and weights hard tokens', () => {
    const withHard = scoreSentence('Argentina won the 2022 World Cup final', terms, hards);
    const withoutHard = scoreSentence('Argentina won the World Cup final', terms, hards);
    expect(withHard).toBeGreaterThan(withoutHard);
    expect(withHard - withoutHard).toBeGreaterThanOrEqual(3); // hard-token bonus
  });
  it('scores zero for an unrelated sentence', () => {
    expect(scoreSentence('The weather is mild today.', terms, hards)).toBe(0);
  });
});

describe('bestSnippet', () => {
  it('extracts the single most relevant sentence, cleaned', () => {
    const text =
      'Some intro paragraph about football history.\n' +
      '## **Argentina** won the 2022 FIFA World Cup, beating France on penalties.\n' +
      'The stadium was in Qatar.';
    const snip = bestSnippet(text, 'Who won the 2022 FIFA World Cup?');
    expect(snip).toBe('Argentina won the 2022 FIFA World Cup, beating France on penalties.');
  });
  it('returns undefined when nothing matches', () => {
    expect(bestSnippet('Completely unrelated content here for testing.', 'quantum chromodynamics gluons')).toBeUndefined();
  });
  it('truncates very long sentences with an ellipsis', () => {
    // A single sentence ~320 chars (under the 400 split filter, over maxLen 280).
    const long = 'Argentina 2022 ' + 'detail word '.repeat(25).trim();
    expect(long.length).toBeGreaterThan(280);
    expect(long.length).toBeLessThan(400);
    const snip = bestSnippet(long, 'Argentina 2022', 280)!;
    expect(snip.length).toBeLessThanOrEqual(281);
    expect(snip.endsWith('…')).toBe(true);
  });
});

describe('summarize', () => {
  const citations: Citation[] = [
    {
      rank: 1, title: 'AP', canonicalUrl: 'https://ap.com/a', docId: 'd1',
      text: 'Argentina won the 2022 FIFA World Cup, defeating France in a penalty shootout. '.repeat(4),
    },
    {
      rank: 2, title: 'BBC', canonicalUrl: 'https://bbc.com/b', docId: 'd2',
      text: 'Lionel Messi lifted the 2022 World Cup trophy for Argentina. The final went to penalties. '.repeat(4),
    },
    {
      rank: 3, title: 'Noise', canonicalUrl: 'https://noise.com/c', docId: 'd3',
      text: 'This page is about gardening and has nothing to do with football at all whatsoever. '.repeat(4),
    },
  ];

  it('extracts relevant sentences across multiple sources, drops noise', () => {
    const out = summarize(citations, 'Who won the 2022 FIFA World Cup?', 4);
    expect(out.length).toBeGreaterThan(0);
    expect(out.map((s) => s.text).join(' ')).toMatch(/Argentina/);
    expect(out.map((s) => s.text).join(' ')).not.toMatch(/gardening/);
  });

  it('de-duplicates repeated sentences', () => {
    const out = summarize(citations, 'Who won the 2022 FIFA World Cup?', 10);
    const unique = new Set(out.map((s) => s.text));
    expect(unique.size).toBe(out.length);
  });

  it('stamps each item with the 1-based read-list index of its origin citation', () => {
    // The unread hit sits FIRST so raw rank and read-list position diverge:
    // formatSources drops it and renumbers, and sourceIndex must agree.
    const unread: Citation = { rank: 1, title: 'Never read', canonicalUrl: 'https://never.com', docId: 'd0' };
    const out = summarize([unread, ...citations], 'Who won the 2022 FIFA World Cup?', 10);
    const fromAp = out.find((s) => /defeating France/.test(s.text));
    const fromBbc = out.find((s) => /Messi/.test(s.text));
    expect(fromAp?.sourceIndex).toBe(1);
    expect(fromBbc?.sourceIndex).toBe(2);
  });

  it('never cites a search-only citation: a passage on an unread hit yields no bullet', () => {
    // No captureTime and no text means the source never appears in the Sources
    // list, so a bullet extracted from it would carry a dangling [n].
    const passageOnly: Citation[] = [{
      rank: 1, title: 'Unread', canonicalUrl: 'https://unread.com', docId: 'd1',
      passage: 'Argentina won the 2022 FIFA World Cup in Qatar after beating France on penalties.',
    }];
    expect(summarize(passageOnly, 'Who won the 2022 FIFA World Cup?', 4)).toEqual([]);
  });

  it('drops JSON / metadata fragments so they never become a summary bullet', () => {
    // The JSON sits on its own line AND echoes query terms, so it would otherwise
    // out-score real prose and surface as a bullet.
    const withJson: Citation[] = [{
      rank: 1, title: 'X', canonicalUrl: 'https://x.com', docId: 'd1',
      text: 'Argentina won the 2022 FIFA World Cup in Qatar after a dramatic final.\n{"event":"2022 FIFA World Cup","winner":"Argentina","fifa_world_cup":true,"id":"abc-123"}\nLionel Messi lifted the trophy for Argentina national team. '.repeat(2),
    }];
    const out = summarize(withJson, 'Who won the 2022 FIFA World Cup?', 5);
    expect(out.map((s) => s.text).join(' ')).toMatch(/Argentina/);
    expect(out.map((s) => s.text).join(' ')).not.toMatch(/\{|\}|fifa_world_cup|"winner"/);
  });

  it('grounds on full read text (citation.text), not passage alone', () => {
    // Some reads return no passages, only text. summarize must still work.
    const noPassage: Citation[] = [{
      rank: 1, title: 'Src', canonicalUrl: 'https://x.com', docId: 'd1',
      text: 'Argentina won the 2022 FIFA World Cup in Qatar. '.repeat(6),
    }];
    const out = summarize(noPassage, 'Who won the 2022 World Cup?', 2);
    expect(out.map((s) => s.text).join(' ')).toMatch(/Argentina/);
  });

  it('returns empty array when no sentence addresses the question', () => {
    const out = summarize([citations[2]], 'Who won the 2022 FIFA World Cup?', 4);
    expect(out).toEqual([]);
  });

  it('still counts a short-but-real read (text of 200 chars or less, no passage)', () => {
    const short: Citation[] = [{
      rank: 1, title: 'Short', canonicalUrl: 'https://short.com/a', docId: 'd1',
      text: 'Argentina won the 2022 FIFA World Cup in Qatar after beating France.',
    }];
    const out = summarize(short, 'Who won the 2022 FIFA World Cup?', 2);
    expect(out.map((s) => s.text).join(' ')).toMatch(/Argentina/);
    expect(out[0].sourceIndex).toBe(1);
  });
});

describe('citationBody', () => {
  const base = { rank: 1, title: 'T', canonicalUrl: 'https://x.com', docId: 'd1' };
  it('prefers substantial full text over the passage', () => {
    const long = 'Long full text. '.repeat(20);
    expect(citationBody({ ...base, text: long, passage: 'passage' })).toBe(long);
  });
  it('falls back to the passage when text is short', () => {
    expect(citationBody({ ...base, text: 'short', passage: 'passage' })).toBe('passage');
  });
  it('falls back to the short text itself when there is no passage', () => {
    expect(citationBody({ ...base, text: 'short but real' })).toBe('short but real');
  });
  it('returns empty string when the citation has nothing', () => {
    expect(citationBody(base)).toBe('');
  });
});

describe('readCitations', () => {
  it('keeps read citations in order and drops search-only ones', () => {
    const read: Citation = { rank: 1, title: 'A', canonicalUrl: 'https://a.com', docId: 'd1', captureTime: '2026-06-21T14:03:00Z' };
    const unread: Citation = { rank: 2, title: 'B', canonicalUrl: 'https://b.com', docId: 'd2' };
    const readText: Citation = { rank: 3, title: 'C', canonicalUrl: 'https://c.com', docId: 'd3', text: 'body' };
    expect(readCitations([read, unread, readText]).map((c) => c.rank)).toEqual([1, 3]);
  });
});

describe('formatSources', () => {
  // A source is "read" if it carries read provenance (captureTime) or read text.
  const read1: Citation = { rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1', captureTime: '2026-06-21T14:03:00Z' };
  const readNoTime: Citation = { rank: 2, title: '', canonicalUrl: 'https://bbc.com/b', docId: 'd2', text: 'Argentina won the 2022 World Cup in Qatar.' };
  const unread: Citation = { rank: 3, title: 'Never read', canonicalUrl: 'https://never.com/c', docId: 'd3' };

  it('numbers sources from 1 and carries title/url/captured time', () => {
    expect(formatSources([read1])[0]).toEqual({ index: 1, title: 'AP News', url: 'https://ap.com/a', capturedISO: '2026-06-21T14:03:00Z' });
  });

  it('falls back to URL when title is empty; capturedISO is undefined when the read had no timestamp', () => {
    const lines = formatSources([read1, readNoTime]);
    expect(lines[1].title).toBe('https://bbc.com/b');
    expect(lines[1].capturedISO).toBeUndefined();
  });

  it('omits search-only results that were never read (no capture, no text)', () => {
    const lines = formatSources([read1, unread]);
    expect(lines).toHaveLength(1);
    expect(lines.some((l) => l.url === 'https://never.com/c')).toBe(false);
  });

  it('renumbers from 1 after dropping unread results', () => {
    const lines = formatSources([unread, read1]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ index: 1, url: 'https://ap.com/a' });
  });

  it('carries publishedAt when the citation has one, leaves it undefined otherwise', () => {
    const published: Citation = { ...read1, publishedAt: '2026-06-20T08:00:00Z' };
    const lines = formatSources([published, readNoTime]);
    expect(lines[0].publishedAt).toBe('2026-06-20T08:00:00Z');
    expect(lines[1].publishedAt).toBeUndefined();
  });

  it('carries the passage section and char offsets when the citation pins them', () => {
    const pinned: Citation = { ...read1, passageSection: 'Pricing', passageStart: 1204, passageEnd: 1377 };
    const lines = formatSources([pinned]);
    expect(lines[0]).toMatchObject({ passageSection: 'Pricing', passageStart: 1204, passageEnd: 1377 });
  });

  it('leaves section and offsets undefined when absent (first-ever capture, or snippet-grade)', () => {
    const lines = formatSources([read1, readNoTime]);
    expect(lines[0].passageSection).toBeUndefined();
    expect(lines[0].passageStart).toBeUndefined();
    expect(lines[0].passageEnd).toBeUndefined();
    expect(lines[1].passageEnd).toBeUndefined();
  });
});
