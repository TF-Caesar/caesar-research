import type { Citation } from './caesar.js';

/**
 * Deterministic, evidence-grounded summarization for the research briefing.
 *
 * Caesar's anonymous read() returns content.text but usually NO structured
 * passages — so we score and extract sentences from the FULL read text
 * (citation.text), never relying on citation.passage alone.
 *
 * The snippet scorer is ported from caesar-verifier/lib/verify.ts (bestSnippet):
 * key terms drive overlap, "hard tokens" (numbers/dates/acronyms) are weighted.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'is', 'are', 'was', 'were', 'be', 'by',
  'for', 'with', 'at', 'as', 'that', 'this', 'it', 'its', 'from', 'has', 'have', 'had', 'first',
  'time', 'what', 'who', 'when', 'where', 'why', 'how', 'which', 'did', 'do', 'does', 'will',
  'would', 'can', 'could', 'about', 'into', 'than', 'then', 'there', 'their',
]);

export function keyTerms(question: string): string[] {
  return (question.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * "Hard" tokens are SPECIFIC evidence a sentence echoes: numbers/dates/money/
 * percentages and ALL-CAPS acronyms. Weighted heavily so figures surface.
 */
export function hardTokens(question: string): string[] {
  const tokens: string[] = [];
  for (const m of question.matchAll(/\$?\d[\d,]*(?:\.\d+)?%?/g)) tokens.push(m[0]);
  for (const m of question.matchAll(/\b[A-Z]{2,}\b/g)) tokens.push(m[0]);
  return tokens;
}

/** Strip common markdown noise so an extracted sentence reads clean. */
export function cleanMarkdown(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // images/links -> text
    .replace(/[*_`~]+/g, '')                   // bold/italic/code/strike marks
    .replace(/^\s*#{1,6}\s*/, '')              // leading heading hashes
    .replace(/^\s*>+\s*/, '')                  // blockquote marker
    .replace(/^\s*[-*+]\s+/, '')               // list bullet
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ScoredSentence {
  text: string;
  score: number;
  rank: number; // source rank this sentence came from
}

function splitSentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+/) // line breaks AND sentence ends
    .map(cleanMarkdown)
    .filter((s) => s.length > 25 && s.length < 400);
}

/** Score a single sentence against the question's terms (bestSnippet scorer). */
export function scoreSentence(sentence: string, terms: string[], hards: string[]): number {
  const lc = sentence.toLowerCase();
  let score = terms.filter((t) => lc.includes(t)).length;
  if (hards.some((h) => lc.includes(h.toLowerCase()))) score += 3;
  return score;
}

/** Pick the single most relevant sentence from one read's text, cleaned for display. */
export function bestSnippet(text: string, question: string, maxLen = 280): string | undefined {
  if (!text) return undefined;
  const terms = keyTerms(question);
  const hards = hardTokens(question);
  let best = '';
  let bestScore = 0;
  for (const s of splitSentences(text)) {
    const score = scoreSentence(s, terms, hards);
    if (score > bestScore) { bestScore = score; best = s; }
  }
  if (bestScore === 0) return undefined;
  return best.length > maxLen ? best.slice(0, maxLen).replace(/\s+\S*$/, '') + '…' : best;
}

/**
 * Build a deterministic, evidence-grounded summary: extract the most relevant
 * sentences ACROSS all read texts (not just the top one), de-duplicate, and
 * return the strongest few. Always grounded in citation.text.
 */
export function summarize(citations: Citation[], question: string, maxSentences = 4): string[] {
  const terms = keyTerms(question);
  const hards = hardTokens(question);
  const scored: ScoredSentence[] = [];
  const seen = new Set<string>();

  for (const c of citations) {
    const body = c.text && c.text.length > 200 ? c.text : c.passage ?? '';
    if (!body) continue;
    for (const s of splitSentences(body)) {
      const key = s.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 80);
      if (seen.has(key)) continue;
      const score = scoreSentence(s, terms, hards);
      if (score <= 0) continue;
      seen.add(key);
      scored.push({ text: s.length > 280 ? s.slice(0, 280).replace(/\s+\S*$/, '') + '…' : s, score, rank: c.rank });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.rank - b.rank);
  return scored.slice(0, maxSentences).map((s) => s.text);
}

export interface SourceLine {
  index: number;
  title: string;
  url: string;
  capturedISO?: string;
}

/** Format the numbered Sources list. Only includes sources actually read. */
export function formatSources(citations: Citation[]): SourceLine[] {
  return citations.map((c, i) => ({
    index: i + 1,
    title: (c.title || c.canonicalUrl || 'Untitled').trim(),
    url: c.canonicalUrl,
    capturedISO: c.captureTime,
  }));
}
