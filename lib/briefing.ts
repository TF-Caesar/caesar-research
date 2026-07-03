import pc from 'picocolors';
import type { Citation } from './caesar.js';
import { summarize, formatSources } from './research.js';

/**
 * Pure rendering of the research briefing to a colored string. Keeping this
 * separate from cli.ts keeps the I/O thin and the formatting testable.
 */

export interface BriefingInput {
  question: string;
  citations: Citation[];
  /** Optional LLM narrative; when present it replaces the deterministic summary. */
  narrative?: string | null;
  /** Clock for the relative receipt line; injectable so rendering stays pure in tests. */
  now?: number;
}

function rule(): string {
  return pc.dim('─'.repeat(60));
}

/**
 * Compact relative age for provenance stamps: "just now", "7m ago", "3h ago",
 * "2d ago". Returns undefined for unparseable input: a stamp must never
 * fabricate a time. Future timestamps (clock skew) clamp to "just now".
 */
export function relativeTime(iso: string, now: number = Date.now()): string | undefined {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Receipt stat line for the briefing: "<N> sources read · newest capture
 * <relative>". The newest-capture clause comes from real capturedISO values and
 * is omitted entirely when none parse: the receipt never fabricates a time.
 * Returns undefined when nothing was read.
 */
export function receiptLine(sources: { capturedISO?: string }[], now: number = Date.now()): string | undefined {
  if (sources.length === 0) return undefined;
  const label = `${sources.length} ${sources.length === 1 ? 'source' : 'sources'} read`;
  let newest = -Infinity;
  for (const s of sources) {
    const t = s.capturedISO ? Date.parse(s.capturedISO) : NaN;
    if (!Number.isNaN(t) && t > newest) newest = t;
  }
  if (newest === -Infinity) return label;
  const rel = relativeTime(new Date(newest).toISOString(), now);
  return rel ? `${label} · newest capture ${rel}` : label;
}

/**
 * Date part of a best-effort publish time. Undefined when absent or
 * unparseable, so the line falls back to the captured-only stamp.
 */
function publishedDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString().slice(0, 10);
}

export function renderBriefing({ question, citations, narrative, now = Date.now() }: BriefingInput): string {
  const out: string[] = [];

  out.push('');
  out.push(pc.bold(pc.green('CAESAR RESEARCH')) + pc.dim('  ·  evidence-grounded briefing'));
  out.push(rule());
  out.push(pc.bold('Question'));
  out.push('  ' + question);
  out.push('');

  if (narrative) {
    out.push(pc.bold('Answer') + pc.dim('  (synthesized from the sources below)'));
    for (const line of wrap(narrative, 76)) out.push('  ' + line);
  } else {
    out.push(pc.bold('Summary') + pc.dim('  (most relevant evidence, extracted)'));
    const sentences = summarize(citations, question, 4);
    if (sentences.length === 0) {
      out.push('  ' + pc.dim('No source sentence clearly addressed the question. See sources below.'));
    } else {
      for (const s of sentences) {
        // Inline [n] matches the numbering of the Sources list below.
        for (const line of wrap('• ' + s.text + ' ' + pc.dim(`[${s.sourceIndex}]`), 76)) out.push('  ' + line);
      }
    }
  }

  out.push('');
  out.push(pc.bold('Sources'));
  const sources = formatSources(citations);
  if (sources.length === 0) {
    out.push('  ' + pc.dim('No sources were read.'));
  } else {
    for (const s of sources) {
      const captured = s.capturedISO ? `captured ${s.capturedISO}` : 'captured (time unavailable)';
      const published = publishedDate(s.publishedAt);
      const stamp = published ? `published ${published} · ${captured}` : captured;
      out.push('  ' + pc.green(`[${s.index}]`) + ' ' + pc.bold(s.title));
      out.push('      ' + pc.cyan(s.url));
      out.push('      ' + pc.dim(stamp));
    }
    const receipt = receiptLine(sources, now);
    if (receipt) {
      out.push('');
      out.push('  ' + pc.dim(receipt));
    }
  }

  out.push(rule());
  out.push(pc.dim('Powered by Caesar search — free, no signup.'));
  out.push('');
  return out.join('\n');
}

/** Simple word wrap. */
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width && line) {
      lines.push(line);
      line = '';
    }
    line = line ? line + ' ' + w : w;
  }
  if (line) lines.push(line);
  return lines;
}
