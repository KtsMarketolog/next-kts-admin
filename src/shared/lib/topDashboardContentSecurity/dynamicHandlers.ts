import { randomBytes } from 'node:crypto';
import { parse, type Node } from 'acorn';
import { SAXParser } from 'parse5-sax-parser';
import { Token } from 'parse5';
import { BoundedTokenizer } from './inlineSources';

type Ast = Node & Record<string, unknown>;
type Edit = { start: number; end: number; text: string };
type SlotKind = 'string' | 'primitive' | 'key';
type Handler = { id: string; event: string; body: string; source: string; kinds: SlotKind[]; slots: number[] };
export type DynamicHandlerCompilation = {
  html: string;
  transformedHandlers: number;
  unsupportedHandlers: number;
  skippedScripts: number;
};

const MAX_SCRIPT_CHARS = 2 * 1024 * 1024;
const MAX_AST_NODES = 350_000;
const MAX_AST_TOKENS = 500_000;
const MAX_HANDLERS = 2_000;
const MAX_TEMPLATE_CHARS = 128 * 1024;
const MAX_HANDLER_CHARS = 16 * 1024;
const MAX_SCRIPT_MS = 1_000;
const likelyHandler = /\bon[a-z][\w:-]*\s*=/i;
const jsString = (value: string) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

class LocationTokenizer extends BoundedTokenizer {
  private readonly started = performance.now();
  private steps = 0;
  protected _callState(cp: number) {
    if ((++this.steps & 16_383) === 0 && performance.now() - this.started > 3_000) throw new Error('Dynamic handler HTML parse budget');
    super._callState(cp);
  }
  protected _leaveAttrName() {
    if ((this.currentToken as Token.TagToken).attrs.length >= 512) throw new Error('Dynamic handler attribute budget');
    super._leaveAttrName();
  }
}

/** Locations are needed for edits; script/text bodies themselves are never accumulated by SAX. */
class LocationParser extends SAXParser {
  constructor() {
    super({ sourceCodeLocationInfo: true });
    this.tokenizer = new LocationTokenizer({ sourceCodeLocationInfo: true }, this.parserFeedbackSimulator);
    this.parserFeedbackSimulator.tokenizer = this.tokenizer;
  }
  onCharacter() { /* Only tag offsets are consumed. */ }
  onStartTag(token: Token.TagToken) {
    if (token.tagName === 'script') this.parserFeedbackSimulator.skipNextNewLine = false;
    super.onStartTag(token);
  }
}

function editsIn(source: string, start: number, end: number, edits: Edit[]) {
  let result = ''; let cursor = start;
  for (const edit of edits.filter(item => item.start >= start && item.end <= end).sort((a, b) => a.start - b.start)) {
    result += source.slice(cursor, edit.start) + edit.text; cursor = edit.end;
  }
  return result + source.slice(cursor, end);
}

function children(node: Ast) {
  const result: Array<{ node: Ast; key: string }> = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc') continue;
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child === 'object' && typeof child.type === 'string') result.push({ node: child, key });
    } else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') {
      result.push({ node: value as Ast, key });
    }
  }
  return result;
}

function ast(source: string, module = false) {
  const started = performance.now(); let tokens = 0;
  return parse(source, {
    ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowHashBang: true,
    onToken() {
      if ((++tokens & 255) === 0 && (tokens > MAX_AST_TOKENS || performance.now() - started > MAX_SCRIPT_MS)) throw new Error('Dynamic handler parse budget');
    },
  }) as unknown as Ast;
}

function isMarkupConstruction(node: Ast, parents: WeakMap<Ast, Ast>, observedStrings: Set<string>) {
  let current = node;
  for (let depth = 0; depth < 32; depth++) {
    const parent = parents.get(current);
    if (!parent) return false;
    if ((parent.type === 'BinaryExpression' && parent.operator === '+')
      || parent.type === 'ConditionalExpression' || parent.type === 'LogicalExpression' || parent.type === 'TemplateLiteral') { current = parent; continue; }
    if (parent.type === 'ReturnStatement' && parent.argument === current) return true;
    if (parent.type === 'ArrowFunctionExpression' && parent.body === current) return true;
    if (parent.type === 'VariableDeclarator' && parent.init === current) return !observedStrings.has(String((parent.id as Ast).name));
    if (parent.type === 'AssignmentExpression' && parent.right === current) {
      const target = parent.left as Ast;
      if (target.type === 'Identifier') return true;
      if (target.type !== 'MemberExpression' || target.computed) return false;
      return ['innerHTML', 'outerHTML'].includes(String((target.property as Ast).name));
    }
    if (parent.type === 'CallExpression') {
      const callee = parent.callee as Ast;
      if (callee.type !== 'MemberExpression' || callee.computed) return false;
      const name = (callee.property as Ast).name;
      const args = parent.arguments as Ast[];
      return (name === 'insertAdjacentHTML' && args[1] === current)
        || (name === 'createContextualFragment' && args[0] === current);
    }
    return false;
  }
  return false;
}

