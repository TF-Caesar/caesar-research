import { describe, it, expect, vi, afterEach } from 'vitest';
// Importing the module must NOT start the CLI: cli.ts guards main() behind an
// invoked-as-script check, so this import is side-effect free.
import { parseArgs, main, UsageError } from './cli.js';

afterEach(() => { vi.restoreAllMocks(); });

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

  it('parses --no-llm and help flags', () => {
    expect(parseArgs(['--no-llm', 'q']).noLlm).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('rejects unknown flags instead of folding them into the question', () => {
    expect(() => parseArgs(['--max-result', '5', 'q'])).toThrow(UsageError);
    expect(() => parseArgs(['--bogus=1', 'q'])).toThrow(/Unknown flag: --bogus/);
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
});
