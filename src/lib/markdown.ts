/**
 * Minimal markdown parser for AI-generated SOAP note content.
 *
 * Supports exactly the constructs the SOAP pipeline emits — `**bold**`,
 * `-`/`*` bullets, `#`/`##` headers, and numbered lists — and nothing else.
 * In-house on purpose: react-native-markdown-display is unmaintained and has
 * peer-dep friction with React 19, and we only need these four constructs.
 *
 * Pure module (no react-native imports) so the node:test harness can load it.
 * Rendering lives in src/components/MarkdownText.tsx.
 */

export interface MarkdownSpan {
  text: string;
  bold: boolean;
}

export type MarkdownBlock =
  | { type: 'paragraph'; spans: MarkdownSpan[] }
  | { type: 'header'; level: 1 | 2; spans: MarkdownSpan[] }
  | { type: 'bullet'; spans: MarkdownSpan[] }
  | { type: 'numbered'; marker: string; spans: MarkdownSpan[] };

const HEADER_RE = /^(#{1,6})\s+(.*)$/;
// Marker must be followed by whitespace, so a line starting with `**bold**`
// is never mistaken for a `*` bullet.
const BULLET_RE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_RE = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const BOLD_RE = /\*\*(.+?)\*\*/g;

/** Split inline text into plain/bold spans. Unpaired `**` stays literal. */
export function parseSpans(text: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let lastIndex = 0;
  BOLD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = BOLD_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      spans.push({ text: text.slice(lastIndex, match.index), bold: false });
    }
    spans.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    spans.push({ text: text.slice(lastIndex), bold: false });
  }
  if (spans.length === 0) {
    spans.push({ text: '', bold: false });
  }
  return spans;
}

/**
 * Parse markdown-ish text into render blocks. Consecutive plain lines merge
 * into one paragraph (newlines preserved inside it); blank lines separate
 * paragraphs. Never throws on string input — but callers still wrap in
 * try/catch and fall back to raw text, because a render-path crash is worse
 * than visible `**`.
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const input = typeof text === 'string' ? text : String(text ?? '');
  const blocks: MarkdownBlock[] = [];
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length > 0) {
      blocks.push({ type: 'paragraph', spans: parseSpans(paragraphLines.join('\n')) });
      paragraphLines = [];
    }
  };

  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    const header = HEADER_RE.exec(line);
    if (header) {
      flushParagraph();
      blocks.push({
        type: 'header',
        level: header[1].length === 1 ? 1 : 2,
        spans: parseSpans(header[2]),
      });
      continue;
    }

    const numbered = NUMBERED_RE.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: 'numbered', marker: `${numbered[1]}.`, spans: parseSpans(numbered[2]) });
      continue;
    }

    const bullet = BULLET_RE.exec(line);
    if (bullet) {
      flushParagraph();
      blocks.push({ type: 'bullet', spans: parseSpans(bullet[1]) });
      continue;
    }

    paragraphLines.push(line);
  }
  flushParagraph();

  return blocks;
}

/**
 * Strip markdown markers for clipboard/export so pasted notes don't carry
 * `**` or `#`. Preserves the original line structure (including blank lines);
 * bullets normalize to `- `, numbered markers stay as written.
 */
export function toPlainText(text: string): string {
  const input = typeof text === 'string' ? text : String(text ?? '');
  try {
    return input
      .split(/\r?\n/)
      .map((rawLine) => {
        let line = rawLine.replace(HEADER_RE, '$2');
        // Single `*` bullet → `- ` (whitespace after the marker required, so
        // leading `**bold**` is untouched).
        line = line.replace(/^(\s*)\*\s+/, '$1- ');
        line = line.replace(BOLD_RE, '$1');
        return line;
      })
      .join('\n');
  } catch {
    return input;
  }
}