/** Compile fixed author code only. Substitutions may become values, never JavaScript source. */
function compileBody(source: string, placeholders: string[], valuesName: string) {
  if (!source.trim() || source.length > MAX_HANDLER_CHARS) return null;
  const prefix = '(function(event){';
  let tree: Ast;
  try { tree = ast(prefix + source + '\n})'); } catch { return null; }
  const replacements: Edit[] = [];
  const kinds = new Map<number, SlotKind>();
  const used = new Set<number>();
  let invalid = false;
  const stack: Array<{ node: Ast; parent?: Ast; grandparent?: Ast; key?: string }> = [{ node: tree }];
  const register = (index: number, kind: SlotKind) => {
    if (kinds.has(index) && kinds.get(index) !== kind) invalid = true;
    kinds.set(index, kind); used.add(index);
    return `${valuesName}[${index}]`;
  };
  while (stack.length && !invalid) {
    const { node, parent, grandparent, key } = stack.pop()!;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      const hits = placeholders.flatMap((marker, index) => {
        const found: Array<{ at: number; index: number; marker: string }> = [];
        let at = node.value as string; let offset = 0;
        while (at.includes(marker)) {
          const match = at.indexOf(marker); found.push({ at: offset + match, index, marker });
          offset += match + marker.length; at = at.slice(match + marker.length);
        }
        return found;
      }).sort((a, b) => a.at - b.at);
      if (hits.length) {
        if (parent?.type === 'MemberExpression' && key === 'property') {
          if (!parent.computed || hits.length !== 1 || node.value !== hits[0].marker
            || grandparent?.type !== 'AssignmentExpression' || grandparent.left !== parent) { invalid = true; break; }
          replacements.push({ start: node.start - prefix.length, end: node.end - prefix.length, text: register(hits[0].index, 'key') });
          continue;
        }
        if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition') && key === 'key') { invalid = true; break; }
        const parts: string[] = []; let at = 0;
        for (const hit of hits) {
          parts.push(jsString(node.value.slice(at, hit.at)), register(hit.index, 'string')); at = hit.at + hit.marker.length;
        }
        parts.push(jsString(node.value.slice(at)));
        replacements.push({ start: node.start - prefix.length, end: node.end - prefix.length, text: `(${parts.join('+')})` });
      }
    } else if (node.type === 'Identifier' && typeof node.name === 'string') {
      const included = placeholders.map((marker, index) => ({ marker, index })).filter(({ marker }) => (node.name as string).includes(marker));
      if (included.length) {
        if (parent?.type === 'MemberExpression' && key === 'property' && parent.computed === false) {
          // Turn a dynamic identifier into a validated computed key. It cannot create syntax.
          // Limit this to one whole key in an assignment, not constructed names/callees.
          if (included.length !== 1 || node.name !== included[0].marker || grandparent?.type !== 'AssignmentExpression' || grandparent.left !== parent) { invalid = true; break; }
          const expression = register(included[0].index, 'key');
          const between = source.slice((parent.object as Ast).end - prefix.length, node.start - prefix.length);
          if (between.trim() !== '.') { invalid = true; break; }
          replacements.push({ start: (parent.object as Ast).end - prefix.length, end: node.end - prefix.length, text: `[${expression}]` });
        } else if (included.length === 1 && node.name === included[0].marker && parent
          && ((parent.type === 'CallExpression' && key === 'arguments')
            || (parent.type === 'AssignmentExpression' && key === 'right')
            || (parent.type === 'BinaryExpression' && (key === 'left' || key === 'right'))
            || (parent.type === 'ArrayExpression' && key === 'elements')
            || (parent.type === 'ConditionalExpression' && (key === 'consequent' || key === 'alternate')))) {
          replacements.push({ start: node.start - prefix.length, end: node.end - prefix.length, text: register(included[0].index, 'primitive') });
        } else invalid = true;
      }
    }
    for (const child of children(node)) stack.push({ ...child, parent: node, grandparent: parent });
  }
  for (let index = 0; index < placeholders.length; index++) if (source.includes(placeholders[index]) && !used.has(index)) invalid = true;
  if (invalid) return null;
  const body = editsIn(source, 0, source.length, replacements);
  if (placeholders.some(marker => body.includes(marker))) return null;
  return { body, kinds };
}

