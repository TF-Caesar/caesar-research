# Caesar Research

Ask a question. Get a cited, evidence-grounded briefing — pulled from **live web sources**, not a model's memory.

```bash
git clone https://github.com/TF-Caesar/caesar-research
cd caesar-research
npm install && npm run build
export CAESAR_SEARCH_API_KEY="your-key"  # new accounts include $1,000 in credits: https://trycaesar.com
node dist/cli.js "who won the 2022 FIFA World Cup"
```

**Powered by [Caesar](https://trycaesar.com) search.** You need a Caesar API key; new accounts include $1,000 in credits.

Once the package is published to npm, the clone-and-build steps collapse to a one-liner (the key export stays):

```bash
npx caesar-research "who won the 2022 FIFA World Cup"
```

Until then, the clone-and-build steps above are the way to run it.

## Why this is different

Most "ask an AI" tools answer from training data and hope it's still true. This one **searches the live web, reads the top sources, and shows you the receipts**: a short summary built from the actual sentences in those sources, then a numbered list of every source with its URL and **the moment it was captured**.

By default the summary is **deterministic** — it extracts the most question-relevant sentences across the sources using a small term-overlap scorer (the same `bestSnippet` idea behind [caesar-verifier](https://github.com/TF-Caesar/caesar-verifier)). No model required, nothing invented. If you want a narrative answer, point it at an Anthropic key and it will synthesize one **grounded in the same evidence** — and fall back to the deterministic briefing on any failure.

## Options

Environment variables:

- `CAESAR_SEARCH_API_KEY` (required): your Caesar API key. The SDK's own `CAESAR_API_KEY` fallback works too. New accounts include $1,000 in credits at [trycaesar.com](https://trycaesar.com).
- `CAESAR_RESEARCH_LLM_KEY` (optional): an Anthropic key to synthesize a narrative answer (off by default; deterministic otherwise).

Flags (every flag accepts both `--flag value` and `--flag=value`; an unknown or malformed flag errors instead of silently joining the question):

| Flag | What it does | Default |
| --- | --- | --- |
| `--max-results <n>` | how many sources to search | 10 |
| `--read-top <n>` | how many sources to fully read | 4 |
| `--domains <a.com,b.com>` | restrict the search to these domains | all domains |
| `--after <YYYY-MM-DD>` | only sources published after this date | any time |
| `--queries "<a,b>"` | comma-separated query rewrites: the first replaces the text the search index sees, while your question still drives reranking and passage selection | the question as-is |
| `--scope <web,workspace>` | which Caesar indexes to search: the web corpus and/or your organization's ingested documents | web |
| `--workspace-id <uuid>` | the workspace to search; required when `--scope` includes `workspace` | |
| `--no-llm` | skip synthesis even if a key is set | off |
| `--json` | print one JSON object (`question`, `summary`, `sources`, `narrative`, `resultCount`, `tier`, plus `warnings` when the API attached any) to stdout, nothing else: pipe it straight into `jq` | off |
| `-h, --help` | show help | |

## How it works

`searchAndRead` the question (search the web, then read the top sources) → score and extract the most relevant sentences from the **full captured text** of each source → print a clean, cited briefing.

A Caesar detail worth knowing: `read()` sometimes returns the page text with **no structured passages**, so this tool always grounds and extracts against the full read text, never relying on a passage object alone. The entire Caesar integration is one small, dependency-light file you can copy into your own project: [`lib/caesar.ts`](lib/caesar.ts).

The briefing has three parts:

1. **Question** — exactly what you asked.
2. **Summary** (or **Answer** if synthesizing) — short, evidence-grounded, drawn from the sources.
3. **Sources** — numbered, each with title, URL, and `captured <ISO time>`. When Caesar pins the quoted passage, the stamp also names the section heading it sits under and its character offsets into the captured document text (`section Pricing · chars 1204-1377`), so a receipt points at the exact spot, not just the page. Offsets are best-effort: they are absent on a document's first-ever capture, and the line stays clean without them.

When you know how the answer is phrased on the page, `--queries` lets you rewrite what the search index sees without losing your intent: the first rewrite replaces the index text, but your original question still ranks the results and picks the passages. Useful when the question and the source vocabulary diverge, for example `--queries "Pro plan pricing"` for the question "how much does the paid tier cost".

## Research over your own documents

Caesar can search your organization's ingested documents alongside the web. Point the tool at a workspace and the same briefing pipeline runs over both indexes, with workspace sources marked in the Sources list so your document never masquerades as a web page:

```bash
caesar-research "what did we decide about pricing" --scope web,workspace --workspace-id <your-workspace-uuid>
```

Honest by design: on deployments where the workspace index is not yet federated, Caesar answers with web results and attaches a warning saying so. The CLI prints that note rather than letting web results pass as your documents, and `--json` carries the same warning structurally.

## License

MIT.
