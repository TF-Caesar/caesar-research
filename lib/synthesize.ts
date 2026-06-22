import type { Citation } from './caesar.js';

/**
 * OPTIONAL narrative synthesis via Anthropic. Only runs if CAESAR_RESEARCH_LLM_KEY
 * is set. On ANY failure the caller falls back to the deterministic briefing — a
 * key is never required.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

/** Build the grounded evidence block the model must reason over. */
function evidenceBlock(citations: Citation[]): string {
  const blocks: string[] = [];
  for (const c of citations) {
    const body = c.text && c.text.length > 200 ? c.text : c.passage ?? '';
    if (!body) continue;
    const trimmed = body.length > 4000 ? body.slice(0, 4000) : body;
    blocks.push(`[${c.rank}] ${c.title} — ${c.canonicalUrl}\n${trimmed}`);
  }
  return blocks.join('\n\n');
}

export interface SynthesizeOptions {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Returns a narrative answer grounded in the evidence, or null if no key is set
 * or the call fails. Never throws — failure is a clean null.
 */
export async function synthesize(
  question: string,
  citations: Citation[],
  opts: SynthesizeOptions = {},
): Promise<string | null> {
  const apiKey = opts.apiKey ?? process.env.CAESAR_RESEARCH_LLM_KEY;
  if (!apiKey) return null;

  const evidence = evidenceBlock(citations);
  if (!evidence) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  const prompt =
    `You are a careful research assistant. Using ONLY the numbered sources below, ` +
    `write a concise narrative answer to the question. Cite sources inline as [n]. ` +
    `If the sources do not answer the question, say so plainly. Do not invent facts.\n\n` +
    `Question: ${question}\n\nSources:\n${evidence}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30000);
  try {
    const resp = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const data: any = await resp.json();
    const text = data?.content?.[0]?.text;
    return typeof text === 'string' && text.trim() ? text.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
