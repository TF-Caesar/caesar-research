#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pc from 'picocolors';
import { classifyCaesarError, createCaesarClient } from '../lib/caesar.js';
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
  /**
   * Caller query rewrites (SearchOptions.searchQueries). The first rewrite
   * replaces the text the search index sees; the question still drives
   * reranking and passage selection.
   */
  queries?: string[];
  /**
   * Which Caesar indexes to search: web (default) and/or workspace (your
   * organization's ingested documents). workspace requires --workspace-id.
   */
  scope?: ('web' | 'workspace')[];
  workspaceId?: string;
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
      case '--queries': {
        const queries = value().split(',').map((q) => q.trim()).filter(Boolean);
        if (queries.length === 0) throw new UsageError('--queries expects a comma-separated list of query rewrites, e.g. --queries "2022 world cup winner,fifa 2022 final result"');
        args.queries = queries;
        break;
      }
      case '--scope': {
        const tokens = value().split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (tokens.length === 0) throw new UsageError('--scope expects a comma-separated list, e.g. --scope web,workspace');
        for (const t of tokens) {
          if (t !== 'web' && t !== 'workspace') throw new UsageError(`--scope accepts only "web" and "workspace", got "${t}"`);
        }
        args.scope = [...new Set(tokens)] as ('web' | 'workspace')[];
        break;
      }
      case '--workspace-id': {
        const id = value().trim();
        // Mirror the API's format so a typo fails here, before spending a search.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          throw new UsageError('--workspace-id expects a UUID, e.g. --workspace-id 123e4567-e89b-42d3-a456-426614174000');
        }
        args.workspaceId = id;
        break;
      }
      default:
        throw new UsageError(`Unknown flag: ${flag}`);
    }
  }
  args.question = rest.join(' ').trim();
  // Mirror the server's rule locally (it 400s on this) so the failure is
  // instant and costs nothing; the inverse is a silent no-op, so reject it too.
  if (args.scope?.includes('workspace') && !args.workspaceId) {
    throw new UsageError('--scope workspace requires --workspace-id <uuid>');
  }
  if (args.workspaceId && !args.scope?.includes('workspace')) {
    throw new UsageError('--workspace-id only applies when --scope includes workspace');
  }
  return args;
}

const HELP = `${pc.bold(pc.green('caesar-research'))}: a CLI research agent with receipts

${pc.bold('Usage')}
  caesar-research "<question>"

${pc.bold('Options')}  (both "--flag value" and "--flag=value" work)
  --max-results <n>     sources to search (default 10)
  --read-top <n>        sources to fully read (default 4)
  --domains <a,b>       comma-separated domains to restrict the search to
  --after <date>        only sources published after this date (e.g. 2026-01-01)
  --queries "<a,b>"     comma-separated query rewrites: the first replaces what
                        the search index sees, your question still drives the
                        reranking and passage selection
  --scope <a,b>         indexes to search: web (default) and/or workspace, your
                        organization's ingested documents
  --workspace-id <uuid> the workspace to search; required with --scope workspace
  --no-llm              skip optional Anthropic synthesis
  --json                print the briefing as one JSON object on stdout
  -h, --help            show this help

${pc.bold('Environment')}
  CAESAR_SEARCH_API_KEY    Caesar API key, required (CAESAR_API_KEY works too)
  CAESAR_RESEARCH_LLM_KEY  optional Anthropic key for a synthesized narrative answer

${pc.dim('Powered by Caesar search. New accounts include $1,000 in credits: https://trycaesar.com')}
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
  // An unconfigured client throws on the first call, so skip the progress line
  // when we already know the search cannot start.
  if (client.keyed) process.stderr.write(pc.dim('Searching Caesar…\n'));

  let citations;
  let resultCount = 0;
  let tier: string | undefined;
  let warnings: { code: string; message: string }[] = [];
  try {
    const result = await client.searchAndRead(args.question, {
      maxResults: args.maxResults,
      readTopN: args.readTopN,
      mode: 'research',
      minScore: 0.3, // drop low-confidence / unscored (gibberish) results
      ...(args.domains ? { includeDomains: args.domains } : {}),
      ...(args.after ? { publishedAfter: args.after } : {}),
      ...(args.queries ? { searchQueries: args.queries } : {}),
      ...(args.scope ? { scopeIndexes: args.scope } : {}),
      ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    });
    citations = result.citations;
    resultCount = result.resultCount;
    tier = result.tier;
    warnings = result.warnings ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    switch (classifyCaesarError(err)) {
      case 'not_configured':
        // ONE actionable line, no stack trace: the operator needs a key, nothing else.
        process.stderr.write(pc.red(
          'Caesar API key required: set CAESAR_SEARCH_API_KEY (or CAESAR_API_KEY). New accounts include $1,000 in credits at https://trycaesar.com\n',
        ));
        return 1;
      case 'auth':
        process.stderr.write(pc.red(`Caesar rejected the API key: ${msg}\n`));
        process.stderr.write(pc.dim('Check CAESAR_SEARCH_API_KEY, or get a key at https://trycaesar.com.\n'));
        return 2;
      case 'balance':
        process.stderr.write(pc.red(`Caesar account balance exhausted: ${msg}\n`));
        process.stderr.write(pc.dim('Top up at https://trycaesar.com.\n'));
        return 2;
      case 'rate_limited':
        process.stderr.write(pc.red(`Caesar request failed: ${msg}\n`));
        process.stderr.write(pc.dim('Caesar throttled this request. Try again shortly.\n'));
        return 2;
      default:
        process.stderr.write(pc.red(`Caesar request failed: ${msg}\n`));
        return 2;
    }
  }

  // The API attaches structured warnings to otherwise-successful responses
  // (e.g. workspace_index_unavailable: scoped search fell back to web-only).
  // They change what the results MEAN, so they are never swallowed.
  for (const w of warnings) {
    process.stderr.write(pc.yellow(`note: ${w.message}\n`));
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
      `Caesar found ${resultCount} result(s), but none passed the score floor or could be read. Try again shortly${args.domains || args.after ? ', or relax --domains/--after' : ''}.\n`,
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
      // The public API is keyed-only: a response that omitted its access block
      // still came from a keyed call.
      tier: tier ?? 'keyed',
      ...(warnings.length ? { warnings } : {}),
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
