#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { createCaesarClient } from '../lib/caesar.js';
import { renderBriefing } from '../lib/briefing.js';
import { formatSources, readCitations, summarize } from '../lib/research.js';
import { synthesize } from '../lib/synthesize.js';

interface Args {
  question: string;
  help: boolean;
  maxResults: number;
  readTopN: number;
  noLlm: boolean;
  json: boolean;
  domains?: string[];
  after?: string;
}

/** Thrown by parseArgs on bad input; main turns it into usage + exit code 2. */
export class UsageError extends Error {}

function positiveInt(flag: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} expects a positive integer, got "${raw}"`);
  }
  return n;
}

/**
 * Tiny hand-rolled arg parser. Flags accept both "--flag value" and
 * "--flag=value"; everything else joins as the question. An unknown --flag is
 * an error, never silently folded into the question (a typo'd flag would
 * otherwise corrupt the search).
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { question: '', help: false, maxResults: 10, readTopN: 4, noLlm: false, json: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (!a.startsWith('--')) {
      // A single-dash token that looks like a flag is a typo, not part of the
      // question ("-max-results 5" would otherwise silently corrupt the
      // search). Negative numbers ("-273.15") still join the question.
      if (/^-[a-zA-Z]/.test(a)) throw new UsageError(`Unknown flag: ${a} (long flags start with --)`);
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const flag = eq === -1 ? a : a.slice(0, eq);
    const inline = eq === -1 ? undefined : a.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined) throw new UsageError(`${flag} expects a value`);
      return next;
    };
    switch (flag) {
      case '--no-llm':
        if (inline !== undefined) throw new UsageError('--no-llm does not take a value');
        args.noLlm = true;
        break;
      case '--json':
        if (inline !== undefined) throw new UsageError('--json does not take a value');
        args.json = true;
        break;
      case '--max-results':
        args.maxResults = positiveInt(flag, value());
        break;
      case '--read-top':
        args.readTopN = positiveInt(flag, value());
        break;
      case '--domains': {
        const domains = value().split(',').map((d) => d.trim()).filter(Boolean);
        if (domains.length === 0) throw new UsageError('--domains expects a comma-separated list, e.g. --domains reuters.com,apnews.com');
        args.domains = domains;
        break;
      }
      case '--after': {
        const after = value().trim();
        if (!after) throw new UsageError('--after expects a date, e.g. --after 2026-01-01');
        args.after = after;
        break;
      }
      default:
        throw new UsageError(`Unknown flag: ${flag}`);
    }
  }
  args.question = rest.join(' ').trim();
  return args;
}

const HELP = `${pc.bold(pc.green('caesar-research'))}: a keyless CLI research agent

${pc.bold('Usage')}
  caesar-research "<question>"

${pc.bold('Options')}  (both "--flag value" and "--flag=value" work)
  --max-results <n>     sources to search (default 10)
  --read-top <n>        sources to fully read (default 4)
  --domains <a,b>       comma-separated domains to restrict the search to
  --after <date>        only sources published after this date (e.g. 2026-01-01)
  --no-llm              skip optional Anthropic synthesis
  --json                print the briefing as one JSON object on stdout
  -h, --help            show this help

${pc.bold('Environment')} (all optional)
  CAESAR_SEARCH_API_KEY    higher rate limits on Caesar (keyless by default)
  CAESAR_RESEARCH_LLM_KEY  Anthropic key for a synthesized narrative answer

${pc.dim('Powered by Caesar search: free, no signup.')}
`;

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(pc.red(msg + '\n\n') + HELP + '\n');
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (!args.question) {
    process.stderr.write(pc.red('Please provide a question.\n\n') + HELP + '\n');
    return 1;
  }

  const client = createCaesarClient();
  process.stderr.write(pc.dim(`Searching Caesar${client.keyed ? '' : ' (anonymous tier)'}…\n`));

  let citations;
  let resultCount = 0;
  let tier: string | undefined;
  try {
    const result = await client.searchAndRead(args.question, {
      maxResults: args.maxResults,
      readTopN: args.readTopN,
      mode: 'research',
      minScore: 0.3, // drop low-confidence / unscored (gibberish) results
      ...(args.domains ? { includeDomains: args.domains } : {}),
      ...(args.after ? { publishedAfter: args.after } : {}),
    });
    citations = result.citations;
    resultCount = result.resultCount;
    tier = result.tier;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(pc.red(`Caesar request failed: ${msg}\n`));
    if (/429|rate|throttl/i.test(msg)) {
      process.stderr.write(pc.dim('The anonymous tier throttled this request. Try again shortly, or set CAESAR_SEARCH_API_KEY.\n'));
    }
    return 2;
  }

  // OPTIONAL synthesis: never required; null on no-key or any failure.
  let narrative: string | null = null;
  if (!args.noLlm) {
    narrative = await synthesize(args.question, citations);
  }

  // Distinguish a filtered/unreadable run from a genuinely empty web: Caesar
  // found results, but the score floor dropped them or every read failed.
  // Without this, "No sources were read." reads like the topic has no coverage.
  if (resultCount > 0 && readCitations(citations).length === 0) {
    process.stderr.write(pc.dim(
      `Caesar found ${resultCount} result(s), but none passed the score floor or could be read (the free tier may be busy). Try again shortly${args.domains || args.after ? ', or relax --domains/--after' : ''}.\n`,
    ));
  }

  if (args.json) {
    // ONE JSON object and nothing else on stdout: progress and hints stay on
    // stderr, so `caesar-research --json | jq` always parses. No picocolors
    // here: JSON.stringify output is ANSI-free by construction.
    const payload = {
      question: args.question,
      summary: summarize(citations, args.question, 4),
      sources: formatSources(citations),
      narrative,
      resultCount,
      tier: tier ?? (client.keyed ? 'keyed' : 'anonymous'),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }

  process.stdout.write(renderBriefing({ question: args.question, citations, narrative }) + '\n');
  return 0;
}

/**
 * Run only when invoked as a script (node dist/cli.js, or the npm bin, where
 * argv[1] is a symlink; realpathSync resolves it). Importing this module (e.g.
 * from vitest) must NOT start the CLI.
 */
function invokedAsScript(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedAsScript()) {
  main(process.argv.slice(2)).then(
    // exitCode (not process.exit) lets stdout flush; exit() can truncate piped output.
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(pc.red(`Unexpected error: ${err?.message ?? err}\n`));
      process.exitCode = 99;
    },
  );
}
