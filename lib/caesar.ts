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
export interface SearchResultItem { rank: number; title: string; canonicalUrl: string; docId: string; snippet?: string; }
export interface SearchResult { searchId?: string; results: SearchResultItem[]; }
export interface ReadOptions { maxChars?: number; selection?: string; query?: string; }
export interface ReadPassage { passageId?: string; text: string; }
export interface ReadResult { docId?: string; canonicalUrl?: string; text: string; passages: ReadPassage[]; captureId?: string; captureTime?: string; }
export interface Citation {
  rank: number; title: string; canonicalUrl: string; docId: string;
  passageId?: string; captureId?: string; captureTime?: string; passage?: string; text?: string;
}
export interface SearchAndReadResult { evidence: string; citations: Citation[]; searchId?: string; }

const DEFAULT_BASE_URL = 'https://alpha.api.trycaesar.com';

export class CaesarClient {
  private client: Caesar;
  readonly keyed: boolean;

  constructor(opts: { apiKey?: string; baseUrl?: string } = {}) {
    const apiKey = opts.apiKey ?? process.env.CAESAR_SEARCH_API_KEY;
    const baseUrl = opts.baseUrl ?? process.env.CAESAR_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
    this.keyed = Boolean(apiKey);
    this.client = new Caesar({ apiKey: apiKey ?? '', baseUrl });
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const extraBody: Record<string, unknown> = {};
    if (options.includeDomains || options.excludeDomains) {
      extraBody.source_policy = {
        ...(options.includeDomains ? { include_domains: options.includeDomains } : {}),
        ...(options.excludeDomains ? { exclude_domains: options.excludeDomains } : {}),
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
      ...(Object.keys(extraBody).length ? { extraBody } : {}),
    });
    const results: SearchResultItem[] = (resp?.results ?? []).map((r: any) => ({
      rank: r.rank, title: r.title, canonicalUrl: r.canonical_url, docId: r.doc_id, snippet: r.snippet,
    }));
    return { searchId: resp?.search_id, results };
  }

  async read(target: string, options: ReadOptions = {}): Promise<ReadResult> {
    const content: Record<string, unknown> = {};
    if (options.selection) content.selection = options.selection;
    if (options.maxChars != null) content.max_chars = options.maxChars;
    const hasContent = Object.keys(content).length > 0;
    if (hasContent) content.format = 'markdown';
    const resp: any = await this.client.read(target, {
      ...(options.query ? { query: options.query } : {}),
      ...(hasContent ? { extraBody: { content } } : {}),
    });
    const passages: ReadPassage[] = (resp?.passages ?? []).map((p: any) => ({ passageId: p.passage_id, text: p.text }));
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
    options: SearchOptions & { readTopN?: number; readMaxChars?: number; selection?: string } = {},
  ): Promise<SearchAndReadResult> {
    const { readTopN = 3, readMaxChars = 8000, selection = 'query_relevant', ...searchOpts } = options;
    const search = await this.search(query, { maxResults: 10, ...searchOpts });
    const toRead = search.results.slice(0, readTopN);
    const reads = await Promise.all(
      toRead.map((r) =>
        this.read(r.canonicalUrl, { selection, maxChars: readMaxChars, query })
          .then((doc) => ({ r, doc })).catch(() => ({ r, doc: null as ReadResult | null })),
      ),
    );
    const byDoc = new Map(reads.map(({ r, doc }) => [r.docId, doc]));
    const citations: Citation[] = [];
    const blocks: string[] = [];
    for (const r of search.results) {
      const doc = byDoc.get(r.docId);
      const passage = doc?.passages?.[0];
      citations.push({
        rank: r.rank, title: r.title, canonicalUrl: r.canonicalUrl, docId: r.docId,
        passageId: passage?.passageId, captureId: doc?.captureId, captureTime: doc?.captureTime, passage: passage?.text, text: doc?.text,
      });
      const body = doc?.text && doc.text.length > 200
        ? doc.text
        : (doc?.passages ?? []).map((p) => p.text).join('\n') || r.snippet || '';
      if (body) blocks.push(`[${r.rank}] ${r.title} — ${r.canonicalUrl}\n${body}`);
    }
    return { evidence: blocks.join('\n\n'), citations, searchId: search.searchId };
  }
}

export function createCaesarClient(opts?: { apiKey?: string; baseUrl?: string }): CaesarClient {
  return new CaesarClient(opts);
}
