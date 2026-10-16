// i18n consistency checker.
//
//   npx tsx scripts/check-i18n.ts [--keys-only | --scan-only] [--verbose]
//
// 1. Every locale has exactly the key set of the merged English dictionary (core + ui/feel/flow
//    fragments), no empty values, and every English plural family provides all CLDR categories.
// 2. Every translation uses the same {placeholder} set as English (plural _zero/_one/_two
//    variants may spell the number out and omit {count}).
// 3. Scans src/client/**/*.ts (except the locale files) for hardcoded user-facing strings:
//    assignments to textContent/innerText/innerHTML/outerHTML/placeholder/title/alt,
//    setAttribute('title'|'placeholder'|'aria-label'|'alt', ...) and alert/confirm/prompt calls
//    with literal text. A line containing `i18n-ignore` (or a comment line with it directly
//    above) is exempt.
//
// Exits 1 when anything is reported, 0 otherwise. The checks are exported for tests.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTIONARIES, LANGUAGES } from '../src/client/i18n/index';
import { en } from '../src/client/i18n/locales/en';

// ============================================================================
// Key and placeholder checks
// ============================================================================

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

type StringDict = Readonly<Partial<Record<string, string>>>;

/** Sorted, de-duplicated `{name}` placeholders of a template string. */
export function extractPlaceholders(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\{(\w+)\}/g)) names.add(m[1]);
  return [...names].sort();
}

/** Keys of `reference` missing from `locale`, and keys of `locale` unknown to `reference`. */
export function compareKeys(reference: StringDict, locale: StringDict): { missing: string[]; extra: string[] } {
  const missing = Object.keys(reference).filter((k) => !Object.hasOwn(locale, k));
  const extra = Object.keys(locale).filter((k) => !Object.hasOwn(reference, k));
  return { missing, extra };
}

/** Keys whose translation is empty or whitespace only. */
export function emptyValues(locale: StringDict): string[] {
  return Object.keys(locale).filter((k) => {
    const v = locale[k];
    return typeof v !== 'string' || v.trim() === '';
  });
}

export interface PlaceholderMismatch {
  key: string;
  expected: string[];
  actual: string[];
}

/** Plural variants that may spell the number out ("قتيلان", "one kill") and drop {count}. */
function countOptional(key: string): boolean {
  return /_(zero|one|two)$/.test(key);
}

/** Translations whose placeholder set differs from the reference (English) text. */
export function comparePlaceholders(reference: StringDict, locale: StringDict): PlaceholderMismatch[] {
  const out: PlaceholderMismatch[] = [];
  for (const key of Object.keys(locale)) {
    const ref = reference[key];
    const tr = locale[key];
    if (typeof ref !== 'string' || typeof tr !== 'string') continue;
    const expected = extractPlaceholders(ref);
    const actual = extractPlaceholders(tr);
    const want = countOptional(key) && !actual.includes('count') ? expected.filter((p) => p !== 'count') : expected;
    if (want.length !== actual.length || want.some((p, i) => p !== actual[i])) {
      out.push({ key, expected, actual });
    }
  }
  return out;
}

/** English plural families (stems with an `_other` key) that lack some CLDR category variants. */
export function incompletePluralFamilies(reference: StringDict): { stem: string; missing: string[] }[] {
  const out: { stem: string; missing: string[] }[] = [];
  for (const key of Object.keys(reference)) {
    if (!key.endsWith('_other')) continue;
    const stem = key.slice(0, -'_other'.length);
    const missing = PLURAL_CATEGORIES.filter((c) => !Object.hasOwn(reference, `${stem}_${c}`));
    if (missing.length > 0) out.push({ stem, missing });
  }
  return out;
}

// ============================================================================
// Hardcoded-string scanner
// ============================================================================

type Tok =
  | { k: 'id'; v: string; line: number }
  | { k: 'p'; v: string; line: number }
  | { k: 'str'; v: string; line: number }
  | { k: 'tpl'; quasis: string[]; exprs: Tok[][]; line: number }
  | { k: 'num'; line: number }
  | { k: 're'; line: number };

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '**', '<<', '>>',
];
const REGEX_AFTER_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[\w$\u0080-￿]/;

/**
 * Minimal TypeScript tokenizer: identifiers, punctuators, decoded string literals, template
 * literals (static parts + tokenized `${}` expressions), numbers and regex literals; comments are
 * dropped. Good enough to find assignment sinks reliably without a full parser.
 */
