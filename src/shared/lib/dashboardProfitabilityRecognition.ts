import { Token } from 'parse5';
import { SAXParser } from 'parse5-sax-parser';
import { performance } from 'node:perf_hooks';
import { BoundedTokenizer } from './topDashboardContentSecurity/inlineSources';

const TIME_BUDGET_MS = 2_000;
const CHECK_INTERVAL = 16_384;

export class ProfitabilityHtmlAnalysisLimitError extends Error {
  constructor() {
    super('HTML слишком сложен для безопасной проверки. Проверьте незакрытые теги и повторите загрузку.');
    this.name = 'ProfitabilityHtmlAnalysisLimitError';
  }
}

class AnalysisBudget {
  private readonly started = performance.now();
  check() {
    if (performance.now() - this.started >= TIME_BUDGET_MS) throw new ProfitabilityHtmlAnalysisLimitError();
  }
}

/** The prefix is intentionally conventional: never insert inside author code or an attribute. */
function headEnd(html: string, budget: AnalysisBudget): number | null {
  let position = 0;
  const skipSpace = () => {
    for (;;) {
      while (position < html.length && /\s/.test(html[position])) {
        if (position % CHECK_INTERVAL === 0) budget.check();
        position++;
      }
      if (!html.startsWith('<!--', position)) return true;
      const end = html.indexOf('-->', position + 4);
      budget.check();
      if (end < 0) return false;
      position = end + 3;
    }
  };
  const tag = (name: string) => {
    if (html.slice(position, position + name.length + 1).toLowerCase() !== '<' + name) return false;
    const boundary = html[position + name.length + 1];
    if (boundary !== '>' && !/\s/.test(boundary ?? '')) return false;
    let quote = '';
    for (let cursor = position + name.length + 1; cursor < html.length; cursor++) {
      if (cursor % CHECK_INTERVAL === 0) budget.check();
      const character = html[cursor];
      if (quote) { if (character === quote) quote = ''; }
      else if (character === '"' || character === "'") quote = character;
      else if (character === '<') return false;
      else if (character === '>') { position = cursor + 1; return true; }
    }
    return false;
  };
  if (!skipSpace()) return null;
  if (html.slice(position, position + 9).toLowerCase() === '<!doctype') {
    if (!tag('!doctype') || !skipSpace()) return null;
  }
  if (html.slice(position, position + 5).toLowerCase() === '<html') {
    if (!tag('html') || !skipSpace()) return null;
  }
  return tag('head') ? position : null;
}

/**
 * Keep original UTF-16 source offsets (including CRLF and surrogate pairs) for
 * the reviewed-script fingerprint and insertion. Enabling parse5's full source
 * locations would disable the bounded tokenizer's linear attribute-name index.
 */
class RecognitionTokenizer extends BoundedTokenizer {
  private steps = 0;
  constructor(private readonly budget: AnalysisBudget, handler: ConstructorParameters<typeof BoundedTokenizer>[1]) {
    super({ sourceCodeLocationInfo: false }, handler);
  }
  protected getCurrentLocation(offset: number): Token.Location {
    return { startLine: 0, startCol: 0, startOffset: this.preprocessor.offset - offset,
      endLine: -1, endCol: -1, endOffset: -1 };
  }
  protected _callState(cp: number) {
    if (++this.steps >= CHECK_INTERVAL) { this.steps = 0; this.budget.check(); }
    super._callState(cp);
  }
}

class RecognitionParser extends SAXParser {
  constructor(budget: AnalysisBudget) {
    super({ sourceCodeLocationInfo: false });
    this.tokenizer = new RecognitionTokenizer(budget, this.parserFeedbackSimulator);
    this.parserFeedbackSimulator.tokenizer = this.tokenizer;
  }
  parse(html: string) {
    // Calling the tokenizer directly keeps deadline errors synchronous instead
    // of converting them into a later Transform-stream error event.
    this.tokenizer.write(html, true);
  }
  onCharacter() {
    // Recognition uses original source spans, not decoded text. Do not let SAX
    // concatenate embedded stock/base64 text into another copy of the document.
  }
  onStartTag(token: Token.TagToken) {
    if (token.tagName === 'script') this.parserFeedbackSimulator.skipNextNewLine = false;
    super.onStartTag(token);
  }
}

export type ProfitabilityScriptSpan = { start: number; contentStart: number; contentEnd: number; end: number };

export function scanProfitabilityHtml(html: string, onScript: (span: ProfitabilityScriptSpan) => void) {
  const budget = new AnalysisBudget();
  const insertAt = headEnd(html, budget);
  let inHead = false;
  let declarations = 0;
  let supported = false;
  let script: { start: number; contentStart: number } | null = null;
  const inert: string[] = [];
  const inertNames = new Set(['script', 'style', 'textarea', 'title', 'noscript', 'template', 'svg', 'math', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
  const parser = new RecognitionParser(budget);
  parser.on('startTag', ({ tagName, attrs, selfClosing, sourceCodeLocation }) => {
    budget.check();
    const location = sourceCodeLocation!;
    const previouslyInert = inert.length > 0;
    if (inertNames.has(tagName) && !(selfClosing && (tagName === 'svg' || tagName === 'math'))) inert.push(tagName);
    if (tagName === 'head' && !previouslyInert) inHead = location.endOffset === insertAt;
    if (tagName === 'body' && !previouslyInert) inHead = false;
    if (tagName === 'meta' && inHead && !previouslyInert) {
      const name = attrs.find(attribute => attribute.name === 'name')?.value;
      if (name === 'kts-dashboard-audit') {
        declarations++;
        supported = attrs.find(attribute => attribute.name === 'content')?.value === 'invoice-v1';
      }
    }
    if (tagName === 'script') {
      const opening = html.slice(location.startOffset, location.endOffset);
      script = !previouslyInert && /^<script\s*>$/i.test(opening)
        ? { start: location.startOffset, contentStart: location.endOffset } : null;
    }
  });
  parser.on('endTag', ({ tagName, sourceCodeLocation }) => {
    budget.check();
    const location = sourceCodeLocation!;
    if (tagName === 'script' && script) {
      if (/^<\/script\s*>$/i.test(html.slice(location.startOffset, location.endOffset))) {
        onScript({ ...script, contentEnd: location.startOffset, end: location.endOffset });
      }
      script = null;
    }
    if (tagName === 'head' && !inert.length) inHead = false;
    if (inert.at(-1) === tagName) inert.pop();
  });
  parser.parse(html);
  budget.check();
  return { headEnd: insertAt, declaresInvoiceAudit: insertAt !== null && declarations === 1 && supported
    && html.includes('kts-dashboard-audit') };
}

/** Same conservative privacy marker as before, but each >-delimited span is visited once. */
export function hasProfitabilityInvoiceInput(html: string): boolean {
  const budget = new AnalysisBudget();
  const opening = /<input\b/gi;
  for (let match = opening.exec(html); match; match = opening.exec(html)) {
    budget.check();
    const end = html.indexOf('>', opening.lastIndex);
    const attributesEnd = end < 0 ? html.length : end;
    if (/\bid\s*=\s*(["'])fInv\1/i.test(html.slice(opening.lastIndex, attributesEnd))) return true;
    if (end < 0) return false;
    opening.lastIndex = end + 1;
  }
  budget.check();
  return false;
}
