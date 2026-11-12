/**
 * A JSON value as dzStudio's DZS_Json holds it: numbers as their source text, object keys in their order, the last of
 * duplicate keys in the place of the first. The helpers mirror DZS_Json's reading and writing.
 */

import { writeString } from './json.js';
import type { SrcNode } from './srcjson.js';

export type JObj = { t: 'obj'; m: Map<string, JV> };
export type JArr = { t: 'arr'; a: JV[] };

export type JV = JObj | JArr | { t: 'num'; s: string } | { t: 'str'; s: string } | { t: 'bool'; b: boolean } | { t: 'null' };

export function toJV(n: SrcNode): JV {
  switch (n.type) {
    case 'obj': {
      const m = new Map<string, JV>();
      n.keys.forEach((k, i) => m.set(k, toJV(n.items[i]!)));
      return { t: 'obj', m };
    }
    case 'arr':
      return { t: 'arr', a: n.items.map(toJV) };
    case 'num':
      return { t: 'num', s: n.str };
    case 'str':
      return { t: 'str', s: n.str };
    case 'bool':
      return { t: 'bool', b: n.bool };
    default:
      return { t: 'null' };
  }
}

export const jStr = (s: string): JV => ({ t: 'str', s });
export const jNum = (s: string): JV => ({ t: 'num', s });
export const jBool = (b: boolean): JV => ({ t: 'bool', b });
export const jNull = (): JV => ({ t: 'null' });
export const jObj = (): JObj => ({ t: 'obj', m: new Map() });
export const jArr = (a: JV[] = []): JArr => ({ t: 'arr', a });

export function isObj(v: JV | undefined): v is JObj {
  return v?.t === 'obj';
}

export function isArr(v: JV | undefined): v is JArr {
  return v?.t === 'arr';
}

/** DZS_Json.Get: a member of an object; undefined for anything else. */
export function get(v: JV | undefined, key: string): JV | undefined {
  return v?.t === 'obj' ? v.m.get(key) : undefined;
}

/** DZS_Json.GetStr: a string member, else "". */
export function getStr(v: JV | undefined, key: string): string {
  const x = get(v, key);
  return x?.t === 'str' ? x.s : '';
}

export function getBool(v: JV | undefined, key: string): boolean {
  const x = get(v, key);
  return x?.t === 'bool' ? x.b : false;
}

/** DZS_Json.m_Str: the text of a number or a string, "" for anything else. */
export function mStr(v: JV | undefined): string {
  return v?.t === 'num' || v?.t === 'str' ? v.s : '';
}

/** DZS_Json.Count: members of an object or items of a list. */
export function count(v: JV | undefined): number {
  if (v?.t === 'obj') return v.m.size;
  if (v?.t === 'arr') return v.a.length;
  return 0;
}

export function clone(v: JV): JV {
  if (v.t === 'obj') return { t: 'obj', m: new Map([...v.m].map(([k, x]) => [k, clone(x)])) };
  if (v.t === 'arr') return { t: 'arr', a: v.a.map(clone) };
  return { ...v };
}

/** DZS_Json.Write without indentation (ToChunks): the compact text. */
export function compact(v: JV): string {
  switch (v.t) {
    case 'null':
      return 'null';
    case 'bool':
      return String(v.b);
    case 'num':
      return v.s;
    case 'str':
      return writeString(v.s);
    case 'arr':
      return `[${v.a.map(compact).join(',')}]`;
    case 'obj':
      return `{${[...v.m].map(([k, x]) => `${writeString(k)}:${compact(x)}`).join(',')}}`;
  }
}

/** dzStudio's text form (DZS_TextForm.Value): 4 spaces per level, one field per line, empty {} and [] inline. */
export function textForm(v: JV, depth: number): string {
  const ind = (d: number): string => '    '.repeat(d);
  if (v.t === 'arr') {
    if (!v.a.length) return '[]';
    return `[\n${v.a.map((x) => ind(depth + 1) + textForm(x, depth + 1)).join(',\n')}\n${ind(depth)}]`;
  }
  if (v.t === 'obj') {
    if (!v.m.size) return '{}';
    const lines = [...v.m].map(([k, x]) => `${ind(depth + 1)}${writeString(k)}: ${textForm(x, depth + 1)}`);
    return `{\n${lines.join(',\n')}\n${ind(depth)}}`;
  }
  return compact(v);
}
