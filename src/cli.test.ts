import { describe, it, expect, vi, afterEach } from 'vitest';

// Stub the Caesar client so main() tests never touch the network. The real
// classifyCaesarError is kept so main's error branching is exercised for real.
const { searchAndReadMock } = vi.hoisted(() => ({ searchAndReadMock: vi.fn() }));
vi.mock('../lib/caesar.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/caesar.js')>();
  return {
    ...actual,
    createCaesarClient: () => ({ keyed: true, searchAndRead: searchAndReadMock }),
  };
});

// Importing the module must NOT start the CLI: cli.ts guards main() behind an
// invoked-as-script check, so this import is side-effect free.
import { parseArgs, main, UsageError } from './cli.js';

afterEach(() => {
  vi.restoreAllMocks();
  searchAndReadMock.mockReset();
});

describe('parseArgs', () => {
  it('joins bare tokens into the question and applies defaults', () => {
    const args = parseArgs(['who', 'won', 'the', '2022', 'world', 'cup']);
    expect(args.question).toBe('who won the 2022 world cup');
    expect(args).toMatchObject({ help: false, maxResults: 10, readTopN: 4, noLlm: false });
  });

  it('accepts --flag value syntax', () => {
    const args = parseArgs(['--max-results', '5', '--read-top', '2', 'question']);
    expect(args.maxResults).toBe(5);
    expect(args.readTopN).toBe(2);
    expect(args.question).toBe('question');
  });

  it('accepts --flag=value syntax without polluting the question', () => {
    const args = parseArgs(['--max-results=5', '--read-top=2', 'question']);
    expect(args.maxResults).toBe(5);
    expect(args.readTopN).toBe(2);
    expect(args.question).toBe('question');
  });

  it('passes --domains through as an includeDomains list (both syntaxes)', () => {
    expect(parseArgs(['--domains', 'reuters.com,apnews.com', 'q']).domains).toEqual(['reuters.com', 'apnews.com']);
    expect(parseArgs(['--domains=reuters.com, apnews.com', 'q']).domains).toEqual(['reuters.com', 'apnews.com']);
  });

  it('passes --after through as publishedAfter (both syntaxes)', () => {
    expect(parseArgs(['--after', '2026-01-01', 'q']).after).toBe('2026-01-01');
    expect(parseArgs(['--after=2026-01-01', 'q']).after).toBe('2026-01-01');
  });

  it('passes --queries through as a trimmed rewrite list (both syntaxes)', () => {
    expect(parseArgs(['--queries', 'rewrite one,rewrite two', 'q']).queries).toEqual(['rewrite one', 'rewrite two']);
    expect(parseArgs(['--queries=rewrite one, rewrite two', 'q']).queries).toEqual(['rewrite one', 'rewrite two']);
    expect(parseArgs(['q']).queries).toBeUndefined();
  });

  it('rejects --queries with an empty or missing value', () => {
    expect(() => parseArgs(['--queries=', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--queries=,', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--queries', ' , ', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['q', '--queries'])).toThrow(/expects a value/);
  });

  it('parses --no-llm and help flags', () => {
    expect(parseArgs(['--no-llm', 'q']).noLlm).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('parses --json as a bare flag and rejects a value', () => {
    expect(parseArgs(['--json', 'q']).json).toBe(true);
    expect(parseArgs(['q']).json).toBe(false);
    expect(() => parseArgs(['--json=1', 'q'])).toThrow(UsageError);
  });

  it('rejects unknown flags instead of folding them into the question', () => {
    expect(() => parseArgs(['--max-result', '5', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--bogus=1', 'q'])).toThrow(/Unknown flag: --bogus/);
  });

  it('rejects single-dash flag typos instead of folding them into the question', () => {
    expect(() => parseArgs(['-max-results', '5', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['-domains=x.com', 'q'])).toThrow(/Unknown flag: -domains/);
    expect(() => parseArgs(['-no-llm', 'q'])).toThrow(UsageError);
  });

  it('still lets negative-number tokens join the question', () => {
    expect(parseArgs(['what', 'is', '-273.15', 'celsius']).question).toBe('what is -273.15 celsius');
  });

  it('rejects NaN and non-positive numeric values', () => {
    expect(() => parseArgs(['--max-results', 'abc'])).toThrow(UsageError);
    expect(() => parseArgs(['--max-results=0'])).toThrow(UsageError);
    expect(() => parseArgs(['--read-top', '-3'])).toThrow(UsageError);
    expect(() => parseArgs(['--read-top=1.5'])).toThrow(UsageError);
  });

  it('rejects a flag with a missing or empty value', () => {
    expect(() => parseArgs(['q', '--max-results'])).toThrow(/expects a value/);
    expect(() => parseArgs(['--domains=,', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--after=', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--no-llm=true', 'q'])).toThrow(UsageError);
  });
});

describe('main', () => {
  it('returns 2 and prints usage to stderr on a bad flag, without searching', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(['--max-results=nope', 'q']);
    expect(code).toBe(2);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('positive integer');
  });

  it('returns 0 and prints help for --help', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('caesar-research');
  });

  it('returns 1 when no question is given', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main([])).toBe(1);
  });

  it('explains when results were found but none survived the score floor or reads', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // Caesar found 7 results, but minScore filtered or throttled reads dropped
    // them all — without the hint this is indistinguishable from an empty web.
    searchAndReadMock.mockResolvedValue({ searchId: 's', citations: [], resultCount: 7 });

    const code = await main(['--no-llm', 'some question']);

    expect(code).toBe(0);
    const err = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('found 7');
    expect(err).toMatch(/score floor|could not be read/);
  });

  it('--json emits exactly one parseable JSON object on stdout, ANSI-free, with the exact keys', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdoutWrites.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    searchAndReadMock.mockResolvedValue({
      searchId: 's',
      resultCount: 3,
      citations: [{
        rank: 1, title: 'AP News', canonicalUrl: 'https://ap.com/a', docId: 'd1',
        captureTime: '2026-07-01T00:00:00Z',
        text: 'Argentina won the 2022 FIFA World Cup, defeating France on penalties. '.repeat(4),
      }],
    });

    const code = await main(['--json', '--no-llm', 'who won the 2022 FIFA World Cup']);

    expect(code).toBe(0);
    // ALL of stdout must be the JSON object: progress stays on stderr, and a
    // stray colored line would break every `caesar-research --json | jq` pipe.
    const stdout = stdoutWrites.join('');
    expect(stdout).not.toMatch(/\x1b\[/);
    const payload = JSON.parse(stdout);
    expect(Object.keys(payload).sort()).toEqual(['narrative', 'question', 'resultCount', 'sources', 'summary', 'tier']);
    expect(payload.question).toBe('who won the 2022 FIFA World Cup');
    expect(payload.resultCount).toBe(3);
    expect(payload.tier).toBe('keyed');
    expect(payload.narrative).toBeNull();
    expect(payload.summary.length).toBeGreaterThan(0);
    expect(payload.summary[0]).toMatchObject({ sourceIndex: 1 });
    expect(payload.summary[0].text).toMatch(/Argentina/);
    expect(payload.sources[0]).toMatchObject({ index: 1, url: 'https://ap.com/a' });
  });

  it('sends --queries rewrites to Caesar as searchQueries, keeping the question as the query', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    searchAndReadMock.mockResolvedValue({ searchId: 's', citations: [], resultCount: 0 });

    const code = await main(['--no-llm', '--queries', '2022 world cup winner,fifa 2022 final', 'who won the 2022 world cup']);

    expect(code).toBe(0);
    // The question stays the query (it drives reranking and passage selection);
    // the rewrites ride along as searchQueries for the index.
    expect(searchAndReadMock).toHaveBeenCalledWith(
      'who won the 2022 world cup',
      expect.objectContaining({ searchQueries: ['2022 world cup winner', 'fifa 2022 final'] }),
    );
  });

  it('omits searchQueries entirely when --queries is not given', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    searchAndReadMock.mockResolvedValue({ searchId: 's', citations: [], resultCount: 0 });

    await main(['--no-llm', 'some question']);

    expect(searchAndReadMock.mock.calls[0][1]).not.toHaveProperty('searchQueries');
  });

  it('--json sources carry passage section and offsets when pinned, omit them when absent', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdoutWrites.push(String(chunk)); return true; });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    searchAndReadMock.mockResolvedValue({
      searchId: 's',
      resultCount: 2,
      citations: [
        {
          rank: 1, title: 'Docs', canonicalUrl: 'https://x.com/pricing', docId: 'd1',
          captureTime: '2026-07-01T00:00:00Z', text: 'The Pro plan costs $49 per month, billed annually. '.repeat(4),
          passageSection: 'Pricing', passageStart: 1204, passageEnd: 1377,
        },
        {
          rank: 2, title: 'Blog', canonicalUrl: 'https://y.com/post', docId: 'd2',
          captureTime: '2026-07-01T00:00:00Z', text: 'A first-ever capture: no offsets yet. '.repeat(6),
        },
      ],
    });

    const code = await main(['--json', '--no-llm', 'pro plan price']);

    expect(code).toBe(0);
    const payload = JSON.parse(stdoutWrites.join(''));
    expect(payload.sources[0]).toMatchObject({
      index: 1, passageSection: 'Pricing', passageStart: 1204, passageEnd: 1377,
    });
    // Best-effort fields stay absent, not null, so the JSON stays clean.
    expect(payload.sources[1]).not.toHaveProperty('passageSection');
    expect(payload.sources[1]).not.toHaveProperty('passageStart');
    expect(payload.sources[1]).not.toHaveProperty('passageEnd');
  });

  it('prints one actionable line and returns 1 when no key is configured', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // The shape an unconfigured client throws on its first call.
    searchAndReadMock.mockRejectedValue(Object.assign(
      new Error('Caesar API key not configured: set CAESAR_SEARCH_API_KEY (or CAESAR_API_KEY)'),
      { code: 'missing_api_key' },
    ));

    const code = await main(['some question']);

    expect(code).toBe(1);
    const err = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('CAESAR_SEARCH_API_KEY');
    expect(err).toContain('$1,000');
    expect(err).toContain('https://trycaesar.com');
    expect(err).not.toContain('    at '); // one line, no stack trace
  });

  it('returns 2 with a retry hint when Caesar throttles the request', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    searchAndReadMock.mockRejectedValue(Object.assign(new Error('too many requests'), { statusCode: 429 }));

    const code = await main(['some question']);

    expect(code).toBe(2);
    const err = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(err).toContain('Try again shortly');
  });

  it('prints no filter hint when sources were actually read', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    searchAndReadMock.mockResolvedValue({
      searchId: 's',
      citations: [{ rank: 1, title: 'T', canonicalUrl: 'https://x', text: 'A grounded read body.', captureTime: '2026-07-01T00:00:00Z' }],
      resultCount: 3,
    });

    const code = await main(['--no-llm', 'some question']);

    expect(code).toBe(0);
    const err = stderr.mock.calls.map((c) => String(c[0])).join('');
    expect(err).not.toMatch(/score floor/);
  });
});
