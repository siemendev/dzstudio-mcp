import {
  isObject,
  JsonError,
  parseJson,
  writeInt,
  writeString,
  writeStringMap,
  sortedKeys,
  type JsonObject,
  type JsonValue,
} from './json.js';
import { TEXTFORM } from './types.js';

export interface Comp {
  v: number;
  d: string;
}

export interface Element {
  id: string;
  kind: string;
  parent: string;
  after: string;
  hidden: boolean;
  locked: boolean;
  fields: Map<string, string>;
  comp: Map<string, Comp>;
}

export type Change =
  | { k: 'create' | 'delete'; el: Element }
  | { k: 'field'; id: string; key: string; old?: string; new?: string }
  | { k: 'hidden' | 'locked'; id: string; old: boolean; new: boolean }
  | { k: 'move'; id: string; from: string; fromAfter: string; to: string; toAfter: string }
  | { k: 'comp'; id: string; type: string; old?: Comp; new?: Comp };

export type Origin = 'local' | 'system' | 'remote';

export interface Operation {
  id: string;
  type: string;
  tv: number;
  author: string;
  authorName: string;
  origin: Origin;
  changes: Change[];
}

export interface StateText {
  kinds: Map<string, number>;
  elements: Element[];
}

/** The text could not be read or does not have the structure of text form 1 (stages 1 and 2). */
export class TextFormError extends Error {
  constructor(
    message: string,
    readonly newerTextForm?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- writing

function writeComp(c: Comp): string {
  return `{"v":${writeInt(c.v)},"d":${writeString(c.d)}}`;
}

function writeElementBody(e: Element): string {
  const comp = sortedKeys(e.comp.keys())
    .map((k) => writeString(k) + ':' + writeComp(e.comp.get(k)!))
    .join(',');
  return (
    `"id":${writeString(e.id)},"kind":${writeString(e.kind)},"parent":${writeString(e.parent)},` +
    `"after":${writeString(e.after)},"hidden":${e.hidden},"locked":${e.locked},` +
    `"fields":${writeStringMap(e.fields)},"comp":{${comp}}`
  );
}

export function writeElement(e: Element): string {
  return '{' + writeElementBody(e) + '}';
}

export function writeChange(c: Change): string {
  switch (c.k) {
    case 'create':
    case 'delete':
      return '{' + writeElementBody(c.el) + `,"k":"${c.k}"}`;
    case 'field': {
      let s = `{"id":${writeString(c.id)},"k":"field","key":${writeString(c.key)}`;
      if (c.old !== undefined) s += `,"old":${writeString(c.old)}`;
      if (c.new !== undefined) s += `,"new":${writeString(c.new)}`;
      return s + '}';
    }
    case 'hidden':
    case 'locked':
      return `{"id":${writeString(c.id)},"k":"${c.k}","old":${c.old},"new":${c.new}}`;
    case 'move':
      return (
        `{"id":${writeString(c.id)},"k":"move","from":${writeString(c.from)},"fromAfter":${writeString(c.fromAfter)},` +
        `"to":${writeString(c.to)},"toAfter":${writeString(c.toAfter)}}`
      );
    case 'comp': {
      let s = `{"id":${writeString(c.id)},"k":"comp","type":${writeString(c.type)}`;
      if (c.old !== undefined) s += `,"old":${writeComp(c.old)}`;
      if (c.new !== undefined) s += `,"new":${writeComp(c.new)}`;
      return s + '}';
    }
  }
}

export function writeOperation(op: Operation): string {
  return (
    `{"textform":${TEXTFORM},"op":{"id":${writeString(op.id)},"type":${writeString(op.type)},"tv":${writeInt(op.tv)},` +
    `"author":${writeString(op.author)},"authorName":${writeString(op.authorName)},"origin":${writeString(op.origin)},` +
    `"changes":[${op.changes.map(writeChange).join(',')}]}}`
  );
}

export function writeState(state: StateText): string {
  const kinds = sortedKeys(state.kinds.keys())
    .map((k) => writeString(k) + ':' + writeInt(state.kinds.get(k)!))
    .join(',');
  return `{"textform":${TEXTFORM},"state":{"kinds":{${kinds}},"elements":[${state.elements.map(writeElement).join(',')}]}}`;
}

// ---------------------------------------------------------------- reading

function str(v: JsonValue | undefined): string {
  return typeof v === 'string' ? v : '';
}

function bool(v: JsonValue | undefined): boolean {
  return typeof v === 'boolean' ? v : false;
}

function isVersion(v: JsonValue | undefined): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

/** A companion entry of an element: without a valid `v` the element is invalid. */
function readElementComp(v: JsonValue | undefined): Comp | undefined {
  if (!isObject(v) || !isVersion(v.get('v'))) return undefined;
  return { v: v.get('v') as number, d: str(v.get('d')) };
}

/** `old`/`new` of a `comp` change: anything but an object with a valid `v` counts as absent. */
function readChangeComp(v: JsonValue | undefined): Comp | undefined {
  return readElementComp(v);
}

export function readElement(o: JsonObject): Element {
  if (!o.has('id') || !o.has('kind')) throw new TextFormError('element without id or kind');
  const fields = new Map<string, string>();
  const f = o.get('fields');
  if (isObject(f)) {
    for (const [k, v] of f) {
      if (typeof v !== 'string') throw new TextFormError(`field ${k} is not a string`);
      fields.set(k, v);
    }
  }
  const comp = new Map<string, Comp>();
  const c = o.get('comp');
  if (isObject(c)) {
    for (const [k, v] of c) {
      const entry = readElementComp(v);
      if (!entry) throw new TextFormError(`companion data ${k} without a version`);
      comp.set(k, entry);
    }
  }
  return {
    id: str(o.get('id')),
    kind: str(o.get('kind')),
    parent: str(o.get('parent')),
    after: str(o.get('after')),
    hidden: bool(o.get('hidden')),
    locked: bool(o.get('locked')),
    fields,
    comp,
  };
}

export function readChange(v: JsonValue): Change {
  if (!isObject(v)) throw new TextFormError('a change is not an object');
  const k = v.get('k');
  const id = str(v.get('id'));
  switch (k) {
    case 'create':
    case 'delete':
      return { k, el: readElement(v) };
    case 'field': {
      const c: Change = { k, id, key: str(v.get('key')) };
      if (v.has('old')) c.old = str(v.get('old'));
      if (v.has('new')) c.new = str(v.get('new'));
      return c;
    }
    case 'hidden':
    case 'locked':
      return { k, id, old: bool(v.get('old')), new: bool(v.get('new')) };
    case 'move':
      return {
        k,
        id,
        from: str(v.get('from')),
        fromAfter: str(v.get('fromAfter')),
        to: str(v.get('to')),
        toAfter: str(v.get('toAfter')),
      };
    case 'comp': {
      const c: Change = { k, id, type: str(v.get('type')) };
      const o = readChangeComp(v.get('old'));
      const n = readChangeComp(v.get('new'));
      if (o) c.old = o;
      if (n) c.new = n;
      return c;
    }
    default:
      throw new TextFormError(`unknown change kind ${JSON.stringify(k)}`);
  }
}

function parseEnvelope(text: string): JsonObject {
  let root: JsonValue;
  try {
    root = parseJson(text);
  } catch (e) {
    throw new TextFormError(`not valid JSON: ${(e as JsonError).message}`);
  }
  if (!isObject(root)) throw new TextFormError('not a JSON object');
  if (!root.has('textform')) throw new TextFormError('no textform');
  const tf = root.get('textform');
  if (typeof tf !== 'number' || !Number.isSafeInteger(tf) || tf < 1) throw new TextFormError('invalid textform');
  if (tf > TEXTFORM) throw new TextFormError(`text form ${tf} is newer than ${TEXTFORM}`, tf);
  return root;
}

/** Stages 1 and 2 of applying: read and check the structure. Throws TextFormError when the text is invalid. */
export function readOperation(text: string): Operation {
  const root = parseEnvelope(text);
  const op = root.get('op');
  if (!isObject(op)) throw new TextFormError('op missing or not an object');
  const origin = op.get('origin');
  if (origin !== 'local' && origin !== 'system' && origin !== 'remote') throw new TextFormError('invalid origin');
  const changes = op.get('changes');
  if (!Array.isArray(changes)) throw new TextFormError('changes is not a list');
  const tv = op.get('tv');
  return {
    id: str(op.get('id')),
    type: str(op.get('type')),
    tv: typeof tv === 'number' && Number.isSafeInteger(tv) && tv >= 1 ? tv : 1,
    author: str(op.get('author')),
    authorName: str(op.get('authorName')),
    origin,
    changes: changes.map(readChange),
  };
}

export function readStateText(text: string): StateText {
  const root = parseEnvelope(text);
  const st = root.get('state');
  if (!isObject(st)) throw new TextFormError('state missing or not an object');
  const kinds = new Map<string, number>();
  const k = st.get('kinds');
  if (isObject(k)) for (const [name, v] of k) kinds.set(name, typeof v === 'number' ? v : 0);
  const list = st.get('elements');
  const elements: Element[] = [];
  if (Array.isArray(list)) {
    for (const e of list) {
      if (!isObject(e)) throw new TextFormError('an element is not an object');
      elements.push(readElement(e));
    }
  }
  return { kinds, elements };
}

export function cloneElement(e: Element): Element {
  return { ...e, fields: new Map(e.fields), comp: new Map([...e.comp].map(([k, c]) => [k, { ...c }])) };
}

export function inverseChange(c: Change): Change {
  switch (c.k) {
    case 'create':
      return { k: 'delete', el: cloneElement(c.el) };
    case 'delete':
      return { k: 'create', el: cloneElement(c.el) };
    case 'field': {
      const r: Change = { k: 'field', id: c.id, key: c.key };
      if (c.new !== undefined) r.old = c.new;
      if (c.old !== undefined) r.new = c.old;
      return r;
    }
    case 'hidden':
    case 'locked':
      return { k: c.k, id: c.id, old: c.new, new: c.old };
    case 'move':
      return { k: 'move', id: c.id, from: c.to, fromAfter: c.toAfter, to: c.from, toAfter: c.fromAfter };
    case 'comp': {
      const r: Change = { k: 'comp', id: c.id, type: c.type };
      if (c.new) r.old = { ...c.new };
      if (c.old) r.new = { ...c.old };
      return r;
    }
  }
}