function runtimeSource(key: string, attribute: string) {
  // No execution of strings: the only callable code is the server-generated factory table.
  return `(function(){
var KEY=${jsString(key)},ATTR=${jsString(attribute)},defs=new Map(),pending=new Map(),recent=new Map(),weak=new Map(),bound=new WeakMap();
var MAX_PENDING=10000,MAX_PENDING_BYTES=2097152,MAX_RECENT_BYTES=8388608,MAX_VALUE=65536,seq=0,pendingBytes=0,recentBytes=0,selector='',eventAttrs=[],warned=new Set(),notice=null;
var finalizer=typeof FinalizationRegistry==='function'?new FinalizationRegistry(function(token){var ref=weak.get(token);if(ref&&!ref.deref())weak.delete(token);}):null;
var inner=Object.getOwnPropertyDescriptor(Element.prototype,'innerHTML');
var decoder=document.createElement('div');
function noticeUser(){if((notice&&notice.isConnected)||!document.body)return;notice=document.createElement('div');notice.setAttribute('role','status');notice.style.cssText='position:fixed;bottom:12px;right:12px;z-index:2147483647;max-width:420px;padding:10px 14px;border:1px solid #c9bedf;border-radius:8px;background:#fff9e8;color:#423350;font:13px/1.4 sans-serif;box-shadow:0 2px 10px #0002';notice.textContent='Часть действий этого HTML не поддерживается защищённым просмотром. Если кнопка не сработала, сообщите администратору название отчёта и действие.';document.body.appendChild(notice);}
function warn(message,quiet){if(!warned.has(message)){warned.add(message);console.warn('[KTS HTML compatibility] '+message);}if(!quiet)noticeUser();}
addEventListener('securitypolicyviolation',function(event){if(event.effectiveDirective==='script-src-attr')noticeUser();});
addEventListener('beforeprint',function(){if(notice)notice.style.display='none';});addEventListener('afterprint',function(){if(notice)notice.style.display='';});
function decode(value){inner.set.call(decoder,'<i data-kts-value="'+value.replace(/"/g,'&#34;').replace(/</g,'&lt;')+'"></i>');return decoder.firstChild.getAttribute('data-kts-value');}
function value(input,kind){var raw=String(input);if(raw.length>MAX_VALUE)throw Error('argument too large');var text=decode(raw);if(kind==='string')return text;
 if(kind==='key'){if(!/^[A-Za-z_$][\\w$]*$/.test(text)||text==='__proto__'||text==='constructor'||text==='prototype')throw Error('unsafe property');return text;}
 if(text==='true')return true;if(text==='false')return false;if(text==='null')return null;if(text==='undefined')return undefined;
 if(!/^[+-]?(?:(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?|0[xX][\\da-fA-F]+|0[bB][01]+|0[oO][0-7]+)$/.test(text.trim()))throw Error('nonliteral argument');
 var number=Number(text);if(!Number.isFinite(number))throw Error('nonfinite argument');return number;}
function escapeAttr(text){return String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function get(token){var item=pending.get(token)||recent.get(token)||(weak.get(token)&&weak.get(token).deref());if(item&&recent.has(token)){recent.delete(token);recent.set(token,item);}return item;}
function remember(token,item){if(!recent.has(token)){recent.set(token,item);recentBytes+=item.bytes;}while(recent.size>MAX_PENDING||recentBytes>MAX_RECENT_BYTES){var oldest=recent.keys().next().value;recentBytes-=recent.get(oldest).bytes;recent.delete(oldest);}}
function bindElement(el){if(!el||el.nodeType!==1)return;for(var i=0;i<eventAttrs.length;i++){var token=el.getAttribute(eventAttrs[i]);if(!token)continue;
 var item=get(token);if(!item){warn('Expired or unknown handler marker; reload the report.');continue;}
 var name='on'+item.event;if(!(name in el))continue;var prior=bound.get(el);if(!prior){prior=new Map();bound.set(el,prior);}if(prior.get(name)&&prior.get(name).token===token)continue;
 el[name]=item.factory(item.args,el);prior.set(name,{token:token,item:item});remember(token,item);if(pending.has(token)){pending.delete(token);pendingBytes-=item.bytes;if(typeof WeakRef==='function'){weak.set(token,new WeakRef(item));if(finalizer)finalizer.register(item,token);}else {weak.set(token,{deref:function(){return item;}});if(weak.size>MAX_PENDING)weak.delete(weak.keys().next().value);}}
 }}
function bind(root){if(!root||!selector)return;bindElement(root);if(root.querySelectorAll){var nodes=root.querySelectorAll(selector);for(var i=0;i<nodes.length;i++)bindElement(nodes[i]);}}
function descriptor(proto,name){var d=Object.getOwnPropertyDescriptor(proto,name);if(!d||!d.set||!d.configurable)return;Object.defineProperty(proto,name,{configurable:d.configurable,enumerable:d.enumerable,get:d.get,set:function(value){var parent=this.parentNode;d.set.call(this,value);bind(name==='outerHTML'?parent:this);}});}
descriptor(Element.prototype,'innerHTML');descriptor(Element.prototype,'outerHTML');if(typeof ShadowRoot!=='undefined')descriptor(ShadowRoot.prototype,'innerHTML');
var adjacent=Element.prototype.insertAdjacentHTML;Element.prototype.insertAdjacentHTML=function(position,html){var result=adjacent.call(this,position,html);bind(this.parentNode||this);return result;};
var clone=Node.prototype.cloneNode;Node.prototype.cloneNode=function(deep){var result=clone.call(this,deep);bind(result);return result;};
var fragment=Range.prototype.createContextualFragment;Range.prototype.createContextualFragment=function(html){var result=fragment.call(this,html);bind(result);return result;};
var set=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,text){var result=set.call(this,name,text);if(String(name).toLowerCase().indexOf(ATTR+'-')===0)bindElement(this);return result;};
var observer=new MutationObserver(function(records){for(var i=0;i<records.length;i++){var record=records[i];if(record.type==='attributes')bindElement(record.target);else for(var j=0;j<record.addedNodes.length;j++)bind(record.addedNodes[j]);}});
Object.defineProperty(globalThis,KEY,{value:Object.freeze({
 register:function(id,event,factory,kinds,source){if(defs.has(id))throw Error('duplicate handler');defs.set(id,{event:event,factory:factory,kinds:kinds,source:source});var attr=ATTR+'-'+event;if(eventAttrs.indexOf(attr)<0){eventAttrs.push(attr);selector=eventAttrs.map(function(name){return '['+name+']';}).join(',');observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:eventAttrs});}},
 marker:function(id,args){var definition=defs.get(id);if(!definition)return '';try{var captured=args.map(function(arg,index){return value(arg,definition.kinds[index]);});
 var size=args.reduce(function(sum,arg){return sum+String(arg).length*2;},128);if(size>131072)throw Error('arguments too large');
 var bytes=new Uint32Array(4);crypto.getRandomValues(bytes);var token=Array.from(bytes,function(n){return n.toString(16).padStart(8,'0');}).join('')+'-'+(++seq);
 var item={event:definition.event,factory:definition.factory,args:captured,bytes:size};pending.set(token,item);pendingBytes+=size;while(pending.size>MAX_PENDING||pendingBytes>MAX_PENDING_BYTES){var oldest=pending.keys().next().value;pendingBytes-=pending.get(oldest).bytes;pending.delete(oldest);warn('Too many unmounted handlers; an unused marker was discarded.',true);}
 return ATTR+'-'+definition.event+'="'+token+'" data-kts-handler-on'+definition.event+'="'+escapeAttr(definition.source)+'"';
 }catch(error){warn('Unsupported dynamic argument was blocked.');return 'data-kts-handler-unsupported="true"';}}
 }),writable:false,configurable:false});
})();`;
}

