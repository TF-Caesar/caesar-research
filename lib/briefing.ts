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
}

function rule(): string {
  return pc.dim('─'.repeat(60));
}

export function renderBriefing({ question, citations, narrative }: BriefingInput): string {
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
        for (const line of wrap('• ' + s, 76)) out.push('  ' + line);
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
      const captured = s.capturedISO
        ? pc.dim(`captured ${s.capturedISO}`)
        : pc.dim('captured (time unavailable)');
      out.push('  ' + pc.green(`[${s.index}]`) + ' ' + pc.bold(s.title));
      out.push('      ' + pc.cyan(s.url));
      out.push('      ' + captured);
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