class Lexer {
  private pos = 0;
  line = 1;
  constructor(private readonly src: string) {}

  tokenize(): Tok[] {
    return this.lexUntil(false);
  }

  private lexUntil(closeOnBrace: boolean): Tok[] {
    const src = this.src;
    const out: Tok[] = [];
    let braceDepth = 0;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\n') { this.line++; this.pos++; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '﻿') { this.pos++; continue; }
      if (c === '/' && src[this.pos + 1] === '/') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++;
        continue;
      }
      if (c === '/' && src[this.pos + 1] === '*') {
        const end = src.indexOf('*/', this.pos + 2);
        const stop = end < 0 ? src.length : end + 2;
        for (let i = this.pos; i < stop; i++) if (src[i] === '\n') this.line++;
        this.pos = stop;
        continue;
      }
      if (c === '"' || c === "'") { out.push(this.readString(c)); continue; }
      if (c === '`') { out.push(this.readTemplate()); continue; }
      if (c === '/' && regexAllowed(out[out.length - 1])) { out.push(this.readRegex()); continue; }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[this.pos + 1] ?? ''))) {
        const m = /^(?:0[xXoObB][\da-fA-F_]+n?|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?n?)/.exec(src.slice(this.pos, this.pos + 64));
        this.pos += m && m[0].length > 0 ? m[0].length : 1;
        out.push({ k: 'num', line: this.line });
        continue;
      }
      if (ID_START.test(c)) {
        const start = this.pos;
        this.pos++;
        while (this.pos < src.length && ID_PART.test(src[this.pos])) this.pos++;
        out.push({ k: 'id', v: src.slice(start, this.pos), line: this.line });
        continue;
      }
      if (c === '{') braceDepth++;
      if (c === '}') {
        if (braceDepth === 0 && closeOnBrace) { this.pos++; return out; }
        braceDepth--;
      }
      const punct = PUNCTUATORS.find((p) => src.startsWith(p, this.pos)) ?? c;
      out.push({ k: 'p', v: punct, line: this.line });
      this.pos += punct.length;
    }
    return out;
  }

  /** Reads one escape sequence (after the backslash) and returns its decoded text. */
  private readEscape(): string {
    const src = this.src;
    const c = src[this.pos++] ?? '';
    switch (c) {
      case 'n': case 'r': case 't': case 'b': case 'f': case 'v': case '0': return ' ';
      case '\r': if (src[this.pos] === '\n') this.pos++; this.line++; return '';
      case '\n': this.line++; return '';
      case 'x': {
        const hex = src.slice(this.pos, this.pos + 2);
        this.pos += 2;
        return String.fromCharCode(parseInt(hex, 16) || 0);
      }
      case 'u': {
        let hex: string;
        if (src[this.pos] === '{') {
          const end = src.indexOf('}', this.pos);
          hex = src.slice(this.pos + 1, end < 0 ? this.pos + 1 : end);
          this.pos = end < 0 ? this.pos + 1 : end + 1;
        } else {
          hex = src.slice(this.pos, this.pos + 4);
          this.pos += 4;
        }
        const code = parseInt(hex, 16);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : '';
      }
      default: return c;
    }
  }

  private readString(quote: string): Tok {
    const src = this.src;
    const line = this.line;
    let v = '';
    this.pos++;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === quote) { this.pos++; break; }
      if (c === '\n') break; // unterminated literal: stop at the line end
      if (c === '\\') { this.pos++; v += this.readEscape(); continue; }
      v += c;
      this.pos++;
    }
    return { k: 'str', v, line };
  }

  private readTemplate(): Tok {
    const src = this.src;
    const line = this.line;
    const quasis: string[] = [];
    const exprs: Tok[][] = [];
    let cur = '';
    this.pos++;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '`') { this.pos++; break; }
      if (c === '\\') { this.pos++; cur += this.readEscape(); continue; }
      if (c === '$' && src[this.pos + 1] === '{') {
        this.pos += 2;
        quasis.push(cur);
        cur = '';
        exprs.push(this.lexUntil(true));
        continue;
      }
      if (c === '\n') this.line++;
      cur += c;
      this.pos++;
    }
    quasis.push(cur);
    return { k: 'tpl', quasis, exprs, line };
  }

  private readRegex(): Tok {
    const src = this.src;
    const line = this.line;
    let inClass = false;
    this.pos++;
    while (this.pos < src.length) {
      const c = src[this.pos];
      if (c === '\n') break;
      if (c === '\\') { this.pos += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { this.pos++; break; }
      this.pos++;
    }
    while (this.pos < src.length && /[a-z]/i.test(src[this.pos])) this.pos++;
    return { k: 're', line };
  }
}

