# Caesar Research

Ask a question. Get a cited, evidence-grounded briefing — pulled from **live web sources**, not a model's memory.

```bash
npx caesar-research "who won the 2022 FIFA World Cup"
```

Free. No signup. No API key. **Powered by [Caesar](https://trycaesar.com) search — free, no signup.**

## Why this is different

Most "ask an AI" tools answer from training data and hope it's still true. This one **searches the live web, reads the top sources, and shows you the receipts**: a short summary built from the actual sentences in those sources, then a numbered list of every source with its URL and **the moment it was captured**.

By default the summary is **deterministic** — it extracts the most question-relevant sentences across the sources using a small term-overlap scorer (the same `bestSnippet` idea behind [caesar-verifier](https://github.com/TF-Caesar/caesar-verifier)). No model required, nothing invented. If you want a narrative answer, point it at an Anthropic key and it will synthesize one **grounded in the same evidence** — and fall back to the deterministic briefing on any failure.

## Run it locally (zero setup)

```bash
git clone https://github.com/TF-Caesar/caesar-research
cd caesar-research
npm install
npm run build
node dist/cli.js "what is the James Webb Space Telescope"
```

No keys required — it runs on Caesar's free anonymous tier.

Optional environment variables:

- `CAESAR_SEARCH_API_KEY` — a Caesar key for higher rate limits (keyless by default).
- `CAESAR_RESEARCH_LLM_KEY` — an Anthropic key to synthesize a narrative answer (off by default; deterministic otherwise).

Flags:

- `--max-results <n>` — how many sources to search (default 10).
- `--read-top <n>` — how many sources to fully read (default 4).
- `--no-llm` — skip synthesis even if a key is set.

## How it works

`searchAndRead` the question (search the web, then read the top sources) → score and extract the most relevant sentences from the **full captured text** of each source → print a clean, cited briefing.

A Caesar detail worth knowing: on the anonymous tier, `read()` returns the page text but usually **no structured passages** — so this tool always grounds and extracts against the full read text, never relying on a passage object alone. The entire Caesar integration is one small, dependency-light file you can copy into your own project: [`lib/caesar.ts`](lib/caesar.ts).

The briefing has three parts:

1. **Question** — exactly what you asked.
2. **Summary** (or **Answer** if synthesizing) — short, evidence-grounded, drawn from the sources.
3. **Sources** — numbered, each with title, URL, and `captured <ISO time>`.

## License

MIT.
