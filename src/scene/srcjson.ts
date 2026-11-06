/**
 * The strict JSON reader dzStudio uses for project files: it keeps the exact source text of every value and key,
 * duplicate keys in their order (the last one counts), and numbers as their source text. Reading a file the way the
 * editor does needs exactly its notion of what is valid, so this is not the lenient text-form reader in json.ts.
 */

export type SrcType = 'null' | 'bool' | 'num' | 'str' | 'arr' | 'obj';

export class SrcNode {
  str = '';
  bool = false;
  start = 0;
  end = 0;
  keyStart = -1;
  keyEnd = -1;
  items: SrcNode[] = [];
  keys: string[] = [];

  constructor(readonly type: SrcType) {}

  /** The last occurrence of a key. */
  get(key: string): SrcNode | undefined {
    if (this.type !== 'obj') return undefined;
    for (let i = this.keys.length - 1; i >= 0; i--) if (this.keys[i] === key) return this.items[i];
    return undefined;
  }

  countKey(key: string): number {
    return this.type === 'obj' ? this.keys.filter((k) => k === key).length : 0;
  }
}

/** Text the editor would read differently from any JSON reader (a null character, a broken surrogate escape). */
export class SrcUnsupported extends Error {}

export interface SrcDoc {
  root?: SrcNode;
  error?: string;
  slice(start: number, end: number): string;
  raw(n: SrcNode): string;
}

const MAX_DEPTH = 200;

class Fail extends Error {}

class Reader {
  i = 0;

  constructor(readonly s: string) {}

  code(): number {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }

  fail(msg: string): never {
    throw new Fail(msg);
  }

  ws(): void {
    for (;;) {
      const c = this.code();
      if (c === 32 || c === 9 || c === 10 || c === 13) this.i++;
      else return;
    }
  }