function regexAllowed(prev: Tok | undefined): boolean {
  if (!prev) return true;
  switch (prev.k) {
    case 'num': case 'str': case 'tpl': case 're': return false;
    case 'id': return REGEX_AFTER_KEYWORDS.has(prev.v);
    case 'p': return prev.v !== ')' && prev.v !== ']' && prev.v !== '++' && prev.v !== '--';
  }
}

export interface ScanViolation {
  /** 1-based line of the offending literal. */
  line: number;
  /** What the literal was assigned to / passed to. */
  sink: string;
  /** The literal text (static parts of templates), trimmed and shortened. */
  text: string;
}

const TEXT_PROPS = new Set(['textContent', 'innerText', 'placeholder', 'title', 'alt']);
const HTML_PROPS = new Set(['innerHTML', 'outerHTML']);
const TEXT_ATTRS = new Set(['title', 'placeholder', 'aria-label', 'alt']);
const DIALOG_FNS = new Set(['alert', 'confirm', 'prompt']);
const DIALOG_OWNERS = new Set(['window', 'globalThis', 'self']);
const NON_CALL_KEYWORDS = new Set([
  'return', 'typeof', 'void', 'await', 'in', 'of', 'instanceof', 'case', 'yield', 'delete', 'throw', 'if', 'while', 'for', 'switch',
]);
/** Tokens after which a line break does not end the expression. */
const CONTINUES_AFTER = new Set([
  '=', '+=', '-=', '+', '-', '*', '/', '%', '**', '?', ':', '||', '&&', '??', '(', '[', '{', ',', '.', '?.',
  '==', '===', '!=', '!==', '<', '>', '<=', '>=', '!', '=>', '|', '&', '^', '...',
]);
/** Tokens that, at the start of a new line, continue the previous expression. */
const CONTINUES_BEFORE = new Set([
  '.', '?.', '+', '-', '*', '/', '%', '**', '?', ':', '||', '&&', '??', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '|', '&', '^',
]);

const LETTER = /\p{L}/u;
const HOLE = '\u0000';

/** Visible text of an HTML snippet: drops comments, tags (with attributes) and entities. */
function htmlVisibleText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9A-Fa-f]+);/g, ' ');
}