function transformScript(source: string, module: boolean, key: string, markerSeed: string, handlers: Handler[], stats: DynamicHandlerCompilation) {
  if (!likelyHandler.test(source) || !source.includes('<')) return source;
  if (source.length > MAX_SCRIPT_CHARS) { stats.skippedScripts++; return source; }
  let tree: Ast;
  try { tree = ast(source, module); } catch { stats.skippedScripts++; return source; }
  const candidates: Ast[] = []; const parents = new WeakMap<Ast, Ast>(); const observedStrings = new Set<string>();
  const stack: Array<{ node: Ast; parent?: Ast }> = [{ node: tree }]; let count = 0;
  while (stack.length) {
    if (++count > MAX_AST_NODES) { stats.skippedScripts++; return source; }
    const { node, parent } = stack.pop()!;
    if (parent) parents.set(node, parent);
    if (node.type === 'Identifier' && parent) {
      const methods = ['includes', 'indexOf', 'lastIndexOf', 'replace', 'replaceAll', 'startsWith', 'endsWith', 'match', 'matchAll', 'search', 'split', 'test', 'exec'];
      if (parent.type === 'BinaryExpression' && parent.operator !== '+') observedStrings.add(String(node.name));
      const call = parent.type === 'CallExpression' ? parent : parent.type === 'MemberExpression' && parent.object === node ? parents.get(parent) : undefined;
      const callee = call?.type === 'CallExpression' ? call.callee as Ast : undefined;
      if (callee?.type === 'MemberExpression' && methods.includes(String((callee.property as Ast).name))) observedStrings.add(String(node.name));
    }
    if ((node.type === 'TemplateLiteral' && parent?.type !== 'TaggedTemplateExpression')
      || (node.type === 'Literal' && typeof node.value === 'string' && parent?.type !== 'Property' && parent?.type !== 'ImportDeclaration')) candidates.push(node);
    for (const { node: child } of children(node)) stack.push({ node: child, parent: node });
  }
  const edits: Edit[] = [];
  for (const node of candidates.sort((a, b) => (a.end - a.start) - (b.end - b.start))) {
    if (!isMarkupConstruction(node, parents, observedStrings)) continue;
    const quasis = node.type === 'TemplateLiteral' ? (node.quasis as Array<{ value: { cooked: string | null } }>).map(item => item.value.cooked) : [node.value as string];
    if (quasis.some(value => value === null)) continue;
    const texts = quasis as string[];
    if (!texts.some(text => likelyHandler.test(text))) continue;
    const expressions = (node.expressions ?? []) as Ast[];
    const placeholders = expressions.map((_, index) => `${markerSeed}SLOT${index}END`);
    const html = texts.map((text, index) => text + (placeholders[index] ?? '')).join('');
    if (html.length > MAX_TEMPLATE_CHARS || !html.includes('<')) continue;
    const attributeEdits: Edit[] = []; let rejected = 0;
    const handlersBefore = handlers.length;
    const parser = new LocationParser();
    parser.on('startTag', token => {
      const location = token.sourceCodeLocation;
      if (!location) return;
      const attributes = token.attrs.filter(attr => /^on[a-z][\w:-]*$/.test(attr.name));
      const raw = html.slice(location.startOffset, location.endOffset);
      if ((raw.match(/\son[a-z][\w:-]*\s*=/gi)?.length ?? 0) !== attributes.length) { rejected += attributes.length; return; }
      for (const attr of attributes) {
        const range = (location as typeof location & { attrs?: Record<string, { startOffset: number; endOffset: number }> }).attrs?.[attr.name];
        if (!range || handlers.length >= MAX_HANDLERS) { rejected++; continue; }
        const valuesName = `${markerSeed}values`;
        const compiled = compileBody(attr.value, placeholders, valuesName);
        if (!compiled) { rejected++; continue; }
        const slots = [...compiled.kinds.keys()].sort((a, b) => a - b);
        const kinds = slots.map(index => compiled.kinds.get(index)!);
        // Make the factory's value indexes dense, independent of other template holes.
        let body = compiled.body;
        for (let i = slots.length - 1; i >= 0; i--) body = body.split(`${valuesName}[${slots[i]}]`).join(`${valuesName}DENSE${i}END`);
        for (let i = 0; i < slots.length; i++) body = body.split(`${valuesName}DENSE${i}END`).join(`${valuesName}[${i}]`);
        const id = `h${handlers.length}`;
        handlers.push({ id, event: attr.name.slice(2), body, source: attr.value, kinds, slots });
        const args = slots.map(index => `String(${editsIn(source, expressions[index].start, expressions[index].end, edits)})`);
        attributeEdits.push({ start: range.startOffset, end: range.endOffset, text: `\u0000${key}.marker(${jsString(id)},[${args.join(',')}])\u0000` });
      }
    });
    try { parser.end(html); } catch { handlers.length = handlersBefore; stats.skippedScripts++; continue; }
    stats.unsupportedHandlers += rejected;
    if (!attributeEdits.length) continue;
    const patched = editsIn(html, 0, html.length, attributeEdits);
    // Literal HTML and original expression holes retain their original evaluation order.
    const pieces: string[] = []; let at = 0;
    const pattern = new RegExp(`\\u0000([^\\u0000]+)\\u0000|(${markerSeed}SLOT(\\d+)END)`, 'g');
    for (const match of patched.matchAll(pattern)) {
      pieces.push(jsString(patched.slice(at, match.index)));
      if (match[1]) pieces.push(`globalThis.${match[1]}`);
      else {
        const expression = expressions[Number(match[3])];
        pieces.push(`String(${editsIn(source, expression.start, expression.end, edits)})`);
      }
      at = match.index! + match[0].length;
    }
    pieces.push(jsString(patched.slice(at)));
    for (let index = edits.length - 1; index >= 0; index--) if (edits[index].start >= node.start && edits[index].end <= node.end) edits.splice(index, 1);
    edits.push({ start: node.start, end: node.end, text: `(${pieces.join('+')})` });
  }
  return editsIn(source, 0, source.length, edits);
}

