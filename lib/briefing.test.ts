import { describe, it, expect, beforeAll } from 'vitest';
import { renderBriefing, wrap } from './briefing.js';
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
    expect(out).toContain('Powered by Caesar search — free, no signup.');
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
  });
});

describe('wrap', () => {
  it('breaks text at the given width without dropping words', () => {
    const lines = wrap('alpha beta gamma delta', 12);
    expect(lines.join(' ')).toBe('alpha beta gamma delta');
    expect(lines.every((l) => l.length <= 16)).toBe(true);
  });
});