/** User-facing attribute values (title/placeholder/aria-label/alt) written literally in HTML. */
function htmlTextAttributes(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\b(?:title|placeholder|aria-label|alt)\s*=\s*(["'])([^"']*)\1/gi)) {
    if (LETTER.test(m[2])) out.push(m[2]);
  }
  return out;
}

function shorten(text: string): string {
  const s = text.replace(/\s+/g, ' ').replace(new RegExp(HOLE, 'g'), '${…}').trim();
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

class Scanner {
  readonly found: ScanViolation[] = [];

  constructor(private readonly lines: readonly string[]) {}

  scan(tokens: Tok[]): void {
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.k === 'tpl') {
        for (const expr of tok.exprs) this.scan(expr);
        continue;
      }
      // el.textContent = ... / el.innerHTML += ...
      if (tok.k === 'p' && tok.v === '.') {
        const prop = tokens[i + 1];
        const op = tokens[i + 2];
        if (prop?.k === 'id' && op?.k === 'p' && (op.v === '=' || op.v === '+=')) {
          const html = HTML_PROPS.has(prop.v);
          if (html || TEXT_PROPS.has(prop.v)) {
            const start = i + 3;
            const end = this.expressionEnd(tokens, start, 'statement');
            this.checkRange(tokens, start, end, html, `.${prop.v}`, prop.line);
          }
        }
        continue;
      }
      if (tok.k !== 'id') continue;
      const prev = tokens[i - 1];
      // el.setAttribute('title', ...)
      if (tok.v === 'setAttribute' && prev?.k === 'p' && prev.v === '.') {
        const open = tokens[i + 1];
        const name = tokens[i + 2];
        const comma = tokens[i + 3];
        if (open?.k === 'p' && open.v === '(' && name?.k === 'str' && TEXT_ATTRS.has(name.v) && comma?.k === 'p' && comma.v === ',') {
          const start = i + 4;
          const end = this.expressionEnd(tokens, start, 'argument');
          this.checkRange(tokens, start, end, false, `setAttribute('${name.v}')`, tok.line);
        }
        continue;
      }
      // alert('...') / window.confirm('...')
      if (DIALOG_FNS.has(tok.v) && tokens[i + 1]?.k === 'p' && (tokens[i + 1] as { v: string }).v === '(') {
        const owner = tokens[i - 2];
        const member = prev?.k === 'p' && (prev.v === '.' || prev.v === '?.');
        if (member && !(owner?.k === 'id' && DIALOG_OWNERS.has(owner.v))) continue;
        if (prev?.k === 'id' && prev.v === 'function') continue;
        let j = i + 2;
        while (j < tokens.length) {
          const end = this.expressionEnd(tokens, j, 'argument');
          this.checkRange(tokens, j, end, false, `${tok.v}()`, tok.line);
          const sep = tokens[end];
          if (!(sep?.k === 'p' && sep.v === ',')) break;
          j = end + 1;
        }
      }
    }
  }

  /** Index just past the expression starting at `start`. */
  private expressionEnd(tokens: Tok[], start: number, mode: 'statement' | 'argument'): number {
    let depth = 0;
    for (let j = start; j < tokens.length; j++) {
      const tok = tokens[j];
      if (tok.k === 'p') {
        if (tok.v === '(' || tok.v === '[' || tok.v === '{') { depth++; continue; }
        if (tok.v === ')' || tok.v === ']' || tok.v === '}') {
          if (depth === 0) return j;
          depth--;
          continue;
        }
        if (depth === 0 && (tok.v === ';' || tok.v === ',')) return j;
      }
      if (mode === 'statement' && depth === 0 && j > start) {
        const prev = tokens[j - 1];
        if (tok.line > prev.line) {
          const continues = (prev.k === 'p' && CONTINUES_AFTER.has(prev.v)) || (tok.k === 'p' && CONTINUES_BEFORE.has(tok.v));
          if (!continues) return j;
        }
      }
    }
    return tokens.length;
  }

  /**
   * Reports literals in tokens[start, end) that end up as visible text: those not nested inside a
   * call, index or object (grouping parentheses are transparent), so `t('key')` and `fmt(x)` are
   * fine while `ok ? 'Yes' : 'No'` and `n + ' kills'` are not. In HTML mode, any literal that looks
   * like markup is checked for visible words wherever it appears.
   */
  private checkRange(tokens: Tok[], start: number, end: number, html: boolean, sink: string, sinkLine: number): void {
    const stack: ('call' | 'group' | 'other')[] = [];
    let nested = 0; // entries in `stack` that are not grouping parentheses
    for (let j = start; j < end; j++) {
      const tok = tokens[j];
      const level0 = nested === 0;
      if (tok.k === 'p') {
        if (tok.v === '(') {
          const prev = j > start ? tokens[j - 1] : undefined;
          const call =
            prev !== undefined &&
            ((prev.k === 'id' && !NON_CALL_KEYWORDS.has(prev.v)) ||
              (prev.k === 'p' && (prev.v === ')' || prev.v === ']' || prev.v === '?.')) ||
              prev.k === 'tpl');
          stack.push(call ? 'call' : 'group');
          if (call) nested++;
        } else if (tok.v === '[' || tok.v === '{') {
          stack.push('other');
          nested++;
        } else if (tok.v === ')' || tok.v === ']' || tok.v === '}') {
          const top = stack.pop();
          if (top !== undefined && top !== 'group') nested--;
        }
        continue;
      }
      if (tok.k === 'str') {
        if (level0) this.checkText(tok.v, html, sink, tok.line, sinkLine);
        else if (html && tok.v.includes('<')) this.checkText(tok.v, true, sink, tok.line, sinkLine);
        continue;
      }
      if (tok.k === 'tpl') {
        const joined = tok.quasis.join(HOLE);
        if (level0 || (html && joined.includes('<'))) {
          this.checkText(joined, html, sink, tok.line, sinkLine);
          for (const expr of tok.exprs) this.checkRange(expr, 0, expr.length, html, sink, sinkLine);
        }
      }
    }
  }

  private checkText(text: string, html: boolean, sink: string, line: number, sinkLine: number): void {
    const visible = html ? htmlVisibleText(text) : text;
    const offending = LETTER.test(visible) ? [visible] : [];
    if (html) offending.push(...htmlTextAttributes(text));
    if (offending.length === 0 || this.ignored(line, sinkLine)) return;
    this.found.push({ line, sink, text: shorten(offending.join(' ')) });
  }

  private ignored(line: number, sinkLine: number): boolean {
    const has = (n: number) => (this.lines[n - 1] ?? '').includes('i18n-ignore');
    const commentAbove = (n: number) => {
      const above = (this.lines[n - 2] ?? '').trim();
      return (above.startsWith('//') || above.startsWith('/*') || above.startsWith('*')) && above.includes('i18n-ignore');
    };
    return has(line) || has(sinkLine) || commentAbove(line) || commentAbove(sinkLine);
  }
}