  value(depth: number): SrcNode {
    if (depth > MAX_DEPTH) this.fail('nested too deeply');
    this.ws();
    if (this.i >= this.s.length) this.fail('unexpected end of file');
    const start = this.i;
    const c = this.code();
    let n: SrcNode;
    if (c === 0x7b) {
      n = new SrcNode('obj');
      this.i++;
      this.ws();
      if (this.code() === 0x7d) this.i++;
      else {
        for (;;) {
          this.ws();
          if (this.code() !== 0x22) this.fail('field name expected');
          const keyStart = this.i;
          const key = this.string();
          const keyEnd = this.i;
          this.ws();
          if (this.code() !== 0x3a) this.fail('":" expected');
          this.i++;
          const v = this.value(depth + 1);
          v.keyStart = keyStart;
          v.keyEnd = keyEnd;
          n.keys.push(key);
          n.items.push(v);
          this.ws();
          const sep = this.code();
          this.i++;
          if (sep === 0x2c) continue;
          if (sep === 0x7d) break;
          this.i--;
          this.fail('"," or "}" expected');
        }
      }
    } else if (c === 0x5b) {
      n = new SrcNode('arr');
      this.i++;
      this.ws();
      if (this.code() === 0x5d) this.i++;
      else {
        for (;;) {
          n.items.push(this.value(depth + 1));
          this.ws();
          const sep = this.code();
          this.i++;
          if (sep === 0x2c) continue;
          if (sep === 0x5d) break;
          this.i--;
          this.fail('"," or "]" expected');
        }
      }
    } else if (c === 0x22) {
      n = new SrcNode('str');
      n.str = this.string();
    } else if (c === 0x74 || c === 0x66 || c === 0x6e) {
      let word = '';
      for (let b = this.code(); b >= 97 && b <= 122; b = this.code()) {
        word += this.s[this.i];
        this.i++;
      }
      if (word === 'true') {
        n = new SrcNode('bool');
        n.bool = true;
      } else if (word === 'false') n = new SrcNode('bool');
      else if (word === 'null') n = new SrcNode('null');
      else this.fail(`unknown word ${word}`);
    } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
      n = new SrcNode('num');
      n.str = this.number();
    } else this.fail('unexpected character');
    n.start = start;
    n.end = this.i;
    return n;
  }

  digits(): string {
    const from = this.i;
    while (this.code() >= 0x30 && this.code() <= 0x39) this.i++;
    return this.s.slice(from, this.i);
  }

  number(): string {
    const from = this.i;
    if (this.code() === 0x2d) this.i++;
    if (this.code() === 0x30) {
      this.i++;
      const nb = this.code();
      if (nb >= 0x30 && nb <= 0x39) this.fail('leading zero');
    } else if (!this.digits()) this.fail('number expected');
    if (this.code() === 0x2e) {
      this.i++;
      if (!this.digits()) this.fail('digit after "." expected');
    }
    if (this.code() === 0x65 || this.code() === 0x45) {
      this.i++;
      if (this.code() === 0x2b || this.code() === 0x2d) this.i++;
      if (!this.digits()) this.fail('digit in the exponent expected');
    }
    const after = this.code();
    if ((after >= 97 && after <= 122) || (after >= 65 && after <= 90)) this.fail('invalid number');
    return this.s.slice(from, this.i);
  }

  hex4(): number {
    const h = this.s.slice(this.i, this.i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('invalid \\u sequence');
    this.i += 4;
    return parseInt(h, 16);
  }

  string(): string {
    this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('text without end');
      const from = this.i;
      let c = this.code();
      while (c !== -1 && c !== 0x22 && c !== 0x5c && c >= 0x20) {
        this.i++;
        c = this.code();
      }
      out += this.s.slice(from, this.i);
      if (c === -1) continue;
      if (c === 0x22) {
        this.i++;
        return out;
      }
      if (c < 0x20) this.fail('control character in text');
      this.i++;
      const e = this.code();
      this.i++;
      switch (e) {
        case 0x22:
          out += '"';
          break;
        case 0x5c:
          out += '\\';
          break;
        case 0x2f:
          out += '/';
          break;
        case 0x62:
          out += '\b';
          break;
        case 0x66:
          out += '\f';
          break;
        case 0x6e:
          out += '\n';
          break;
        case 0x72:
          out += '\r';
          break;
        case 0x74:
          out += '\t';
          break;
        case 0x75: {
          let cp = this.hex4();
          if (cp >= 0xd800 && cp <= 0xdbff && this.code() === 0x5c && this.s.charCodeAt(this.i + 1) === 0x75) {
            this.i += 2;
            const lo = this.hex4();
            if (lo < 0xdc00 || lo > 0xdfff) throw new SrcUnsupported('a \\u escape with a broken surrogate pair');
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          }
          if (cp === 0) throw new SrcUnsupported('a \\u0000 escape');
          if (cp >= 0xd800 && cp <= 0xdfff) throw new SrcUnsupported('a \\u escape with a lone surrogate');
          out += String.fromCodePoint(cp);
          break;
        }
        default:
          this.i--;
          this.fail('invalid escape sequence');
      }
    }
  }
}

/**
 * Reads a whole file. A byte order mark at the start is skipped. Throws SrcUnsupported for text the editor holds
 * differently from its content (it cuts strings at a null character).
 */
export function parseSrc(text: string): SrcDoc {
  if (text.includes('\u0000')) throw new SrcUnsupported('a null character');
  const doc: SrcDoc = {
    slice: (a, b) => (b <= a ? '' : text.slice(a, b)),
    raw: (n) => (n.end <= n.start ? '' : text.slice(n.start, n.end)),
  };
  const r = new Reader(text);
  if (text.charCodeAt(0) === 0xfeff) r.i = 1;
  try {
    const root = r.value(0);
    r.ws();
    if (r.i < text.length) r.fail('characters after the end');
    doc.root = root;
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    doc.error = e.message;
  }
  return doc;
}
