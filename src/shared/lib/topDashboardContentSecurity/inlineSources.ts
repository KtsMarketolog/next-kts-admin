import { createHash, type Hash } from 'crypto';
import { ErrorCodes, Token, Tokenizer } from 'parse5';
import { SAXParser } from 'parse5-sax-parser';

const TOKEN_CHUNK_LENGTH = 16_384;
const VALUE_CHUNK_LENGTH = 65_536;
const NAME_COMPACTION_LENGTH = 524_288;

// Joining two nonempty strings materializes a flat string in the supported Node
// runtime. The sentinel is removed without changing even lone UTF-16 surrogates.
// Avoid a Buffer round-trip: large external allocations can delay collection.
function flatten(value: string) {
  return [value, '\0'].join('').slice(0, -1);
}

/**
 * parse5 8.0.1 builds unfinished token strings one character at a time. A single
 * large base64 asset otherwise creates hundreds of MiB of V8 string ropes.
 * These hooks change storage/emission boundaries only, not HTML tokenization.
 * Keep both parse5 dependencies pinned and retain the large-input regressions
 * when upgrading them: the protected hooks are deliberately version-specific.
 */
export class BoundedTokenizer extends Tokenizer {
  private inputSteps = 0;
  private attributeActive = false;
  private readonly valueChunks = new WeakMap<Token.Attribute | Token.CommentToken, string[]>();
  private readonly compactedLengths = new WeakMap<object, Record<string, number>>();
  private readonly attributeNames = new WeakMap<Token.TagToken, Set<string>>();

  protected _appendCharToCurrentCharacterToken(type: Token.CharacterToken['type'], text: string) {
    if ((this.currentCharacterToken?.chars.length ?? 0) >= TOKEN_CHUNK_LENGTH) {
      this._emitCurrentCharacterToken(null);
    }
    super._appendCharToCurrentCharacterToken(type, text);
  }

  private chunkValue<T extends Token.Attribute | Token.CommentToken>(token: T, key: 'value' | 'data') {
    const field = token as unknown as Record<string, string>;
    const value = field[key];
    if (value.length < VALUE_CHUNK_LENGTH) return;
    const chunks = this.valueChunks.get(token) ?? [];
    chunks.push(flatten(value));
    this.valueChunks.set(token, chunks);
    field[key] = '';
  }

  private restoreValue(token: Token.Attribute | Token.CommentToken, key: 'value' | 'data') {
    const chunks = this.valueChunks.get(token);
    if (!chunks) return;
    const field = token as unknown as Record<string, string>;
    chunks.push(field[key]);
    field[key] = chunks.join('');
    this.valueChunks.delete(token);
  }

  private compact<T extends object, K extends keyof T>(token: T, key: K) {
    const value = token[key];
    if (typeof value !== 'string' || value.length < NAME_COMPACTION_LENGTH) return;
    let lengths = this.compactedLengths.get(token);
    if (value.length - (lengths?.[String(key)] ?? 0) < NAME_COMPACTION_LENGTH) return;
    token[key] = flatten(value) as T[K];
    if (!lengths) {
      lengths = {};
      this.compactedLengths.set(token, lengths);
    }
    lengths[String(key)] = value.length;
  }

  protected _callState(cp: number) {
    super._callState(cp);
    if (++this.inputSteps < TOKEN_CHUNK_LENGTH) return;
    this.inputSteps = 0;
    // Attribute values and comment data are append-only in the pinned parser.
    // Restore them before consumers can see the completed token. Never chunk
    // names: the tokenizer compares names while recognizing tags/duplicates.
    if (this.attributeActive) {
      this.chunkValue(this.currentAttr, 'value');
      this.compact(this.currentAttr, 'name');
    }
    const token = this.currentToken;
    if (token?.type === Token.TokenType.COMMENT) this.chunkValue(token, 'data');
    else if (token?.type === Token.TokenType.START_TAG || token?.type === Token.TokenType.END_TAG) {
      this.compact(token, 'tagName');
    } else if (token?.type === Token.TokenType.DOCTYPE) {
      this.compact(token, 'name');
      this.compact(token, 'publicId');
      this.compact(token, 'systemId');
    }
  }

  protected _createAttr(firstCharacter: string) {
    // Also covers malformed adjacent attributes lacking whitespace, where the
    // normal _leaveAttrValue hook is not called by parse5.
    this.restoreValue(this.currentAttr, 'value');
    super._createAttr(firstCharacter);
    this.attributeActive = true;
  }

  protected _leaveAttrName() {
    // parse5 8.0.1 scans all earlier attributes for every name: a single tag
    // with many distinct data-* attributes becomes quadratic. This equivalent
    // no-location fast path keeps the original first-wins/error behavior while
    // indexing names once. Keep upstream's location bookkeeping if ever enabled.
    if (this.options.sourceCodeLocationInfo) return super._leaveAttrName();
    const token = this.currentToken as Token.TagToken;
    let names = this.attributeNames.get(token);
    if (!names) {
      names = new Set<string>();
      this.attributeNames.set(token, names);
    }
    if (names.has(this.currentAttr.name)) {
      this._err(ErrorCodes.duplicateAttribute);
    } else {
      names.add(this.currentAttr.name);
      token.attrs.push(this.currentAttr);
    }
  }

  protected emitCurrentTagToken() {
    this.restoreValue(this.currentAttr, 'value');
    this.attributeActive = false;
    super.emitCurrentTagToken();
  }

  protected emitCurrentComment(token: Token.CommentToken) {
    this.restoreValue(token, 'data');
    super.emitCurrentComment(token);
  }
}

class InlineSourceParser extends SAXParser {
  constructor() {
    super({ sourceCodeLocationInfo: false });
    this.tokenizer = new BoundedTokenizer({ sourceCodeLocationInfo: false }, this.parserFeedbackSimulator);
    this.parserFeedbackSimulator.tokenizer = this.tokenizer;
  }

  onStartTag(token: Token.TagToken) {
    // SAX's PRE newline flag leaks into an immediately following SCRIPT. A
    // script's leading newline is part of its browser CSP hash, never stripped.
    if (token.tagName === 'script') this.parserFeedbackSimulator.skipNextNewLine = false;
    super.onStartTag(token);
  }
}

export function collectTopDashboardInlineHashes(html: string) {
  const scriptHashes = new Set<string>();
  const eventHandlerHashes = new Set<string>();
  let script: Hash | null = null;
  // Hash browser token values: literal CR/CRLF normalize before references are
  // decoded exactly once; do not trim or renormalize encoded &#13;. Script text
  // keeps raw entities. Markup-looking text in comments/raw-text is not a tag.
  const parser = new InlineSourceParser();
  parser.on('startTag', ({ tagName, attrs }) => {
    for (const { name, value } of attrs) {
      if (/^on[a-z][\w:-]*$/.test(name)) {
        eventHandlerHashes.add(`'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`);
      }
    }
    if (tagName === 'script') script = createHash('sha256');
  });
  parser.on('text', ({ text }) => { script?.update(text, 'utf8'); });
  parser.on('endTag', ({ tagName }) => {
    if (tagName === 'script' && script) {
      scriptHashes.add(`'sha256-${script.digest('base64')}'`);
      script = null;
    }
  });
  // The pinned SAX implementation consumes this synchronously, including EOF.
  // Internal token boundaries bound memory; writing small input chunks alone
  // does not flush unfinished tokens and increases buffer-copying overhead.
  parser.end(html);
  return { scriptHashes: Array.from(scriptHashes), eventHandlerHashes: Array.from(eventHandlerHashes) };
}