/** Finds hardcoded user-facing strings in one TypeScript source text. */
export function scanSource(source: string): ScanViolation[] {
  const tokens = new Lexer(source).tokenize();
  const scanner = new Scanner(source.split('\n'));
  scanner.scan(tokens);
  return scanner.found.sort((a, b) => a.line - b.line);
}

/** Every .ts file under `dir`, skipping `excludeDirs` (absolute paths). */
function listTsFiles(dir: string, excludeDirs: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (excludeDirs.some((x) => d === x)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

// ============================================================================
// CLI
// ============================================================================

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const toPosix = (p: string) => p.split(sep).join('/');

function listPreview(items: readonly string[], verbose: boolean, limit = 12): string {
  const shown = verbose ? items : items.slice(0, limit);
  const more = items.length - shown.length;
  return shown.join(', ') + (more > 0 ? `, … (+${more} more; --verbose lists all)` : '');
}

function runKeyChecks(verbose: boolean): number {
  const reference: StringDict = en;
  let problems = 0;
  for (const { stem, missing } of incompletePluralFamilies(reference)) {
    console.log(`[plural] en: "${stem}" lacks variants ${missing.map((c) => `_${c}`).join(', ')}`);
    problems++;
  }
  for (const key of emptyValues(reference)) {
    console.log(`[empty] en: "${key}"`);
    problems++;
  }
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    const dict = DICTIONARIES[code];
    const { missing, extra } = compareKeys(reference, dict);
    if (missing.length > 0) {
      console.log(`[keys] ${code}: ${missing.length} missing — ${listPreview(missing, verbose)}`);
      problems += missing.length;
    }
    if (extra.length > 0) {
      console.log(`[keys] ${code}: ${extra.length} unknown — ${listPreview(extra, verbose)}`);
      problems += extra.length;
    }
    for (const key of emptyValues(dict)) {
      console.log(`[empty] ${code}: "${key}"`);
      problems++;
    }
    for (const m of comparePlaceholders(reference, dict)) {
      console.log(`[placeholders] ${code}: "${m.key}" has {${m.actual.join('},{')}} but English has {${m.expected.join('},{')}}`);
      problems++;
    }
  }
  const total = Object.keys(reference).length;
  console.log(problems === 0 ? `i18n keys: OK (${total} keys × ${LANGUAGES.length} languages)` : `i18n keys: ${problems} problem(s)`);
  return problems;
}

function runScan(): number {
  const clientDir = join(ROOT, 'src', 'client');
  const files = listTsFiles(clientDir, [join(clientDir, 'i18n', 'locales')]);
  let problems = 0;
  for (const file of files) {
    for (const v of scanSource(readFileSync(file, 'utf8'))) {
      console.log(`${toPosix(relative(ROOT, file))}:${v.line}: hardcoded text in ${v.sink}: "${v.text}"`);
      problems++;
    }
  }
  console.log(problems === 0 ? `i18n scan: OK (${files.length} files)` : `i18n scan: ${problems} hardcoded string(s)`);
  return problems;
}

export function main(argv: readonly string[]): number {
  const keysOnly = argv.includes('--keys-only');
  const scanOnly = argv.includes('--scan-only');
  const verbose = argv.includes('--verbose');
  let problems = 0;
  if (!scanOnly) problems += runKeyChecks(verbose);
  if (!keysOnly) problems += runScan();
  return problems > 0 ? 1 : 0;
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) process.exit(main(process.argv.slice(2)));
