#!/usr/bin/env node
import pc from 'picocolors';
import { createCaesarClient } from '../lib/caesar.js';
import { renderBriefing } from '../lib/briefing.js';
import { synthesize } from '../lib/synthesize.js';

interface Args {
  question: string;
  help: boolean;
  maxResults: number;
  readTopN: number;
  noLlm: boolean;
}

/** Tiny hand-rolled arg parser — flags + the rest joined as the question. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { question: '', help: false, maxResults: 10, readTopN: 4, noLlm: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--no-llm') args.noLlm = true;
    else if (a === '--max-results') args.maxResults = Number(argv[++i]) || args.maxResults;
    else if (a === '--read-top') args.readTopN = Number(argv[++i]) || args.readTopN;
    else rest.push(a);
  }
  args.question = rest.join(' ').trim();
  return args;
}

const HELP = `${pc.bold(pc.green('caesar-research'))} — a keyless CLI research agent

${pc.bold('Usage')}
  caesar-research "<question>"

${pc.bold('Options')}
  --max-results <n>   sources to search (default 10)
  --read-top <n>      sources to fully read (default 4)
  --no-llm            skip optional Anthropic synthesis
  -h, --help          show this help

${pc.bold('Environment')} (all optional)
  CAESAR_SEARCH_API_KEY    higher rate limits on Caesar (keyless by default)
  CAESAR_RESEARCH_LLM_KEY  Anthropic key for a synthesized narrative answer

${pc.dim('Powered by Caesar search — free, no signup.')}
`;

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);

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
  try {
    const result = await client.searchAndRead(args.question, {
      maxResults: args.maxResults,
      readTopN: args.readTopN,
      mode: 'research',
    });
    citations = result.citations;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(pc.red(`Caesar request failed: ${msg}\n`));
    if (/429|rate|throttl/i.test(msg)) {
      process.stderr.write(pc.dim('The anonymous tier throttled this request. Try again shortly, or set CAESAR_SEARCH_API_KEY.\n'));
    }
    return 2;
  }

  // OPTIONAL synthesis — never required; null on no-key or any failure.
  let narrative: string | null = null;
  if (!args.noLlm) {
    narrative = await synthesize(args.question, citations);
  }

  process.stdout.write(renderBriefing({ question: args.question, citations, narrative }) + '\n');
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(pc.red(`Unexpected error: ${err?.message ?? err}\n`));
    process.exit(99);
  },
);
