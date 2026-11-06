/**
 * The JSON dialect of the dzStudio text form.
 *
 * Writing is canonical: compact, keys in a fixed or byte-sorted order, a minimal set of escapes, raw UTF-8 for
 * everything else. Reading is lenient about whitespace and escapes but strict about what the game cannot hold
 * (`\u0000`, nesting deeper than 64 levels, trailing garbage).
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = Map<string, JsonValue>;

export class JsonError extends Error {}

const MAX_DEPTH = 64;

export function isObject(v: JsonValue | undefined): v is JsonObject {
  return v instanceof Map;
}

export function writeString(s: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | undefined;
    if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = '\\\\';
    else if (c < 0x20) {
      switch (c) {
        case 8:
          esc = '\\b';
          break;
        case 9:
          esc = '\\t';
          break;
        case 10:
          esc = '\\n';
          break;
        case 12:
          esc = '\\f';
          break;
        case 13:
          esc = '\\r';
          break;
        default:
          esc = '\\u00' + c.toString(16).padStart(2, '0');
      }
    }
    if (esc !== undefined) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return out + s.slice(start) + '"';
}

/** Ascending by the UTF-8 bytes of the key. */
export function compareKeys(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function sortedKeys(keys: Iterable<string>): string[] {
  return [...keys].sort(compareKeys);
}

export function writeInt(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new JsonError(`not a non-negative integer: ${n}`);
  return String(n);
}

/** A string → string map with byte-sorted keys. */
export function writeStringMap(m: ReadonlyMap<string, string>): string {
  return '{' + sortedKeys(m.keys()).map((k) => writeString(k) + ':' + writeString(m.get(k)!)).join(',') + '}';
}

/** Generic writer for plugin-owned JSON (objects with byte-sorted keys). */
export function writeJson(v: JsonValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new JsonError('non-finite number');
    return String(v);
  }
  if (typeof v === 'string') return writeString(v);
  if (Array.isArray(v)) return '[' + v.map(writeJson).join(',') + ']';
  return '{' + sortedKeys(v.keys()).map((k) => writeString(k) + ':' + writeJson(v.get(k)!)).join(',') + '}';
}

export function parseJson(text: string): JsonValue {
  const p = new Parser(text);
  p.ws();
  const v = p.value(0);
  p.ws();
  if (p.i !== text.length) throw new JsonError(`unexpected text after the value at ${p.i}`);
  return v;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  ws(): void {
    for (;;) {
      const c = this.s.charCodeAt(this.i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.i++;
      else return;
    }
  }

  fail(msg: string): never {
    throw new JsonError(`${msg} at ${this.i}`);
  }

  value(depth: number): JsonValue {
    const c = this.s[this.i];
    switch (c) {
      case '{':
        return this.object(depth + 1);
      case '[':
        return this.array(depth + 1);
      case '"':
        return this.string();
      case 't':
        return this.literal('true', true);
      case 'f':
        return this.literal('false', false);
      case 'n':
        return this.literal('null', null);
      default:
        return this.number();
    }
  }

  literal<T extends JsonValue>(word: string, v: T): T {
    if (this.s.startsWith(word, this.i)) {
      this.i += word.length;
      return v;
    }
    return this.fail('unexpected token');
  }

  object(depth: number): JsonObject {
    if (depth > MAX_DEPTH) this.fail('nested too deeply');
    this.i++;
    const m: JsonObject = new Map();
    this.ws();
    if (this.s[this.i] === '}') {
      this.i++;
      return m;
    }
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '"') this.fail('expected a key');
      const k = this.string();
      this.ws();
      if (this.s[this.i] !== ':') this.fail('expected :');
      this.i++;
      this.ws();
      const v = this.value(depth);
      m.delete(k);
      m.set(k, v);
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return m;
      if (c !== ',') this.fail('expected , or }');
    }
  }

  array(depth: number): JsonValue[] {
    if (depth > MAX_DEPTH) this.fail('nested too deeply');
    this.i++;
    const a: JsonValue[] = [];
    this.ws();
    if (this.s[this.i] === ']') {
      this.i++;
      return a;
    }
    for (;;) {
      this.ws();
      a.push(this.value(depth));
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return a;
      if (c !== ',') this.fail('expected , or ]');
    }
  }

  string(): string {
    this.i++;
    let out = '';
    let start = this.i;
    for (;;) {
      if (this.i >= this.s.length) this.fail('unterminated string');
      const c = this.s.charCodeAt(this.i);
      if (c === 0x22) {
        out += this.s.slice(start, this.i);
        this.i++;
        return out;
      }
      if (c < 0x20) this.fail('control character in string');
      if (c >= 0xd800 && c <= 0xdfff) {
        const hi = c <= 0xdbff;
        const next = this.s.charCodeAt(this.i + 1);
        if (!hi || !(next >= 0xdc00 && next <= 0xdfff)) this.fail('lone surrogate');
        this.i += 2;
        continue;
      }
      if (c !== 0x5c) {
        this.i++;
        continue;
      }
      out += this.s.slice(start, this.i);
      const e = this.s[this.i + 1];
      this.i += 2;
      switch (e) {
        case '"':
          out += '"';
          break;
        case '\\':
          out += '\\';
          break;
        case '/':
          out += '/';
          break;
        case 'b':
          out += '\b';
          break;
        case 'f':
          out += '\f';
          break;
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'u': {
          const u = this.hex4();
          if (u === 0) this.fail('\\u0000 is not allowed');
          if (u >= 0xd800 && u <= 0xdbff) {
            if (this.s[this.i] !== '\\' || this.s[this.i + 1] !== 'u') this.fail('lone surrogate');
            this.i += 2;
            const lo = this.hex4();
            if (lo < 0xdc00 || lo > 0xdfff) this.fail('lone surrogate');
            out += String.fromCharCode(u, lo);
          } else if (u >= 0xdc00 && u <= 0xdfff) {
            this.fail('lone surrogate');
          } else out += String.fromCharCode(u);
          break;
        }
        default:
          this.fail('invalid escape');
      }
      start = this.i;
    }
  }

  hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('invalid \\u escape');
    this.i += 4;
    return parseInt(h, 16);
  }

  number(): number {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.s.slice(this.i, this.i + 400));
    if (!m) this.fail('unexpected token');
    this.i += m[0].length;
    return Number(m[0]);
  }
}
