import { describe, it, expect } from 'vitest';
import {
  keyTerms,
  hardTokens,
  cleanMarkdown,
  scoreSentence,
  bestSnippet,
  summarize,
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
    expect(out.join(' ')).toMatch(/Argentina/);
    expect(out.join(' ')).not.toMatch(/gardening/);
  });

  it('de-duplicates repeated sentences', () => {
    const out = summarize(citations, 'Who won the 2022 FIFA World Cup?', 10);
    const unique = new Set(out);
    expect(unique.size).toBe(out.length);
  });

  it('grounds on full read text (citation.text), not passage alone', () => {
    // Anonymous tier: no passages, only text. summarize must still work.
    const noPassage: Citation[] = [{
      rank: 1, title: 'Src', canonicalUrl: 'https://x.com', docId: 'd1',
      text: 'Argentina won the 2022 FIFA World Cup in Qatar. '.repeat(6),
    }];
    const out = summarize(noPassage, 'Who won the 2022 World Cup?', 2);
    expect(out.join(' ')).toMatch(/Argentina/);
  });

  it('returns empty array when no sentence addresses the question', () => {
    const out = summarize([citations[2]], 'Who won the 2022 FIFA World Cup?', 4);
    expect(out).toEqual([]);
  });
});

describe('formatSources', () => {
  const citations: Citation[] = [
    { rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1', captureTime: '2026-06-21T14:03:00Z' },
    { rank: 2, title: '', canonicalUrl: 'https://bbc.com/b', docId: 'd2' },
  ];

  it('numbers sources from 1 and carries title/url/captured time', () => {
    const lines = formatSources(citations);
    expect(lines[0]).toEqual({ index: 1, title: 'AP News', url: 'https://ap.com/a', capturedISO: '2026-06-21T14:03:00Z' });
  });

  it('falls back to URL when title is empty, and capturedISO is undefined when absent', () => {
    const lines = formatSources(citations);
    expect(lines[1].title).toBe('https://bbc.com/b');
    expect(lines[1].capturedISO).toBeUndefined();
  });
});
