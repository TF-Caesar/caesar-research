import { Caesar } from 'caesar-search';

export interface SearchOptions {
  maxResults?: number;
  mode?: 'fast' | 'standard' | 'research';
  includeDomains?: string[];
  excludeDomains?: string[];
  publishedAfter?: string;
  country?: string;
  language?: string;
  /**
   * Caller-provided query rewrites (SearchRequest.search_queries). The FIRST
   * entry replaces the text sent to the search index; the original query
   * still drives reranking and passage selection, so rewrites improve recall
   * without losing the caller's intent.
   */
  searchQueries?: string[];
}
export interface SearchResultItem {
  rank: number; title: string; canonicalUrl: string; docId: string; snippet?: string; score?: number;
  /** Best-effort publication date parsed by Caesar from source metadata (RFC3339); often absent on older pages. */
  publishedAt?: string;
  /** sha256 digest of the captured content — compare across runs to detect a page change without re-reading. */
  contentDigest?: string;
  /** Which index served this result: 'web' (shared corpus) or 'workspace' (your ingested documents). */
  index?: string;
}
/** The caller's live quota, straight off the response's access block. */
export interface RateLimitInfo { limitRps?: number; remaining?: number; resetAt?: string; }
export interface SearchResult { searchId?: string; results: SearchResultItem[]; tier?: string; rateLimit?: RateLimitInfo; }
export interface ReadOptions {
  maxChars?: number;
  query?: string;
  /** Also return the document's capture timeline (one extra include, same call). */
  includeCaptureHistory?: boolean;
}
export interface ReadPassage {
  passageId?: string;
  /** Display text, tidied of markdown noise — offsets below do NOT index into this string. */
  text: string;
  /**
   * Character offsets into the RAW captured document text — receipt
   * coordinates, not display indexes. Best-effort: absent on a document's
   * first-ever capture (verified live), present on subsequent reads. Render
   * them only when present.
   */
  charStart?: number;
  charEnd?: number;
  /** Heading of the section the passage sits under, when the page structure exposes one. */
  sectionHeading?: string;
}
/** One entry in a document's capture timeline. */
export interface CaptureHistoryEntry { captureId: string; captureTime: string; contentDigest?: string; }
export interface ReadResult {
  docId?: string; canonicalUrl?: string; text: string; passages: ReadPassage[]; captureId?: string; captureTime?: string;
  /** Present when ReadOptions.includeCaptureHistory was set: newest-first capture timeline. */
  captureHistory?: CaptureHistoryEntry[];
}
export interface Citation {
  rank: number; title: string; canonicalUrl: string; docId: string;
  passageId?: string; captureId?: string; captureTime?: string; passage?: string; text?: string; score?: number;
  publishedAt?: string; contentDigest?: string;
  /** Receipt coordinates of the quoted passage in the RAW captured text (see ReadPassage). */
  passageStart?: number;
  passageEnd?: number;
  /** Section heading the quoted passage sits under, when the page exposes one. */
  passageSection?: string;
  /** Which index served the result ('web' | 'workspace'). */
  index?: string;
  /** Number of captures Caesar holds for this document (present with includeCaptureHistory). */
  captureCount?: number;
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

/**
 * Failure classes callers can branch messaging on. Duck-typed off the SDK
 * error shape (statusCode/code) rather than instanceof, so it stays correct
 * when tests mock the caesar-search module.
 */
export type CaesarFailure = 'not_configured' | 'auth' | 'balance' | 'rate_limited' | 'other';

export function classifyCaesarError(err: unknown): CaesarFailure {
  const e = err as { statusCode?: number; code?: string; message?: string } | null;
  if (!e) return 'other';
  if (e.message === NOT_CONFIGURED_MESSAGE || e.code === 'missing_api_key') return 'not_configured';
  if (e.statusCode === 402 || e.code === 'insufficient_balance') return 'balance';
  if (e.statusCode === 401 || e.statusCode === 403) return 'auth';
  if (e.statusCode === 429) return 'rate_limited';
  return 'other';
}

const NOT_CONFIGURED_MESSAGE =
  'Caesar API key not configured: set CAESAR_SEARCH_API_KEY (or CAESAR_API_KEY)';

/** Run `fn` over `items` with at most `limit` in flight — Caesar rate-limits aggressive fan-out. */
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
  private client: Caesar | null;
  /** True when a Caesar API key is configured. The public API is keyed-only. */
  readonly keyed: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string; timeoutMs?: number; maxRetries?: number } = {}) {
    // Also honor the SDK's own CAESAR_API_KEY env fallback, so `keyed` can't
    // report unconfigured while the SDK would actually send a key.
    const apiKey = opts.apiKey ?? process.env.CAESAR_SEARCH_API_KEY ?? process.env.CAESAR_API_KEY;
    const baseUrl = opts.baseUrl ?? process.env.CAESAR_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
    this.keyed = Boolean(apiKey);
    // timeoutMs/maxRetries pass through to the SDK (defaults: 30s, 3 retries);
    // interactive callers should lower them so a throttled call fails fast.
    //
    // caesar-search 0.2.0 THROWS MissingAPIKeyError at construction when no
    // key is set against the public API (anonymous access was removed). Defer
    // that failure to the first call instead: route handlers and CLIs construct
    // this client eagerly, and an unconfigured deployment should degrade
    // through their normal fallback paths, not crash at import/startup.
    let client: Caesar | null = null;
    try {
      client = new Caesar({
        apiKey,
        baseUrl,
        ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
        ...(opts.maxRetries != null ? { maxRetries: opts.maxRetries } : {}),
      });
    } catch {
      client = null; // no key: every call will throw not_configured lazily
    }
    this.client = client;
  }

  /** The SDK client, or a thrown not_configured error callers can classify. */
  private requireClient(): Caesar {
    if (!this.client) throw new Error(NOT_CONFIGURED_MESSAGE);
    return this.client;
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
    if (options.searchQueries?.length) extraBody.search_queries = options.searchQueries;
    const resp: any = await this.requireClient().search(query, {
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
        ...(r.index ? { index: r.index } : {}),
      };
    });
    return { searchId: resp?.search_id, results, ...accessInfo(resp) };
  }

  async read(target: string, options: ReadOptions = {}): Promise<ReadResult> {
    // The SDK defaults `include` to ['metadata','content'] (NO passages), so we
    // ask for passages explicitly. Since 0.2.0 the SDK also hardcodes
    // content.selection to full_document, so we pass the WHOLE content object
    // through extraBody (its top-level Object.assign replaces `content`
    // wholesale) to keep the behavior this portfolio was tuned on: with a
    // query, content.text and passages are selected for relevance to it.
    // max_chars must live inside our content object for the same reason.
    const content: Record<string, unknown> = {
      selection: options.query ? 'query_relevant' : 'full_document',
      format: 'markdown',
      include_offsets: true, // passages carry char offsets into the captured text — receipt precision for free
      ...(options.maxChars != null ? { max_chars: options.maxChars } : {}),
    };
    const resp: any = await this.requireClient().read(target, {
      include: ['metadata', 'content', 'passages', ...(options.includeCaptureHistory ? ['capture_history'] : [])],
      ...(options.query ? { query: options.query } : {}),
      extraBody: { content },
    });
    const passages: ReadPassage[] = (resp?.passages ?? [])
      .map((p: any) => ({
        passageId: p.passage_id,
        text: tidy(p.text ?? ''),
        ...(p.char_start != null ? { charStart: p.char_start } : {}),
        ...(p.char_end != null ? { charEnd: p.char_end } : {}),
        ...(p.section_heading ? { sectionHeading: p.section_heading } : {}),
      }))
      .filter((p: ReadPassage) => p.text.length > 0);
    const captureHistory: CaptureHistoryEntry[] | undefined = options.includeCaptureHistory
      ? (resp?.capture_history ?? []).map((h: any) => ({
          captureId: h.capture_id,
          captureTime: h.capture_time,
          ...(h.content_digest ? { contentDigest: h.content_digest } : {}),
        }))
      : undefined;
    return {
      docId: resp?.doc?.doc_id ?? resp?.doc_id,
      canonicalUrl: resp?.doc?.canonical_url ?? resp?.canonical_url,
      text: resp?.content?.text ?? '',
      passages,
      captureId: resp?.provenance?.capture_id,
      captureTime: resp?.provenance?.capture_time,
      ...(captureHistory ? { captureHistory } : {}),
    };
  }

  async searchAndRead(
    query: string,
    options: SearchOptions & { readTopN?: number; readMaxChars?: number; minScore?: number; includeCaptureHistory?: boolean } = {},
  ): Promise<SearchAndReadResult> {
    const { readTopN = 3, readMaxChars = 8000, minScore = 0, includeCaptureHistory, ...searchOpts } = options;
    const search = await this.search(query, { maxResults: 10, ...searchOpts });
    // Drop low-confidence / unscored results (gibberish queries return null scores).
    const results = minScore > 0 ? search.results.filter((r) => r.score != null && r.score >= minScore) : search.results;
    // Read each document once (search can surface the same doc under two ranks),
    // and cap concurrency — parallel bursts self-induce 429s.
    const keyOf = (r: SearchResultItem) => r.docId ?? r.canonicalUrl;
    const seenKeys = new Set<string>();
    const toRead = results
      .filter((r) => { const k = keyOf(r); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; })
      .slice(0, readTopN);
    const reads = await mapLimit(toRead, 3, (r) =>
      this.read(r.canonicalUrl, { maxChars: readMaxChars, query, ...(includeCaptureHistory ? { includeCaptureHistory } : {}) })
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
        passageStart: displayPassage?.charStart,
        passageEnd: displayPassage?.charEnd,
        passageSection: displayPassage?.sectionHeading,
        text: doc?.text,
        publishedAt: r.publishedAt,
        contentDigest: r.contentDigest,
        index: r.index,
        ...(doc?.captureHistory ? { captureCount: doc.captureHistory.length } : {}),
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
    if (!this.client) return; // unconfigured: nothing to send, never throw
    const { eventType, searchId, docId, passageId, rank, query, notes } = event;
    const client = this.client;
    void Promise.resolve()
      .then(() => (client as any).feedback(eventType, {
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