export function compileTopDashboardDynamicHandlers(html: string): DynamicHandlerCompilation {
  const stats: DynamicHandlerCompilation = { html, transformedHandlers: 0, unsupportedHandlers: 0, skippedScripts: 0 };
  if (!likelyHandler.test(html)) return stats;
  const seed = randomBytes(12).toString('hex');
  const key = `__ktsDynamic${seed}`;
  const markerSeed = `KTS${seed}X`;
  const attribute = `data-kts-bound-${seed}`;
  const edits: Edit[] = []; const handlers: Handler[] = [];
  const parser = new LocationParser();
  let script: { start: number; contentStart: number; module: boolean } | null = null;
  let runtimeAt: number | null = null;
  let templateDepth = 0;
  parser.on('startTag', token => {
    if (token.tagName === 'template') templateDepth++;
    if (token.tagName !== 'script' || !token.sourceCodeLocation) return;
    if (templateDepth) return;
    const type = token.attrs.find(attr => attr.name === 'type')?.value.trim().toLowerCase() ?? '';
    if (token.attrs.some(attr => attr.name === 'src') || !['', 'module', 'text/javascript', 'application/javascript'].includes(type)) { script = null; return; }
    script = { start: token.sourceCodeLocation.startOffset, contentStart: token.sourceCodeLocation.endOffset, module: type === 'module' };
  });
  parser.on('endTag', token => {
    if (token.tagName === 'template') templateDepth = Math.max(0, templateDepth - 1);
    if (token.tagName !== 'script' || !script || !token.sourceCodeLocation) return;
    const original = html.slice(script.contentStart, token.sourceCodeLocation.startOffset);
    const before = handlers.length;
    const transformed = transformScript(original, script.module, key, markerSeed, handlers, stats);
    if (transformed !== original) {
      runtimeAt ??= script.start;
      const definitions = handlers.slice(before).map(handler => `globalThis.${key}.register(${jsString(handler.id)},${jsString(handler.event)},function(${markerSeed}values,${markerSeed}element){with(${markerSeed}element.ownerDocument||document){with(${markerSeed}element.form||{}){with(${markerSeed}element){return function(event){${handler.body}\n};}}}},${JSON.stringify(handler.kinds)},${jsString(handler.source)});`).join('\n');
      edits.push({ start: script.start, end: script.start, text: `<script>${definitions.replace(/<\/script/gi, '<\\/script')}</script>` });
      edits.push({ start: script.contentStart, end: token.sourceCodeLocation.startOffset, text: transformed });
    }
    script = null;
  });
  try { parser.end(html); } catch { return { html, transformedHandlers: 0, unsupportedHandlers: 0, skippedScripts: stats.skippedScripts + 1 }; }
  if (runtimeAt !== null) {
    const runtime = `<script>${runtimeSource(key, attribute)}</script>`;
    // Same-position edits are stable: runtime must precede factory registration.
    edits.unshift({ start: runtimeAt, end: runtimeAt, text: runtime });
    stats.html = editsIn(html, 0, html.length, edits);
    stats.transformedHandlers = handlers.length;
  }
  return stats;
}

export function transformTopDashboardDynamicHandlers(html: string) {
  return compileTopDashboardDynamicHandlers(html).html;
}
