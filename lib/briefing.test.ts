import { describe, it, expect, beforeAll } from 'vitest';
import { renderBriefing, wrap, relativeTime, receiptLine } from './briefing.js';
import type { Citation } from './caesar.js';

// Force picocolors off so we assert plain text, not ANSI codes.
beforeAll(() => { process.env.NO_COLOR = '1'; });

const citations: Citation[] = [
  {
    rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1',
    captureTime: '2026-06-21T14:03:00Z',
    text: 'Argentina won the 2022 FIFA World Cup, defeating France on penalties. '.repeat(4),
  },
  {
    rank: 2, title: 'BBC', canonicalUrl: 'https://bbc.com/b', docId: 'd2',
    // no captureTime — should render the unavailable note
    text: 'Messi lifted the 2022 World Cup trophy for Argentina in Qatar. '.repeat(4),
  },
];

describe('renderBriefing', () => {
  it('renders question, deterministic summary, and a numbered Sources list', () => {
    const out = renderBriefing({ question: 'Who won the 2022 FIFA World Cup?', citations });
    expect(out).toContain('Question');
    expect(out).toContain('Who won the 2022 FIFA World Cup?');
    expect(out).toContain('Summary');
    expect(out).toMatch(/Argentina/);
    expect(out).toContain('[1] AP News');
    expect(out).toContain('https://ap.com/a');
    expect(out).toContain('captured 2026-06-21T14:03:00Z');
    expect(out).toContain('[2] BBC');
    expect(out).toContain('captured (time unavailable)');
    expect(out).toContain('Powered by Caesar search: https://trycaesar.com');
  });

  it('suffixes each deterministic bullet with the [n] of its origin source', () => {
    const out = renderBriefing({ question: 'Who won the 2022 FIFA World Cup?', citations });
    // The AP sentence came from read source 1, the BBC sentence from source 2:
    // the inline [n] must match the numbering of the Sources list below it.
    expect(out).toMatch(/defeating France on penalties\.\s+\[1\]/);
    expect(out).toMatch(/for Argentina in Qatar\.\s+\[2\]/);
  });

  it('uses the synthesized narrative when provided, replacing the Summary block', () => {
    const out = renderBriefing({
      question: 'Who won?',
      citations,
      narrative: 'Argentina won the 2022 World Cup [1].',
    });
    expect(out).toContain('Answer');
    expect(out).toContain('Argentina won the 2022 World Cup [1].');
    expect(out).not.toContain('Summary');
  });

  it('handles zero sources gracefully', () => {
    const out = renderBriefing({ question: 'Anything?', citations: [] });
    expect(out).toContain('No sources were read.');
    expect(out).not.toContain('sources read'); // no receipt line without sources
  });

  it('shows "published <date> · captured <time>" when the citation carries publishedAt', () => {
    const withPublished: Citation[] = [
      {
        rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1',
        captureTime: '2026-06-21T14:03:00Z', publishedAt: '2026-06-20T08:00:00Z',
        text: 'Argentina won the 2022 FIFA World Cup, defeating France on penalties. '.repeat(4),
      },
    ];
    const out = renderBriefing({ question: 'Who won?', citations: withPublished });
    expect(out).toContain('published 2026-06-20 · captured 2026-06-21T14:03:00Z');
  });

  it('keeps the captured-only stamp when publishedAt is absent', () => {
    const out = renderBriefing({ question: 'Who won the 2022 FIFA World Cup?', citations });
    expect(out).toContain('captured 2026-06-21T14:03:00Z');
    expect(out).not.toContain('published ');
  });

  it('renders the receipt stat line from real capture times', () => {
    const now = Date.parse('2026-06-23T14:03:00Z');
    const out = renderBriefing({ question: 'Who won?', citations, now });
    expect(out).toContain('2 sources read · newest capture 2d ago');
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');

  it('renders minutes, hours, and days ago; sub-minute is "just now"', () => {
    expect(relativeTime('2026-07-02T11:58:00Z', now)).toBe('2m ago');
    expect(relativeTime('2026-07-02T09:00:00Z', now)).toBe('3h ago');
    expect(relativeTime('2026-06-29T12:00:00Z', now)).toBe('3d ago');
    expect(relativeTime('2026-07-02T11:59:30Z', now)).toBe('just now');
  });

  it('returns undefined for unparseable input (a stamp never fabricates a time)', () => {
    expect(relativeTime('not-a-date', now)).toBeUndefined();
  });
});

describe('receiptLine', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');

  it('uses the singular for one source', () => {
    expect(receiptLine([{ capturedISO: '2026-07-02T11:58:00Z' }], now)).toBe('1 source read · newest capture 2m ago');
  });

  it('omits the newest-capture clause when no capture time parses (never fabricates)', () => {
    expect(receiptLine([{}, { capturedISO: 'garbage' }], now)).toBe('2 sources read');
  });

  it('returns undefined when nothing was read', () => {
    expect(receiptLine([], now)).toBeUndefined();
  });
});

describe('wrap', () => {
  it('breaks text at the given width without dropping words', () => {
    const lines = wrap('alpha beta gamma delta', 12);
    expect(lines.join(' ')).toBe('alpha beta gamma delta');
    expect(lines.every((l) => l.length <= 16)).toBe(true);
  });
});
