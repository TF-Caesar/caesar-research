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
export interface SearchResultItem {
  rank: number; title: string; canonicalUrl: string; docId: string; snippet?: string; score?: number;
  /** Best-effort publication date parsed by Caesar from source metadata (RFC3339); often absent on older pages. */
  publishedAt?: string;
  /** sha256 digest of the captured content — compare across runs to detect a page change without re-reading. */
  contentDigest?: string;
}
/** The caller's live quota, straight off the response's access block. */
export interface RateLimitInfo { limitRps?: number; remaining?: number; resetAt?: string; }
export interface SearchResult { searchId?: string; results: SearchResultItem[]; tier?: string; rateLimit?: RateLimitInfo; }
export interface ReadOptions { maxChars?: number; query?: string; }
export interface ReadPassage { passageId?: string; text: string; }
export interface ReadResult { docId?: string; canonicalUrl?: string; text: string; passages: ReadPassage[]; captureId?: string; captureTime?: string; }
export interface Citation {
  rank: number; title: string; canonicalUrl: string; docId: string;
  passageId?: string; captureId?: string; captureTime?: string; passage?: string; text?: string; score?: number;
  publishedAt?: string; contentDigest?: string;
}
export interface FeedbackEvent {
  /** What happened; passage_used (a passage was cited) is the safest automatic signal. */
  eventType: 'result_helpful' | 'result_not_helpful' | 'passage_used' | 'read_abandoned' | 'duplicate_result' | 'stale_result' | 'spam_or_low_quality' | 'missing_expected_source';
  searchId?: string; docId?: string; passageId?: string; rank?: number; query?: string; notes?: string;
}
export interface SearchAndReadResult {
  evidence: string;
  citations: Citation[];
  searchId?: string;
  /**
   * Search results BEFORE the minScore filter. Lets callers distinguish "the
   * web had nothing" from "results existed but were filtered/unreadable" —
   * Caesar omits scores under load, so a minScore floor can empty citations
   * even when the search succeeded.
   */
  resultCount: number;
  tier?: string;
  rateLimit?: RateLimitInfo;
}

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

/**
 * Pick the passage most relevant to the query (simple word overlap). Returns
 * undefined when NO passage shares a word with the query — a zero-overlap
 * passage displayed as "the supporting quote" would be worse than no quote.
 * Returns the whole passage (not just text) so callers keep its passage_id
 * for provenance receipts and passage_used feedback.
 */
