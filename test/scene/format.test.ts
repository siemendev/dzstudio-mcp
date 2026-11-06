import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  chunk,
  IdAllocator,
  parseJson,
  readFloat32,
  readVec3,
  Scene,
  utf8Bytes,
  writeFloat32,
  writeString,
  writeVec3,
} from '../../src/scene/index.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));

describe('float32 text', () => {
  it.each([
    [1234.56789, '1234.5679'],
    [9876.54321, '9876.543'],
    [46.2, '46.2'],
    [1, '1.0'],
    [-90, '-90.0'],
    [1 / 3, '0.33333334'],
    [-Math.PI / 2, '-1.5707964'],
    [0.0000001, '0.0000001'],
    [-0, '0.0'],
    [0, '0.0'],
    [150.125, '150.125'],
    [1e10, '10000000000.0'],
    [3.4028234663852886e38, '340282350000000000000000000000000000000.0'],
    [1.401298464324817e-45, '0.000000000000000000000000000000000000000000001'],
  ])('%s → %s', (value, text) => {
    expect(writeFloat32(value)).toBe(text);
    expect(readFloat32(text) === Math.fround(value)).toBe(true);
  });

  it('never writes an exponent and always reads back exactly', () => {
    let x = 0x2545f491;
    for (let i = 0; i < 20000; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      const buf = new DataView(new ArrayBuffer(4));
      buf.setUint32(0, x >>> 0);
      const f = buf.getFloat32(0);
      if (!Number.isFinite(f)) continue;
      const t = writeFloat32(f);
      expect(t).not.toMatch(/[eE]/);
      expect(t).toContain('.');
      expect(Object.is(readFloat32(t), f) || (f === 0 && readFloat32(t) === 0)).toBe(true);
      const digits = t.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
      expect(digits.length).toBeLessThanOrEqual(9);
    }
  });

  it('is the shortest: the next shorter rounding never reads back', () => {
    for (const v of [0.1, 0.2, 0.3, 123.456, 6512, 9300.25, 1e-3, 16777217, 0.7]) {
      const f = Math.fround(v);
      const t = writeFloat32(f);
      const sig = t.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '').length;
      if (sig > 1) expect(Math.fround(Number(f.toPrecision(sig - 1)))).not.toBe(f);
    }
  });

  it('reads ties to the even mantissa', () => {
    // 16777217 lies exactly between 16777216 and 16777218: the even mantissa wins.
    expect(readFloat32('16777217')).toBe(16777216);
    expect(readFloat32('16777219')).toBe(16777220);
  });

  it('reads with exponent and sign, rejects garbage', () => {
    expect(readFloat32('1e3')).toBe(1000);
    expect(readFloat32('+2.5')).toBe(2.5);
    expect(() => readFloat32('abc')).toThrow();
    expect(() => readFloat32('1e40')).toThrow();
    expect(() => readFloat32('')).toThrow();
  });

  it('three numbers in one string', () => {
    expect(writeVec3([1234.56789, 150.125, 9876.54321])).toBe('1234.5679 150.125 9876.543');
    expect(readVec3('1234.5679 150.125 9876.543')).toEqual([Math.fround(1234.56789), 150.125, Math.fround(9876.54321)]);
    expect(() => readVec3('1 2')).toThrow();
    expect(() => readVec3('1  2 3')).toThrow();
  });
});

describe('JSON', () => {
  it('writes the example string with exactly the given escapes', () => {
    const text = 'Kiste "A"\\Lager\nZeile\t2\u0001 ä/';
    expect(writeString(text)).toBe('"Kiste \\"A\\"\\\\Lager\\nZeile\\t2\\u0001 ä/"');
  });

  it('escapes control bytes with lowercase hex and keeps byte 127 raw', () => {
    expect(writeString('\u001f\u007f\b\f\r')).toBe('"\\u001f\u007f\\b\\f\\r"');
  });

  it('reads leniently: whitespace, \\/, upper-case \\u, surrogate pairs, last duplicate wins', () => {
    const v = parseJson(' {"a" : "x\\/y\\u00E4\\ud83d\\ude00" ,\n"a":"z", "b":[1, 2.5,true,null]}\r\n') as Map<string, unknown>;
    expect(v.get('a')).toBe('z');
    expect(parseJson('"x\\/y\\u00E4\\ud83d\\ude00"')).toBe('x/yä😀');
    expect(v.get('b')).toEqual([1, 2.5, true, null]);
  });

  it('rejects \\u0000, deep nesting, trailing text, lone surrogates, raw control characters', () => {
    expect(() => parseJson('"a\\u0000"')).toThrow();
    expect(() => parseJson('['.repeat(65) + ']'.repeat(65))).toThrow();
    expect(parseJson('['.repeat(64) + ']'.repeat(64))).toBeTruthy();
    expect(() => parseJson('{} x')).toThrow();
    expect(() => parseJson('"\\ud800"')).toThrow();
    expect(() => parseJson('"a\nb"')).toThrow();
  });
});

describe('chunks', () => {
  it('999 bytes of ASCII and an ä: no chunk over 1000 bytes, none splits the ä', () => {
    const text = 'x'.repeat(999) + 'ä';
    const parts = chunk(text);
    expect(parts).toEqual(['x'.repeat(999), 'ä']);
    expect(parts.join('')).toBe(text);
  });

  it('fills every chunk as far as possible', () => {
    const text = 'ab€😀'.repeat(400);
    const parts = chunk(text);
    expect(parts.join('')).toBe(text);
    for (const [i, p] of parts.entries()) {
      expect(utf8Bytes(p)).toBeLessThanOrEqual(1000);
      const rest = parts.slice(i + 1).join('');
      if (rest) expect(utf8Bytes(p) + utf8Bytes(String.fromCodePoint(rest.codePointAt(0)!))).toBeGreaterThan(1000);
    }
  });

  it('an empty text is one empty chunk; exactly 1000 bytes is one chunk', () => {
    expect(chunk('')).toEqual(['']);
    expect(chunk('y'.repeat(1000))).toEqual(['y'.repeat(1000)]);
  });
});

describe('lenient reading, strict writing', () => {
  it('an operation with whitespace, \\/, ä and an unknown key applies like the compact form', () => {
    const looseText = golden
      .G1!.replace('{"textform":1,', '{\n  "x": 1,\r\n  "textform" : 1 ,\t')
      .replace('"customString":"Flag_DayZ"', '"customString" : "Flag\\/DayZ\\u00e4"');
    const compactText = golden.G1!.replace('"customString":"Flag_DayZ"', '"customString":"Flag/DayZä"');
    const compact = new Scene();
    const loose = new Scene();
    expect(compact.applyText(compactText)).toEqual({ result: 'applied' });
    expect(loose.applyText(looseText)).toEqual({ result: 'applied' });
    expect(loose.stateText()).toBe(compact.stateText());
    expect(loose.stateText()).not.toContain('"x"');
  });
});
