import { Caesar } from 'caesar-search';

export interface SearchOptions {
  maxResults?: number;
  mode?: 'fast' | 'standard' | 'research';
  includeDomains?: string[];
  excludeDomains?: string[];
  publishedAfter?: string;
  country?: string;
  language?: string;
}
export interface SearchResultItem { rank: number; title: string; canonicalUrl: string; docId: string; snippet?: string; score?: number; }
export interface SearchResult { searchId?: string; results: SearchResultItem[]; }
export interface ReadOptions { maxChars?: number; query?: string; }
export interface ReadPassage { passageId?: string; text: string; }
export interface ReadResult { docId?: string; canonicalUrl?: string; text: string; passages: ReadPassage[]; captureId?: string; captureTime?: string; }
export interface Citation {
  rank: number; title: string; canonicalUrl: string; docId: string;
  passageId?: string; captureId?: string; captureTime?: string; passage?: string; text?: string; score?: number;
}
export interface SearchAndReadResult { evidence: string; citations: Citation[]; searchId?: string; }

const DEFAULT_BASE_URL = 'https://alpha.api.trycaesar.com';

/** Strip markdown/image/link noise from a Caesar passage so a quote reads clean. */
function tidy(s: string): string {
  return (s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')      // images removed entirely
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')    // links -> their text
    .replace(/[*_`>#~|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Pick the passage most relevant to the query (simple word overlap). */
function pickPassage(passages: ReadPassage[], query: string): string | undefined {
  const qWords = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  let best: string | undefined;
  let bestScore = -1;
  for (const p of passages) {
    const lc = p.text.toLowerCase();
    const score = qWords.filter((w) => lc.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = p.text; }
  }
  return best;
}

export class CaesarClient {
  private client: Caesar;
  readonly keyed: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.CAESAR_SEARCH_API_KEY;
    const baseUrl = opts.baseUrl ?? process.env.CAESAR_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
    this.keyed = Boolean(apiKey);
    // apiKey omitted -> the SDK uses Caesar's anonymous tier (lower rate limit).
    this.client = new Caesar({ apiKey, baseUrl });
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    // mode + maxResults are native SDK options; domain/freshness/locale policies
    // are first-class SearchRequest body fields passed through extraBody.
    const extraBody: Record<string, unknown> = {};
    if (options.includeDomains || options.excludeDomains) {
      extraBody.source_policy = {
        ...(options.includeDomains ? { include_domains: options.includeDomains } : {}),
        ...(options.excludeDomains ? { exclude_domains: options.excludeDomains } : {}),
        // include_domains only filters strictly when require_domain_match is set.
        ...(options.includeDomains ? { require_domain_match: true } : {}),
      };
    }
    if (options.publishedAfter) extraBody.freshness_policy = { published_after: options.publishedAfter };
    if (options.country || options.language) {
      extraBody.filters = {
        ...(options.country ? { country: options.country } : {}),
        ...(options.language ? { language: options.language } : {}),
      };
    }
    const resp: any = await this.client.search(query, {
      maxResults: options.maxResults,
      mode: options.mode,
      verbosity: 'standard', // ensure results carry a relevance score (for minScore filtering)
      ...(Object.keys(extraBody).length ? { extraBody } : {}),
    });
    const results: SearchResultItem[] = (resp?.results ?? []).map((r: any) => {
      const score = typeof r.score === 'object' ? r.score?.value : r.score;
      return {
        rank: r.rank, title: r.title, canonicalUrl: r.canonical_url, docId: r.doc_id, snippet: r.snippet,
        ...(score != null ? { score } : {}),
      };
    });
    return { searchId: resp?.search_id, results };
  }

  async read(target: string, options: ReadOptions = {}): Promise<ReadResult> {
    // The SDK defaults `include` to ['metadata','content'] (NO passages) and picks
    // content.selection from query presence (query -> query_relevant, else
    // full_document). We ask for passages explicitly; query/maxChars are native.
    const resp: any = await this.client.read(target, {
      include: ['metadata', 'content', 'passages'],
      ...(options.query ? { query: options.query } : {}),
      ...(options.maxChars != null ? { maxChars: options.maxChars } : {}),
    });
    const passages: ReadPassage[] = (resp?.passages ?? [])
      .map((p: any) => ({ passageId: p.passage_id, text: tidy(p.text ?? '') }))
      .filter((p: ReadPassage) => p.text.length > 0);
    return {
      docId: resp?.doc?.doc_id ?? resp?.doc_id,
      canonicalUrl: resp?.doc?.canonical_url ?? resp?.canonical_url,
      text: resp?.content?.text ?? '',
      passages,
      captureId: resp?.provenance?.capture_id,
      captureTime: resp?.provenance?.capture_time,
    };
  }

  async searchAndRead(
    query: string,
    options: SearchOptions & { readTopN?: number; readMaxChars?: number; minScore?: number } = {},
  ): Promise<SearchAndReadResult> {
    const { readTopN = 3, readMaxChars = 8000, minScore = 0, ...searchOpts } = options;
    const search = await this.search(query, { maxResults: 10, ...searchOpts });
    // Drop low-confidence / unscored results (gibberish queries return null scores).
    const results = minScore > 0 ? search.results.filter((r) => r.score != null && r.score >= minScore) : search.results;
    const toRead = results.slice(0, readTopN);
    const reads = await Promise.all(
      toRead.map((r) =>
        this.read(r.canonicalUrl, { maxChars: readMaxChars, query })
          .then((doc) => ({ r, doc })).catch(() => ({ r, doc: null as ReadResult | null })),
      ),
    );
    const byDoc = new Map(reads.map(({ r, doc }) => [r.docId, doc]));
    const citations: Citation[] = [];
    const blocks: string[] = [];
    for (const r of results) {
      const doc = byDoc.get(r.docId);
      // Caesar's real query-relevant passage (tidied) for the quote; full text kept for grounding.
      const displayPassage = doc ? pickPassage(doc.passages, query) ?? doc.passages[0]?.text : undefined;
      citations.push({
        rank: r.rank, title: r.title, canonicalUrl: r.canonicalUrl, docId: r.docId, score: r.score,
        captureId: doc?.captureId, captureTime: doc?.captureTime,
        passage: displayPassage,
        text: doc?.text,
      });
      const body = doc?.text && doc.text.length > 200
        ? doc.text
        : (doc?.passages ?? []).map((p) => p.text).join('\n') || displayPassage || r.snippet || '';
      if (body) blocks.push(`[${r.rank}] ${r.title} — ${r.canonicalUrl}\n${body}`);
    }
    return { evidence: blocks.join('\n\n'), citations, searchId: search.searchId };
  }
}

export function createCaesarClient(opts?: { apiKey?: string; baseUrl?: string }): CaesarClient {
  return new CaesarClient(opts);
}