function pickPassage(passages: ReadPassage[], query: string): ReadPassage | undefined {
  const qWords = (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  // No scoreable query words -> nothing to rank by; Caesar's passages are
  // already query-relevant (read() passes the query), so take the first.
  if (qWords.length === 0) return passages[0];
  let best: ReadPassage | undefined;
  let bestScore = 0;
  for (const p of passages) {
    const lc = p.text.toLowerCase();
    const score = qWords.filter((w) => lc.includes(w)).length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return best;
}

/** Normalize the response's access block into { tier, rateLimit } (absent fields stay undefined). */
function accessInfo(resp: any): { tier?: string; rateLimit?: RateLimitInfo } {
  const access = resp?.access;
  if (!access) return {};
  const rl = access.rate_limit;
  return {
    ...(access.tier ? { tier: access.tier } : {}),
    ...(rl ? { rateLimit: { limitRps: rl.limit_rps, remaining: rl.remaining, resetAt: rl.reset_at } } : {}),
  };
}

/** Run `fn` over `items` with at most `limit` in flight — the anonymous tier rate-limits aggressive fan-out. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export class CaesarClient {
  private client: Caesar;
  readonly keyed: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number } = {}) {
    // Also honor the SDK's own CAESAR_API_KEY env fallback, so `keyed` can't
    // report anonymous while the SDK actually sends a key.
    const apiKey = opts.apiKey ?? process.env.CAESAR_SEARCH_API_KEY ?? process.env.CAESAR_API_KEY;
    const baseUrl = opts.baseUrl ?? process.env.CAESAR_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
    this.keyed = Boolean(apiKey);
    // apiKey omitted -> the SDK uses Caesar's anonymous tier (lower rate limit).
    // timeoutMs/maxRetries pass through to the SDK (defaults: 30s, 3 retries);
    // interactive callers should lower them so a throttled call fails fast.
    this.client = new Caesar({
      apiKey,
      baseUrl,
      ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.maxRetries != null ? { maxRetries: opts.maxRetries } : {}),
    });
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
        ...(r.metadata?.published_at ? { publishedAt: r.metadata.published_at } : {}),
        ...(r.metadata?.content_digest ? { contentDigest: r.metadata.content_digest } : {}),
      };
    });
    return { searchId: resp?.search_id, results, ...accessInfo(resp) };
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
    // Read each document once (search can surface the same doc under two ranks),
    // and cap concurrency — parallel bursts self-induce 429s on the anonymous tier.
    const keyOf = (r: SearchResultItem) => r.docId ?? r.canonicalUrl;
    const seenKeys = new Set<string>();
    const toRead = results
      .filter((r) => { const k = keyOf(r); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; })
      .slice(0, readTopN);
    const reads = await mapLimit(toRead, 3, (r) =>
      this.read(r.canonicalUrl, { maxChars: readMaxChars, query })
        .then((doc) => ({ r, doc })).catch(() => ({ r, doc: null as ReadResult | null })),
    );
    const byDoc = new Map<string, ReadResult | null>();
    for (const { r, doc } of reads) {
      const k = keyOf(r);
      if (byDoc.get(k) == null) byDoc.set(k, doc); // never clobber a successful read with a failed one
    }
    const citations: Citation[] = [];
    const blocks: string[] = [];
    for (const r of results) {
      const doc = byDoc.get(keyOf(r));
      // Caesar's real query-relevant passage (tidied) for the quote; full text kept for grounding.
      const displayPassage = doc ? pickPassage(doc.passages, query) : undefined;
      citations.push({
        rank: r.rank, title: r.title, canonicalUrl: r.canonicalUrl, docId: r.docId, score: r.score,
        captureId: doc?.captureId, captureTime: doc?.captureTime,
        passage: displayPassage?.text,
        passageId: displayPassage?.passageId,
        text: doc?.text,
        publishedAt: r.publishedAt,
        contentDigest: r.contentDigest,
      });
      const body = doc?.text && doc.text.length > 200
        ? doc.text
        : (doc?.passages ?? []).map((p) => p.text).join('\n') || displayPassage?.text || r.snippet || '';
      if (body) blocks.push(`[${r.rank}] ${r.title} — ${r.canonicalUrl}\n${body}`);
    }
    return {
      evidence: blocks.join('\n\n'), citations, searchId: search.searchId, resultCount: search.results.length,
      tier: search.tier, rateLimit: search.rateLimit,
    };
  }

  /**
   * Fire-and-forget quality feedback to Caesar (/v1/feedback). Deliberately
   * not awaited and never throws: feedback is a courtesy signal that helps
   * Caesar's ranking learn, not part of the request path — a failed or slow
   * feedback call must never affect what the user sees.
   */
  sendFeedback(event: FeedbackEvent): void {
    const { eventType, searchId, docId, passageId, rank, query, notes } = event;
    void Promise.resolve()
      .then(() => (this.client as any).feedback(eventType, {
        ...(searchId ? { search_id: searchId } : {}),
        ...(docId ? { doc_id: docId } : {}),
        ...(passageId ? { passage_id: passageId } : {}),
        ...(rank != null ? { rank } : {}),
        ...(query ? { query } : {}),
        ...(notes ? { notes } : {}),
      }))
      .catch(() => { /* best-effort by design */ });
  }
}

export function createCaesarClient(opts?: { apiKey?: string; baseUrl?: string }): CaesarClient {
  return new CaesarClient(opts);
}
