/**
 * dzStudio's layers (Spawns, Effects, Territories) outside the game: their elements, how they are read from and
 * written as building blocks and changes of the project file, which entries of an opened file each layer takes over
 * (DZS_LayerTake), what the opening carries over unchanged (DZS_KeptBlocks), and the extensions a layer takes from the
 * file while it restores its elements (DZS_EntityExts). Every function mirrors the editor's code of the same name.
 */

import {
  clone,
  compact,
  count,
  get,
  getBool,
  getStr,
  isArr,
  isObj,
  jArr,
  jNull,
  jNum,
  jObj,
  jStr,
  mStr,
  type JArr,
  type JObj,
  type JV,
} from './jv.js';
import { writeString } from './json.js';

export const SPAWNS = {
  plugin: 'spawns',
  event: 'spawns:event',
  point: 'spawns:point',
  set: 'spawns:set',
  op: 'spawns:edit',
} as const;

export const EFFECTS = {
  plugin: 'effects',
  area: 'effects:area',
  change: 'effects:change',
  op: 'effects:edit',
} as const;

export const TERRITORIES = {
  plugin: 'territories',
  zone: 'territories:zone',
  territory: 'territories:territory',
  change: 'territories:change',
  nominal: 'territories:nominal',
  op: 'territories:edit',
} as const;

/** The element kinds of the layers. */
export const LAYER_KINDS: ReadonlySet<string> = new Set([
  SPAWNS.event,
  SPAWNS.point,
  SPAWNS.set,
  EFFECTS.area,
  EFFECTS.change,
  TERRITORIES.zone,
  TERRITORIES.territory,
  TERRITORIES.change,
  TERRITORIES.nominal,
]);

/** The project's plugin entry with what the opening carried over unchanged. */
export const KEPT = 'kept';
/** Field of a restored element with the id of the block it was made of. */
const BID = 'bid';
const EXT_MEMBER = 'extensions';
/** Field of an element with the extensions of the block it makes. */
export const EXT_SLOT = 'ext';
const CHILD_SLOT = 'ext:child';

// ---------------------------------------------------------------- refs and canonical text

/** The game's string.ToInt: the leading digits, 0 when there are none. */
function enfToInt(s: string): number {
  const m = /^[+-]?[0-9]+/.exec(s);
  return m ? Number(m[0]) : 0;
}

function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** DZS_ProjectRefs.PhpNumber: a JSON number as PHP's json_encode writes it after json_decode. */
export function phpNumber(raw: string): string {
  let s = raw;
  let neg = false;
  if (s.length > 0 && s[0] === '-') {
    neg = true;
    s = s.slice(1);
  }
  let exp = 0;
  const e = lowerAscii(s).indexOf('e');
  let mant = s;
  if (e >= 0) {
    let es = s.slice(e + 1);
    let eneg = false;
    if (es.length > 0 && (es[0] === '+' || es[0] === '-')) {
      eneg = es[0] === '-';
      es = es.slice(1);
    }
    exp = enfToInt(es);
    if (eneg) exp = -exp;
    mant = s.slice(0, e);
  }
  const dot = mant.indexOf('.');
  let ip = mant;
  let fp = '';
  if (dot >= 0) {
    ip = mant.slice(0, dot);
    fp = mant.slice(dot + 1);
  }
  let digits = ip + fp;
  let decpt = ip.length + exp;
  while (digits.length > 0 && digits[0] === '0') {
    digits = digits.slice(1);
    decpt--;
  }
  if (e < 0 && dot < 0) {
    if (digits === '') return '0';
    return neg ? `-${digits}` : digits;
  }
  while (digits.length > 0 && digits[digits.length - 1] === '0') digits = digits.slice(0, -1);
  if (digits === '') return '0';
  const sign = neg ? '-' : '';
  const n = digits.length;
  if (decpt >= n && decpt <= 17) return sign + digits + '0'.repeat(decpt - n);
  if (decpt < -3 || decpt > 17) {
    const rest = n > 1 ? digits.slice(1) : '0';
    let pexp = decpt - 1;
    let esign = '+';
    if (pexp < 0) {
      esign = '-';
      pexp = -pexp;
    }
    return `${sign}${digits[0]}.${rest}e${esign}${pexp}`;
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`;
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`;
}

/** DZS_ProjectRefs.Canon: compact, numbers as PHP writes them, members in their order. */
function refCanon(v: JV): string {
  if (v.t === 'num') return phpNumber(v.s);
  if (v.t === 'arr') return `[${v.a.map(refCanon).join(',')}]`;
  if (v.t === 'obj') return `{${[...v.m].map(([k, x]) => `${writeString(k)}:${refCanon(x)}`).join(',')}}`;
  return compact(v);
}

/** DZS_ProjectRefs.ChangeRef: block, key and field of a change, as dzbot addresses it. */
export function changeRef(change: JV): string {
  const key = get(change, 'key');
  const k = !key || key.t === 'null' ? '{}' : refCanon(key);
  return `${getStr(change, 'block')} ${k} ${getStr(change, 'field')}`.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

/** DZS_LayerTake.Canon: extensions and (for an entry) a null parent left out, members sorted. */
function takeCanon(v: JV, entry: boolean): string {
  if (v.t === 'num') return phpNumber(v.s);
  if (v.t === 'arr') return `[${v.a.map((x) => takeCanon(x, false)).join(',')}]`;
  if (v.t === 'obj') {
    const keys = [...v.m.keys()].filter((k) => k !== EXT_MEMBER && !(entry && k === 'parent' && v.m.get(k)!.t === 'null')).sort();
    return `{${keys.map((k) => `${writeString(k)}:${takeCanon(v.m.get(k)!, false)}`).join(',')}}`;
  }
  return compact(v);
}

/** DZS_LayerTake.Same: the same entries in any order, extensions and a null parent aside, members in any order. */
export function same(a: readonly JV[], b: readonly JV[]): boolean {
  if (a.length !== b.length) return false;
  const ta = a.map((x) => takeCanon(x, true)).sort();
  const tb = b.map((x) => takeCanon(x, true)).sort();
  return ta.every((t, i) => t === tb[i]);
}

function hasExtensions(v: JV): boolean {
  if (v.t === 'obj') return v.m.has(EXT_MEMBER) || [...v.m.values()].some(hasExtensions);
  if (v.t === 'arr') return v.a.some(hasExtensions);
  return false;
}

function stripExtensions(v: JV): void {
  if (v.t === 'obj') {
    v.m.delete(EXT_MEMBER);
    for (const x of v.m.values()) stripExtensions(x);
  } else if (v.t === 'arr') v.a.forEach(stripExtensions);
}

/** DZS_PatchProject.WithoutExtensions: the value without "extensions" members at any depth. */
export function withoutExtensions(v: JV): JV {
  if (!hasExtensions(v)) return v;
  const c = clone(v);
  stripExtensions(c);
  return c;
}

/** DZS_ProjectV2.IdPart: every byte outside A–Z, a–z, 0–9, "-" and "_" as "-". */
function idPart(t: string): string {
  let r = '';
  for (const b of Buffer.from(t, 'utf8')) {
    const c = String.fromCharCode(b);
    r += /[A-Za-z0-9_-]/.test(c) ? c : '-';
  }
  return r;
}

// ---------------------------------------------------------------- the extensions of the opened file

/**
 * DZS_EntityExts' state between reading a project file and its model being complete: the extensions of every block,
 * element of a block's lists and change, until a layer takes them for the element it restores.
 */
export class FileExtensions {
  readonly blocks = new Map<string, JV>();
  readonly elements = new Map<string, JV>();
  readonly changes = new Map<string, JV>();

  /** DZS_EntityExts.Of: the extensions object of an entity, undefined when it has none. */
  static of(entity: JV | undefined): JObj | undefined {
    const e = get(entity, EXT_MEMBER);
    return isObj(e) && e.m.size > 0 ? e : undefined;
  }

  /** DZS_EntityExts.Load. */
  static load(root: JV): FileExtensions {
    const f = new FileExtensions();
    const blocks = get(root, 'blocks');
    if (isArr(blocks)) {
      for (const b of blocks.a) {
        if (!isObj(b)) continue;
        const bid = getStr(b, 'id');
        if (bid === '') continue;
        const be = FileExtensions.of(b);
        if (be) f.blocks.set(bid, clone(be));
        const data = get(b, 'data');
        if (!isObj(data)) continue;
        for (const [list, items] of data.m) {
          if (!isArr(items)) continue;
          items.a.forEach((item, n) => {
            const ie = FileExtensions.of(item);
            if (ie) f.elements.set(`${bid}\n${list}\n${n}`, clone(ie));
          });
        }
      }
    }
    const changes = get(root, 'changes');
    if (isArr(changes)) {
      for (const ch of changes.a) {
        const ce = FileExtensions.of(ch);
        if (ce) f.changes.set(changeRef(ch), clone(ce));
      }
    }
    return f;
  }

  /** DZS_EntityExts.TakeInto: the extensions of that block or change go into the element's field `slot`. */
  takeInto(fields: Map<string, string>, slot: string, entity: JV): void {
    if (!isObj(entity)) return;
    let e: JV | undefined;
    if (entity.m.has('op')) {
      const cref = changeRef(entity);
      e = this.changes.get(cref);
      this.changes.delete(cref);
    } else {
      const bid = getStr(entity, 'id');
      e = this.blocks.get(bid);
      this.blocks.delete(bid);
    }
    if (e && count(e) > 0) fields.set(slot, compact(e));
  }

  get pending(): number {
    return this.blocks.size + this.elements.size + this.changes.size;
  }
}

/** DZS_EntityExts.ChangeSlot: the field with the extensions of a change an element makes. */
function changeSlot(change: JV): string {
  return getStr(change, 'op') === 'remove' ? `${EXT_SLOT}:remove` : `${EXT_SLOT}:${getStr(change, 'field')}`;
}

// ---------------------------------------------------------------- where a layer's elements come from and go to

/** DZS_LayerSrc: the elements a layer builds its blocks and changes from, or restores into. */
export interface LayerSrc {
  all(kind: string): string[];
  field(id: string, key: string): string;
  /** A restored element; blockId: the block it is made of ("" for a change), prefix: the editor's own block ids of the kind. */
  add(kind: string, fields: Map<string, string>, blockId?: string, prefix?: string): string;
  takeExts(fields: Map<string, string>, slot: string, entity: JV): void;
}

function blockIdOf(s: LayerSrc, id: string, prefix: string): string {
  const b = s.field(id, BID);
  return b !== '' ? b : prefix + idPart(id);
}

/** DZS_LayerSrc.Scratch: a set of elements that stands for no project. */
class ScratchSrc implements LayerSrc {
  private ids: string[] = [];
  private kinds = new Map<string, string>();
  private fields = new Map<string, Map<string, string>>();

  all(kind: string): string[] {
    return this.ids.filter((id) => this.kinds.get(id) === kind);
  }

  field(id: string, key: string): string {
    return this.fields.get(id)?.get(key) ?? '';
  }

  add(kind: string, fields: Map<string, string>, blockId = ''): string {
    if (blockId !== '') fields.set(BID, blockId);
    const id = `e${this.ids.length}`;
    this.ids.push(id);
    this.kinds.set(id, kind);
    this.fields.set(id, new Map(fields));
    return id;
  }

  takeExts(): void {}
}

/** What creates elements for DZS_LayerSrc.Into: the operation being built. */
export interface ElementSink {
  /** Creates a top-level element at the end of the project; with `fixedId`, "" when that id is taken. */
  create(kind: string, fields: Map<string, string>, fixedId?: string): string;
}

/** DZS_LayerSrc.Into: the operation that restores a layer's elements. */
export class RestoreSrc implements LayerSrc {
  constructor(
    private readonly sink: ElementSink,
    private readonly exts: FileExtensions,
  ) {}

  all(): string[] {
    return [];
  }

  field(): string {
    return '';
  }

  add(kind: string, fields: Map<string, string>, blockId = '', prefix = ''): string {
    if (blockId === '') return this.sink.create(kind, fields);
    fields.set(BID, blockId);
    // the element keeps the id its block id was made of, so the block keeps its id at the next save
    const keep = blockId.startsWith(prefix) && blockId.length > prefix.length ? blockId.slice(prefix.length) : '';
    if (keep !== '') {
      const made = this.sink.create(kind, fields, keep);
      if (made !== '') return made;
    }
    return this.sink.create(kind, fields);
  }

  takeExts(fields: Map<string, string>, slot: string, entity: JV): void {
    this.exts.takeInto(fields, slot, entity);
  }
}

/** A layer as the editor holds it: reading its part of the file into elements and building it back. */
export interface LayerModel {
  plugin: string;
  op: string;
  read(s: LayerSrc, frag: JV): void;
  build(s: LayerSrc): JObj | undefined;
}

function setNum(o: JObj, key: string, text: string): void {
  o.m.set(key, jNum(text));
}

function setStr(o: JObj, key: string, text: string): void {
  o.m.set(key, jStr(text));
}

function frag(blocks: JV[], changes: JV[]): JObj | undefined {
  if (!blocks.length && !changes.length) return undefined;
  const r = jObj();
  r.m.set('blocks', jArr(blocks));
  r.m.set('changes', jArr(changes));
  return r;
}

/** DZS_SpawnsModel.Block. */
function block(id: string, kind: string, parent: JV | undefined, parentId: string, data: JV): JObj {
  const b = jObj();
  setStr(b, 'id', id);
  setStr(b, 'kind', kind);
  b.m.set('parent', parentId !== '' ? jStr(parentId) : (parent ?? jNull()));
  b.m.set('data', data);
  return b;
}

/** DZS_SpawnsModel.NumOf: a member's text, "" when it is missing. */
function numOf(o: JV | undefined, key: string): string {
  if (!isObj(o)) return '';
  return mStr(o.m.get(key));
}

function listOf(v: JV | undefined): JV[] {
  return isArr(v) ? v.a : [];
}

// ---------------------------------------------------------------- Spawns (DZS_SpawnsModel)

function ownEventData(name: string, nominal: string): JObj {
  const d = jObj();
  setStr(d, 'name', name);
  const n = nominal === '' ? '1' : nominal;
  setNum(d, 'nominal', n);
  setNum(d, 'min', n);
  setNum(d, 'max', n);
  setNum(d, 'lifetime', '3888000');
  setNum(d, 'restock', '0');
  setNum(d, 'saferadius', '500');
  setNum(d, 'distanceradius', '500');
  setNum(d, 'cleanupradius', '200');
  const flags = jObj();
  setNum(flags, 'deletable', '0');
  setNum(flags, 'init_random', '0');
  setNum(flags, 'remove_damaged', '1');
  d.m.set('flags', flags);
  setStr(d, 'position', 'fixed');
  setStr(d, 'limit', 'child');
  setNum(d, 'active', '1');
  return d;
}

function pointKey(ev: string, x: string, z: string): JObj {
  const k = jObj();
  setStr(k, 'event', ev);
  setNum(k, 'x', x);
  setNum(k, 'z', z);
  return k;
}

function posJson(x: string, z: string, a: string): JObj {
  const p = jObj();
  setNum(p, 'x', x);
  setNum(p, 'z', z);
  if (a !== '') setNum(p, 'a', a);
  return p;
}

function ownEventIn(s: LayerSrc, name: string): string {
  return s.all(SPAWNS.event).find((id) => s.field(id, 'name') === name) ?? '';
}

export const spawnsModel: LayerModel = {
  plugin: SPAWNS.plugin,
  op: SPAWNS.op,

  build(s) {
    const blocks: JV[] = [];
    const changes: JV[] = [];
    for (const eid of s.all(SPAWNS.event)) {
      const bid = blockIdOf(s, eid, 'sp-');
      blocks.push(block(bid, 'event', undefined, '', ownEventData(s.field(eid, 'name'), s.field(eid, 'nominal'))));
      const cd = jObj();
      setStr(cd, 'type', s.field(eid, 'class'));
      setNum(cd, 'min', '1');
      setNum(cd, 'max', '1');
      setNum(cd, 'lootmin', '0');
      setNum(cd, 'lootmax', '0');
      blocks.push(block(`${bid}-c`, 'eventChild', undefined, bid, cd));
    }
    for (const pid of s.all(SPAWNS.point)) {
      const ev = s.field(pid, 'event');
      const x = s.field(pid, 'x');
      const z = s.field(pid, 'z');
      const a = s.field(pid, 'a');
      if (s.field(pid, 'origin') === 'base') {
        const key = pointKey(ev, s.field(pid, 'bx'), s.field(pid, 'bz'));
        const ch = jObj();
        if (s.field(pid, 'gone') === '1') {
          setStr(ch, 'op', 'remove');
          setStr(ch, 'block', 'spawnPosition');
          ch.m.set('key', key);
        } else {
          setStr(ch, 'op', 'set');
          setStr(ch, 'block', 'spawnPosition');
          ch.m.set('key', key);
          setStr(ch, 'field', 'pos');
          ch.m.set('from', posJson(s.field(pid, 'bx'), s.field(pid, 'bz'), s.field(pid, 'ba')));
          ch.m.set('to', posJson(x, z, a));
        }
        changes.push(ch);
        continue;
      }
      const pd = posJson(x, z, a);
      const own = ownEventIn(s, ev);
      if (own !== '') blocks.push(block(blockIdOf(s, pid, 'sp-'), 'spawnPosition', undefined, blockIdOf(s, own, 'sp-'), pd));
      else {
        const par = jObj();
        setStr(par, 'event', ev);
        blocks.push(block(blockIdOf(s, pid, 'sp-'), 'spawnPosition', par, '', pd));
      }
    }
    for (const sid of s.all(SPAWNS.set)) {
      const sev = s.field(sid, 'event');
      const field = s.field(sid, 'field');
      const sc = jObj();
      setStr(sc, 'op', 'set');
      const skey = jObj();
      let kind = 'event';
      let leaf = field;
      if (field.startsWith('child:')) {
        const parts = field.split(':');
        kind = 'eventChild';
        setStr(skey, 'event', sev);
        setStr(skey, 'type', parts[1] ?? '');
        leaf = parts[2] ?? '';
      } else setStr(skey, 'name', sev);
      setStr(sc, 'block', kind);
      sc.m.set('key', skey);
      setStr(sc, 'field', leaf);
      const from = s.field(sid, 'from');
      if (from !== '') setNum(sc, 'from', from);
      setNum(sc, 'to', s.field(sid, 'to'));
      changes.push(sc);
    }
    return frag(blocks, changes);
  },

  read(s, fragment) {
    if (!isObj(fragment)) return;
    const blocks = get(fragment, 'blocks');
    const changes = get(fragment, 'changes');
    const evName = new Map<string, string>();
    const evClass = new Map<string, string>();
    const evNominal = new Map<string, string>();
    const evBlock = new Map<string, JV>();
    const evChild = new Map<string, JV>();
    const evOrder: string[] = [];
    if (isArr(blocks)) {
      for (const bl of blocks.a) {
        const kind = getStr(bl, 'kind');
        const data = get(bl, 'data');
        const id = getStr(bl, 'id');
        if (kind === 'event') {
          evName.set(id, getStr(data, 'name'));
          const nom = get(data, 'nominal');
          if (nom) evNominal.set(id, mStr(nom));
          evOrder.push(id);
          evBlock.set(id, bl);
        } else if (kind === 'eventChild') {
          evClass.set(getStr(bl, 'parent'), getStr(data, 'type'));
          evChild.set(getStr(bl, 'parent'), bl);
        }
      }
      for (const eb of evOrder) {
        const f = new Map([
          ['name', evName.get(eb) ?? ''],
          ['class', evClass.get(eb) ?? ''],
          ['nominal', evNominal.get(eb) ?? ''],
        ]);
        s.takeExts(f, EXT_SLOT, evBlock.get(eb)!);
        const child = evChild.get(eb);
        if (child) s.takeExts(f, CHILD_SLOT, child);
        s.add(SPAWNS.event, f, eb, 'sp-');
      }
      for (const pb of blocks.a) {
        if (getStr(pb, 'kind') !== 'spawnPosition') continue;
        const pd = get(pb, 'data');
        const par = get(pb, 'parent');
        let ev = '';
        if (par?.t === 'str') ev = evName.get(par.s) ?? '';
        else if (par?.t === 'obj') ev = getStr(par, 'event');
        const pf = new Map([
          ['event', ev],
          ['origin', 'own'],
          ['x', numOf(pd, 'x')],
          ['z', numOf(pd, 'z')],
          ['a', numOf(pd, 'a')],
        ]);
        s.takeExts(pf, EXT_SLOT, pb);
        s.add(SPAWNS.point, pf, getStr(pb, 'id'), 'sp-');
      }
    }
    if (!isArr(changes)) return;
    for (const ch of changes.a) {
      const blk = getStr(ch, 'block');
      const key = get(ch, 'key');
      if (blk === 'spawnPosition') {
        const bf = new Map([
          ['event', getStr(key, 'event')],
          ['origin', 'base'],
          ['bx', numOf(key, 'x')],
          ['bz', numOf(key, 'z')],
        ]);
        if (getStr(ch, 'op') === 'remove') {
          bf.set('gone', '1');
          bf.set('x', numOf(key, 'x'));
          bf.set('z', numOf(key, 'z'));
        } else {
          bf.set('x', numOf(get(ch, 'to'), 'x'));
          bf.set('z', numOf(get(ch, 'to'), 'z'));
          bf.set('a', numOf(get(ch, 'to'), 'a'));
          bf.set('ba', numOf(get(ch, 'from'), 'a'));
        }
        s.takeExts(bf, changeSlot(ch), ch);
        s.add(SPAWNS.point, bf);
        continue;
      }
      const sf = new Map<string, string>();
      if (blk === 'eventChild') {
        sf.set('event', getStr(key, 'event'));
        sf.set('field', `child:${getStr(key, 'type')}:${getStr(ch, 'field')}`);
      } else {
        sf.set('event', getStr(key, 'name'));
        sf.set('field', getStr(ch, 'field'));
      }
      sf.set('from', numOf(ch, 'from'));
      sf.set('to', numOf(ch, 'to'));
      s.takeExts(sf, changeSlot(ch), ch);
      s.add(SPAWNS.set, sf);
    }
  },
};

// ---------------------------------------------------------------- Effects (DZS_EffectsModel)

/** DZS_EffectsModel.PresetOf: the preset an existing area looks like. */
export function presetOf(type: string, around: string): string {
  if (type === 'ContaminatedArea_Static') return 'gas';
  if (type === 'GeyserArea') return 'geyser';
  if (type === 'HotSpringArea') return 'spring';
  if (type === 'VolcanicArea') return 'volcanic';
  if (type === 'SpookyArea' && around.includes('cupid')) return 'hearts';
  if (type === 'SpookyArea') return 'smoke';
  return '';
}

export const EFFECT_PRESETS = ['gas', 'geyser', 'spring', 'volcanic', 'hearts', 'smoke'] as const;

/** DZS_EffectsModel.PresetName, as the English editor names them. */
export function presetName(p: string): string {
  const names: Record<string, string> = {
    gas: 'Gas',
    geyser: 'Geyser',
    spring: 'Hot spring',
    volcanic: 'Volcanic vent',
    hearts: 'Hearts',
    smoke: 'Smoke',
  };
  return names[p] ?? p;
}

/** DZS_EffectsModel.PresetData: a complete effect area of a preset. */
export function presetData(preset: string, name: string, x: string, z: string, r: string, above = ''): JObj {
  let type = 'SpookyArea';
  let trig = '';
  let part = '';
  let around = '';
  let tiny = '';
  let ppe = '';
  let posH = '20';
  let negH = '5';
  let inner = '0';
  let innerDist = '0';
  let outerOff = '0';
  let interval = '0';
  let duration = '0';
  if (preset === 'gas') {
    type = 'ContaminatedArea_Static';
    trig = 'ContaminatedTrigger';
    part = 'graphics/particles/contaminated_area_gas_bigass';
    around = 'graphics/particles/contaminated_area_gas_around';
    tiny = 'graphics/particles/contaminated_area_gas_around_tiny';
    ppe = 'PPERequester_ContaminatedAreaTint';
    negH = '3';
    innerDist = '80';
    outerOff = '30';
  } else if (preset === 'geyser') {
    type = 'GeyserArea';
    trig = 'GeyserTrigger';
    interval = '3600';
    duration = '30';
  } else if (preset === 'spring') {
    type = 'HotSpringArea';
    trig = 'HotSpringTrigger';
    posH = '5';
  } else if (preset === 'volcanic') {
    type = 'VolcanicArea';
    trig = 'VolcanicTrigger';
  } else if (preset === 'hearts') {
    trig = 'SpookyTrigger';
    around = 'graphics/particles/cupid_bolt';
    tiny = 'graphics/particles/cupid_bolt';
    negH = '10';
  } else {
    part = 'graphics/particles/smoke_heli_wreck_01';
    posH = '10';
    negH = '2';
    inner = '1';
    innerDist = '1';
  }
  const d = jObj();
  setStr(d, 'AreaName', name);
  setStr(d, 'Type', type);
  setStr(d, 'TriggerType', trig);
  if (above !== '') setNum(d, 'aboveGround', above);
  const data = jObj();
  const pos = above === '' ? [jNum(x), jNum('0'), jNum(z)] : [jNum(x), jNum(z)];
  data.m.set('Pos', jArr(pos));
  setNum(data, 'Radius', r);
  setNum(data, 'PosHeight', posH);
  setNum(data, 'NegHeight', negH);
  setNum(data, 'InnerRingCount', inner);
  setNum(data, 'InnerPartDist', innerDist);
  data.m.set('OuterRingToggle', { t: 'bool', b: false });
  setNum(data, 'OuterPartDist', '0');
  setNum(data, 'OuterOffset', outerOff);
  setNum(data, 'VerticalLayers', '0');
  setNum(data, 'VerticalOffset', '0');
  setStr(data, 'ParticleName', part);
  setNum(data, 'EffectInterval', interval);
  setNum(data, 'EffectDuration', duration);
  data.m.set('EffectModifier', { t: 'bool', b: false });
  d.m.set('Data', data);
  const pd = jObj();
  setStr(pd, 'AroundPartName', around);
  setStr(pd, 'TinyPartName', tiny);
  setStr(pd, 'PPERequesterType', ppe);
  d.m.set('PlayerData', pd);
  return d;
}

function nameKey(name: string): JObj {
  const k = jObj();
  setStr(k, 'name', name);
  return k;
}

function vecPart(v: JV | undefined, i: number): string {
  if (!isArr(v) || v.a.length <= i) return '';
  return mStr(v.a[i]);
}

export const effectsModel: LayerModel = {
  plugin: EFFECTS.plugin,
  op: EFFECTS.op,

  build(s) {
    const blocks: JV[] = [];
    const changes: JV[] = [];
    for (const oid of s.all(EFFECTS.area)) {
      const data = presetData(
        s.field(oid, 'preset'),
        s.field(oid, 'name'),
        s.field(oid, 'x'),
        s.field(oid, 'z'),
        s.field(oid, 'r'),
        s.field(oid, 'above'),
      );
      blocks.push(block(blockIdOf(s, oid, 'fx-'), 'effectArea', undefined, '', data));
    }
    for (const cid of s.all(EFFECTS.change)) {
      const name = s.field(cid, 'area');
      if (s.field(cid, 'gone') === '1') {
        const rc = jObj();
        setStr(rc, 'op', 'remove');
        setStr(rc, 'block', 'effectArea');
        rc.m.set('key', nameKey(name));
        changes.push(rc);
        continue;
      }
      const by = s.field(cid, 'by');
      if (s.field(cid, 'x') !== s.field(cid, 'bx') || s.field(cid, 'z') !== s.field(cid, 'bz')) {
        const pc = jObj();
        setStr(pc, 'op', 'set');
        setStr(pc, 'block', 'effectArea');
        pc.m.set('key', nameKey(name));
        setStr(pc, 'field', 'Data.Pos');
        pc.m.set('from', jArr([jNum(s.field(cid, 'bx')), jNum(by), jNum(s.field(cid, 'bz'))]));
        pc.m.set('to', jArr([jNum(s.field(cid, 'x')), jNum(by), jNum(s.field(cid, 'z'))]));
        changes.push(pc);
      }
      if (s.field(cid, 'r') !== s.field(cid, 'br')) {
        const qc = jObj();
        setStr(qc, 'op', 'set');
        setStr(qc, 'block', 'effectArea');
        qc.m.set('key', nameKey(name));
        setStr(qc, 'field', 'Data.Radius');
        setNum(qc, 'from', s.field(cid, 'br'));
        setNum(qc, 'to', s.field(cid, 'r'));
        changes.push(qc);
      }
    }
    return frag(blocks, changes);
  },

  read(s, fragment) {
    if (!isObj(fragment)) return;
    for (const bl of listOf(get(fragment, 'blocks'))) {
      if (getStr(bl, 'kind') !== 'effectArea') continue;
      const d = get(bl, 'data');
      const data = get(d, 'Data');
      const pd = get(d, 'PlayerData');
      const pos = get(data, 'Pos');
      const f = new Map<string, string>();
      f.set('name', getStr(d, 'AreaName'));
      f.set('preset', presetOf(getStr(d, 'Type'), getStr(pd, 'AroundPartName')));
      // a position above the ground is [x, z]
      const zi = isArr(pos) && pos.a.length === 2 ? 1 : 2;
      f.set('x', vecPart(pos, 0));
      f.set('z', vecPart(pos, zi));
      const ab = get(d, 'aboveGround');
      if (ab?.t === 'num') f.set('above', ab.s);
      f.set('r', mStr(get(data, 'Radius')));
      s.takeExts(f, EXT_SLOT, bl);
      s.add(EFFECTS.area, f, getStr(bl, 'id'), 'fx-');
    }
    const changes = get(fragment, 'changes');
    if (!isArr(changes)) return;
    const by = new Map<string, Map<string, string>>();
    const order: string[] = [];
    for (const ch of changes.a) {
      const name = getStr(get(ch, 'key'), 'name');
      let f2 = by.get(name);
      if (!f2) {
        f2 = new Map([['area', name]]);
        by.set(name, f2);
        order.push(name);
      }
      s.takeExts(f2, changeSlot(ch), ch);
      if (getStr(ch, 'op') === 'remove') {
        f2.set('gone', '1');
        continue;
      }
      if (getStr(ch, 'field') === 'Data.Pos') {
        const from = get(ch, 'from');
        const to = get(ch, 'to');
        f2.set('bx', vecPart(from, 0));
        f2.set('by', vecPart(from, 1));
        f2.set('bz', vecPart(from, 2));
        f2.set('x', vecPart(to, 0));
        f2.set('z', vecPart(to, 2));
      } else if (getStr(ch, 'field') === 'Data.Radius') {
        f2.set('br', mStr(get(ch, 'from')));
        f2.set('r', mStr(get(ch, 'to')));
      }
    }
    for (const n of order) {
      const ff = by.get(n)!;
      // a change that only moved keeps the radius as it was, one that only resized keeps the position
      if (!ff.has('r')) {
        ff.set('r', '');
        ff.set('br', '');
      }
      if (!ff.has('x')) {
        ff.set('x', '');
        ff.set('bx', '');
        ff.set('z', '');
        ff.set('bz', '');
      }
      s.add(EFFECTS.change, ff);
    }
  },
};

// ---------------------------------------------------------------- Territories (DZS_TerrModel)

export const ZOMBIE_TERRITORIES = 'env/zombie_territories.xml';

function zoneKey(file: string, name: string, x: string, z: string): JObj {
  const k = jObj();
  setStr(k, 'file', file);
  setStr(k, 'name', name);
  setNum(k, 'x', x);
  setNum(k, 'z', z);
  return k;
}

function setChange(changes: JV[], key: JObj, field: string, from: string, to: string): void {
  if (to === '' || to === from) return;
  const c = jObj();
  setStr(c, 'op', 'set');
  setStr(c, 'block', 'territoryZone');
  c.m.set('key', key);
  setStr(c, 'field', field);
  if (from !== '') setNum(c, 'from', from);
  setNum(c, 'to', to);
  changes.push(c);
}

const or = (a: string, b: string): string => (a === '' ? b : a);

export const territoriesModel: LayerModel = {
  plugin: TERRITORIES.plugin,
  op: TERRITORIES.op,

  build(s) {
    const blocks: JV[] = [];
    const changes: JV[] = [];
    for (const tid of s.all(TERRITORIES.territory)) {
      const td = jObj();
      setStr(td, 'file', s.field(tid, 'file'));
      setStr(td, 'color', s.field(tid, 'color'));
      blocks.push(block(blockIdOf(s, tid, 'tr-'), 'territory', undefined, '', td));
    }
    for (const zid of s.all(TERRITORIES.zone)) {
      const zd = jObj();
      setStr(zd, 'name', s.field(zid, 'name'));
      setNum(zd, 'smin', or(s.field(zid, 'smin'), '0'));
      setNum(zd, 'smax', or(s.field(zid, 'smax'), '0'));
      setNum(zd, 'dmin', or(s.field(zid, 'dmin'), '0'));
      setNum(zd, 'dmax', or(s.field(zid, 'dmax'), '0'));
      setNum(zd, 'x', s.field(zid, 'x'));
      setNum(zd, 'z', s.field(zid, 'z'));
      setNum(zd, 'r', s.field(zid, 'r'));
      const owner = s.field(zid, 'territory');
      if (owner !== '') blocks.push(block(blockIdOf(s, zid, 'tz-'), 'territoryZone', undefined, blockIdOf(s, owner, 'tr-'), zd));
      else {
        const par = jObj();
        setStr(par, 'file', s.field(zid, 'file'));
        setStr(par, 'color', s.field(zid, 'color'));
        blocks.push(block(blockIdOf(s, zid, 'tz-'), 'territoryZone', par, '', zd));
      }
    }
    for (const cid of s.all(TERRITORIES.change)) {
      const file = s.field(cid, 'file');
      const name = s.field(cid, 'name');
      const bx = s.field(cid, 'bx');
      const bz = s.field(cid, 'bz');
      if (s.field(cid, 'gone') === '1') {
        const rc = jObj();
        setStr(rc, 'op', 'remove');
        setStr(rc, 'block', 'territoryZone');
        rc.m.set('key', zoneKey(file, name, bx, bz));
        changes.push(rc);
        continue;
      }
      setChange(changes, zoneKey(file, name, bx, bz), 'x', bx, s.field(cid, 'x'));
      setChange(changes, zoneKey(file, name, bx, bz), 'z', bz, s.field(cid, 'z'));
      setChange(changes, zoneKey(file, name, bx, bz), 'r', s.field(cid, 'br'), s.field(cid, 'r'));
      setChange(changes, zoneKey(file, name, bx, bz), 'dmin', s.field(cid, 'bdmin'), s.field(cid, 'dmin'));
      setChange(changes, zoneKey(file, name, bx, bz), 'dmax', s.field(cid, 'bdmax'), s.field(cid, 'dmax'));
    }
    for (const nid of s.all(TERRITORIES.nominal)) {
      const nc = jObj();
      setStr(nc, 'op', 'set');
      setStr(nc, 'block', 'event');
      const nk = jObj();
      setStr(nk, 'name', s.field(nid, 'event'));
      nc.m.set('key', nk);
      setStr(nc, 'field', 'nominal');
      const nf = s.field(nid, 'from');
      if (nf !== '') setNum(nc, 'from', nf);
      setNum(nc, 'to', s.field(nid, 'to'));
      changes.push(nc);
    }
    return frag(blocks, changes);
  },

  read(s, fragment) {
    if (!isObj(fragment)) return;
    const terrIds = new Map<string, string>();
    const blocks = get(fragment, 'blocks');
    if (isArr(blocks)) {
      for (const bl of blocks.a) {
        if (getStr(bl, 'kind') !== 'territory') continue;
        const td = get(bl, 'data');
        const tf = new Map([
          ['file', getStr(td, 'file')],
          ['color', getStr(td, 'color')],
        ]);
        s.takeExts(tf, EXT_SLOT, bl);
        terrIds.set(getStr(bl, 'id'), s.add(TERRITORIES.territory, tf, getStr(bl, 'id'), 'tr-'));
      }
      for (const zb of blocks.a) {
        if (getStr(zb, 'kind') !== 'territoryZone') continue;
        const zd = get(zb, 'data');
        const zf = new Map<string, string>();
        for (const key of ['name', 'smin', 'smax', 'dmin', 'dmax', 'x', 'z', 'r']) {
          const v = get(zd, key);
          if (v) zf.set(key, mStr(v));
        }
        const par = get(zb, 'parent');
        if (par?.t === 'str') zf.set('territory', terrIds.get(par.s) ?? '');
        else if (par?.t === 'obj') {
          zf.set('file', getStr(par, 'file'));
          zf.set('color', getStr(par, 'color'));
        }
        s.takeExts(zf, EXT_SLOT, zb);
        s.add(TERRITORIES.zone, zf, getStr(zb, 'id'), 'tz-');
      }
    }
    const changes = get(fragment, 'changes');
    if (!isArr(changes)) return;
    const by = new Map<string, Map<string, string>>();
    const order: string[] = [];
    for (const ch of changes.a) {
      const key2 = get(ch, 'key');
      if (getStr(ch, 'block') === 'event') {
        const nf = new Map([['event', getStr(key2, 'name')]]);
        const from = get(ch, 'from');
        if (from) nf.set('from', mStr(from));
        nf.set('to', mStr(get(ch, 'to')));
        s.takeExts(nf, changeSlot(ch), ch);
        s.add(TERRITORIES.nominal, nf);
        continue;
      }
      const kx = mStr(get(key2, 'x'));
      const kz = mStr(get(key2, 'z'));
      const id = `${getStr(key2, 'file')}:${getStr(key2, 'name')}:${kx}:${kz}`;
      let f = by.get(id);
      if (!f) {
        f = new Map([
          ['file', getStr(key2, 'file')],
          ['name', getStr(key2, 'name')],
          ['bx', kx],
          ['bz', kz],
        ]);
        by.set(id, f);
        order.push(id);
      }
      s.takeExts(f, changeSlot(ch), ch);
      if (getStr(ch, 'op') === 'remove') {
        f.set('gone', '1');
        continue;
      }
      const field = getStr(ch, 'field');
      f.set(field, mStr(get(ch, 'to')));
      const was = get(ch, 'from');
      if (was && field !== 'x' && field !== 'z') f.set(`b${field}`, mStr(was));
    }
    for (const oid of order) s.add(TERRITORIES.change, by.get(oid)!);
  },
};

/** The layers in the order dzStudio's plugins restore them when a project opens (the order they are loaded in). */
export const RESTORE_ORDER: readonly LayerModel[] = [effectsModel, spawnsModel, territoriesModel];

// ---------------------------------------------------------------- what each layer takes from an opened file (DZS_LayerTake)

/** DZS_LayerTake.Frag. */
function emptyFrag(): JObj {
  const f = jObj();
  f.m.set('blocks', jArr());
  f.m.set('changes', jArr());
  return f;
}

function fragList(f: JObj, which: 'blocks' | 'changes'): JV[] {
  return (f.m.get(which) as JArr).a;
}

/** DZS_LayerTake.Holds: whether the layer, restoring the unit (after the context's blocks) and building it again, writes exactly the unit and the context. */
function holds(model: LayerModel, unit: JObj, contextBlocks: JV[] | undefined): boolean {
  const input = emptyFrag();
  if (contextBlocks) fragList(input, 'blocks').push(...contextBlocks);
  fragList(input, 'blocks').push(...fragList(unit, 'blocks'));
  fragList(input, 'changes').push(...fragList(unit, 'changes'));
  const s = new ScratchSrc();
  model.read(s, input);
  const built = model.build(s);
  if (!built) return false;
  return same(fragList(input, 'blocks'), fragList(built, 'blocks')) && same(fragList(input, 'changes'), fragList(built, 'changes'));
}

function dataOf(b: JV): JObj | undefined {
  const d = get(b, 'data');
  return isObj(d) ? d : undefined;
}

function isTop(b: JV): boolean {
  const p = get(b, 'parent');
  return !p || p.t === 'null';
}

function keyed(change: JV): boolean {
  return isObj(get(change, 'key'));
}

/** DZS_LayerTake.TerritoryEvent: events of the Territories layer. */
export function territoryEvent(name: string): boolean {
  return name.startsWith('Animal') || name.startsWith('Ambient') || name.startsWith('Infected');
}

class LayerTake {
  private usedB: boolean[];
  private usedC: boolean[];

  constructor(
    private readonly blocks: JV[],
    private readonly changes: JV[],
  ) {
    this.usedB = blocks.map(() => false);
    this.usedC = changes.map(() => false);
  }

  private pick(blocks: number[] | null, changes: number[] | null): JObj {
    const f = emptyFrag();
    for (const b of blocks ?? []) fragList(f, 'blocks').push(this.blocks[b]!);
    for (const c of changes ?? []) fragList(f, 'changes').push(this.changes[c]!);
    return f;
  }

  private claim(f: JObj, blocks: number[] | null, changes: number[] | null): void {
    for (const b of blocks ?? []) {
      this.usedB[b] = true;
      fragList(f, 'blocks').push(withoutExtensions(this.blocks[b]!));
    }
    for (const c of changes ?? []) {
      this.usedC[c] = true;
      fragList(f, 'changes').push(withoutExtensions(this.changes[c]!));
    }
  }

  spawns(): JObj {
    const f = emptyFrag();
    const evById = new Map<string, JV[]>();
    const evByName = new Map<string, JV[]>();
    this.blocks.forEach((ev, i) => {
      if (this.usedB[i] || !isObj(ev) || getStr(ev, 'kind') !== 'event' || !dataOf(ev) || !isTop(ev)) return;
      const evId = getStr(ev, 'id');
      let unit = [i];
      this.blocks.forEach((ch, c) => {
        const par = get(ch, 'parent');
        if (c !== i && isObj(ch) && par?.t === 'str' && par.s === evId && getStr(ch, 'kind') !== 'spawnPosition') {
          if (!dataOf(ch)) unit = [];
          else if (unit.length > 0) unit.push(c);
        }
      });
      if (!unit.length) return;
      const units = this.pick(unit, null);
      if (!holds(spawnsModel, units, undefined)) return;
      this.claim(f, unit, null);
      evById.set(evId, fragList(units, 'blocks'));
      evByName.set(getStr(dataOf(ev), 'name'), fragList(units, 'blocks'));
    });
    this.blocks.forEach((pos, p) => {
      if (this.usedB[p] || !isObj(pos) || getStr(pos, 'kind') !== 'spawnPosition' || !dataOf(pos)) return;
      const par = get(pos, 'parent');
      let context: JV[] | undefined;
      if (par?.t === 'str') {
        context = evById.get(par.s);
        if (!context) return;
      } else if (par?.t === 'obj') context = evByName.get(getStr(par, 'event'));
      else return;
      if (holds(spawnsModel, this.pick([p], null), context)) this.claim(f, [p], null);
    });
    this.changes.forEach((c2, k) => {
      if (this.usedC[k] || !isObj(c2) || !keyed(c2)) return;
      const blk = getStr(c2, 'block');
      if (blk === 'spawnPosition') {
        if (getStr(c2, 'op') !== 'remove' && !isObj(get(c2, 'to'))) return;
      } else if (blk === 'event') {
        if (getStr(c2, 'op') !== 'set' || getStr(c2, 'field') !== 'nominal' || territoryEvent(getStr(get(c2, 'key'), 'name'))) return;
      } else if (blk === 'eventChild') {
        if (getStr(c2, 'op') !== 'set' || getStr(c2, 'field') !== 'max') return;
      } else return;
      if (holds(spawnsModel, this.pick(null, [k]), undefined)) this.claim(f, null, [k]);
    });
    return f;
  }

  effects(): JObj {
    const f = emptyFrag();
    this.blocks.forEach((b, i) => {
      if (this.usedB[i] || !isObj(b) || getStr(b, 'kind') !== 'effectArea' || !isTop(b)) return;
      const d = dataOf(b);
      const data = get(d, 'Data');
      if (!d || !isObj(data) || !isObj(get(d, 'PlayerData')) || !get(data, 'Radius') || !isArr(get(data, 'Pos'))) return;
      if (holds(effectsModel, this.pick([i], null), undefined)) this.claim(f, [i], null);
    });
    // one element per base area: all its changes or none
    const names: string[] = [];
    const byName = new Map<string, number[]>();
    this.changes.forEach((c, k) => {
      if (this.usedC[k] || !isObj(c) || getStr(c, 'block') !== 'effectArea' || !keyed(c)) return;
      const n = getStr(get(c, 'key'), 'name');
      let list = byName.get(n);
      if (!list) {
        list = [];
        byName.set(n, list);
        names.push(n);
      }
      list.push(k);
    });
    for (const name of names) {
      const group = byName.get(name)!;
      const ok = group.every((at) => {
        const gc = this.changes[at]!;
        return getStr(gc, 'op') === 'remove' || (!!get(gc, 'to') && !!get(gc, 'from'));
      });
      if (!ok) continue;
      if (holds(effectsModel, this.pick(null, group), undefined)) this.claim(f, null, group);
    }
    return f;
  }

  territories(): JObj {
    const f = emptyFrag();
    const terrs = new Map<string, JV[]>();
    this.blocks.forEach((t, i) => {
      if (this.usedB[i] || !isObj(t) || getStr(t, 'kind') !== 'territory' || !dataOf(t) || !isTop(t)) return;
      const tu = this.pick([i], null);
      if (!holds(territoriesModel, tu, undefined)) return;
      this.claim(f, [i], null);
      terrs.set(getStr(t, 'id'), fragList(tu, 'blocks'));
    });
    this.blocks.forEach((zb, z) => {
      if (this.usedB[z] || !isObj(zb) || getStr(zb, 'kind') !== 'territoryZone' || !dataOf(zb)) return;
      const par = get(zb, 'parent');
      let context: JV[] | undefined;
      if (par?.t === 'str') {
        context = terrs.get(par.s);
        if (!context) return;
      } else if (par?.t !== 'obj') return;
      if (holds(territoriesModel, this.pick([z], null), context)) this.claim(f, [z], null);
    });
    const keys: string[] = [];
    const byKey = new Map<string, number[]>();
    this.changes.forEach((c, k) => {
      if (this.usedC[k] || !isObj(c) || !keyed(c)) return;
      const blk = getStr(c, 'block');
      if (blk === 'event') {
        if (
          getStr(c, 'op') !== 'set' ||
          getStr(c, 'field') !== 'nominal' ||
          !territoryEvent(getStr(get(c, 'key'), 'name')) ||
          !get(c, 'to')
        )
          return;
        if (holds(territoriesModel, this.pick(null, [k]), undefined)) this.claim(f, null, [k]);
        return;
      }
      if (blk !== 'territoryZone') return;
      const key = get(c, 'key');
      if (!get(key, 'x') || !get(key, 'z') || (getStr(c, 'op') !== 'remove' && !get(c, 'to'))) return;
      const id = `${getStr(key, 'file')}:${getStr(key, 'name')}:${mStr(get(key, 'x'))}:${mStr(get(key, 'z'))}`;
      let list = byKey.get(id);
      if (!list) {
        list = [];
        byKey.set(id, list);
        keys.push(id);
      }
      list.push(k);
    });
    for (const zk of keys) {
      const group = byKey.get(zk)!;
      if (holds(territoriesModel, this.pick(null, group), undefined)) this.claim(f, null, group);
    }
    return f;
  }
}

function pluginsOf(part: JObj): JObj {
  const plugins = part.m.get('plugins');
  if (isObj(plugins)) return plugins;
  const fresh = jObj();
  part.m.set('plugins', fresh);
  return fresh;
}

/** DZS_LayerTake.Put: part.plugins.territories/spawns/effects made anew from the root's blocks and changes. */
export function putLayers(root: JObj, part: JObj): void {
  const plugins = pluginsOf(part);
  const t = new LayerTake(listOf(get(root, 'blocks')), listOf(get(root, 'changes')));
  const put = (name: string, f: JObj): void => {
    if (count(f.m.get('blocks')) + count(f.m.get('changes')) === 0) plugins.m.delete(name);
    else plugins.m.set(name, f);
  };
  put(TERRITORIES.plugin, t.territories());
  put(SPAWNS.plugin, t.spawns());
  put(EFFECTS.plugin, t.effects());
}

// ---------------------------------------------------------------- what the opening carries over (DZS_KeptBlocks)

/** DZS_KeptBlocks.Of: {blocks, changes, slug?} of the root that the open leaves to nobody (loot is off). */
function keptOf(root: JObj, part: JObj): JObj | undefined {
  const layerBlocks = new Set<string>();
  const layerChanges = new Set<string>();
  const plugins = part.m.get('plugins');
  if (isObj(plugins)) {
    for (const [name, f] of plugins.m) {
      if (name === KEPT || !isObj(f)) continue;
      for (const one of listOf(get(f, 'blocks'))) if (isObj(one)) layerBlocks.add(getStr(one, 'id'));
      for (const two of listOf(get(f, 'changes'))) if (isObj(two)) layerChanges.add(changeRef(two));
    }
  }
  const blocks = listOf(get(root, 'blocks')).filter(
    (b) => isObj(b) && getStr(b, 'kind') !== 'spawnerGroup' && !layerBlocks.has(getStr(b, 'id')),
  );
  const changes = listOf(get(root, 'changes')).filter((c) => isObj(c) && !layerChanges.has(changeRef(c)));
  const slug = getStr(root, 'slug');
  if (!blocks.length && !changes.length && slug === '') return undefined;
  const kept = jObj();
  kept.m.set('blocks', jArr(blocks));
  kept.m.set('changes', jArr(changes));
  if (slug !== '') kept.m.set('slug', jStr(slug));
  return kept;
}

/** DZS_KeptBlocks.Put: the kept entries of the root under part.plugins.kept (an older one replaced). */
export function putKept(root: JObj, part: JObj): JObj | undefined {
  const plugins = part.m.get('plugins');
  if (isObj(plugins)) plugins.m.delete(KEPT);
  const kept = keptOf(root, part);
  if (!kept) return undefined;
  pluginsOf(part).m.set(KEPT, kept);
  return kept;
}

// ---------------------------------------------------------------- the project's own extensions

/** dzStudio's editor extension: the URL of its spec (the version is part of it). */
export const EDITOR_EXT = 'https://developers.dzbot.de/specs/dzstudio/editor/1.json';
/** The dzbot rules, the one project extension a plugin of dzStudio reads. */
export const DZBOT_RULES = 'https://developers.dzbot.de/specs/dzbot/rules/1.json';
/** Field of the project element with the extensions the project carries. */
export const EXT_LIST = 'ext:list';
/** Field of the project element with a project extension's data: + its URL. */
export const EXT_PROJECT = 'ext:project:';

/** A project field edit the opening makes as a system operation of its own (projects:edit). */
export interface ProjectFieldEdit {
  field: string;
  value: string;
}

/**
 * DZS_ProjectExtensions.Opened for a file whose entities' extensions all went to the layers: the project's list of
 * extensions into the model, then each extension's data, every one a system operation of its own.
 */
export function openedExtensionEdits(root: JObj): ProjectFieldEdit[] {
  const list = get(root, 'extensions');
  if (!isObj(list)) return [];
  const loaded = jObj();
  for (const [url, entry] of list.m) {
    if (url === EDITOR_EXT) continue;
    if (!isObj(entry)) {
      loaded.m.set(url, clone(entry));
      continue;
    }
    const meta = jObj();
    for (const [k, x] of entry.m) meta.m.set(k, k === 'data' ? jNull() : clone(x));
    loaded.m.set(url, meta);
  }
  const edits: ProjectFieldEdit[] = [];
  if (loaded.m.size > 0) edits.push({ field: EXT_LIST, value: compact(loaded) });
  const dataOfEntry = (url: string): JV | undefined => {
    const entry = list.m.get(url);
    return isObj(entry) ? entry.m.get('data') : undefined;
  };
  const rules = list.m.has(DZBOT_RULES) ? dataOfEntry(DZBOT_RULES) : undefined;
  if (isObj(rules) && rules.m.size > 0) edits.push({ field: EXT_PROJECT + DZBOT_RULES, value: compact(rules) });
  for (const url of loaded.m.keys()) {
    if (url === DZBOT_RULES) continue;
    const data = dataOfEntry(url);
    if (data) edits.push({ field: EXT_PROJECT + url, value: compact(data) });
  }
  return edits;
}

// ---------------------------------------------------------------- numbers as the layers write them

/** DZS_PatchNum.Split: sign, integer and fraction digits of a number text, the exponent applied; undefined if it is none. */
function splitNum(t: string): { neg: boolean; ip: string; fp: string } | undefined {
  const n = t.length;
  if (n === 0) return undefined;
  let i = 0;
  let neg = false;
  if (t[0] === '-' || t[0] === '+') {
    neg = t[0] === '-';
    i = 1;
  }
  let ip = '';
  let fp = '';
  let dot = false;
  let any = false;
  for (; i < n; i++) {
    const c = t[i]!;
    if (c === '.') {
      if (dot) return undefined;
      dot = true;
    } else if (c === 'e' || c === 'E') break;
    else if (c >= '0' && c <= '9') {
      any = true;
      if (dot) fp += c;
      else ip += c;
    } else return undefined;
  }
  if (!any) return undefined;
  if (i < n) {
    let ex = t.slice(i + 1);
    if (ex === '') return undefined;
    let eneg = false;
    if (ex[0] === '-' || ex[0] === '+') {
      eneg = ex[0] === '-';
      ex = ex.slice(1);
    }
    if (ex === '' || ex.length > 3 || !/^[0-9]+$/.test(ex)) return undefined;
    for (let shift = Number(ex); shift > 0; shift--) {
      if (eneg) {
        if (ip.length > 0) {
          fp = ip[ip.length - 1] + fp;
          ip = ip.slice(0, -1);
        } else fp = '0' + fp;
      } else if (fp.length > 0) {
        ip += fp[0];
        fp = fp.slice(1);
      } else ip += '0';
    }
  }
  while (ip.length > 1 && ip[0] === '0') ip = ip.slice(1);
  if (ip === '') ip = '0';
  return { neg, ip, fp };
}

function round6(t: string): { neg: boolean; ip: string; f6: string } | undefined {
  const sp = splitNum(t);
  if (!sp) return undefined;
  let { neg, ip, fp } = sp;
  let up = false;
  if (fp.length > 6) {
    up = Number(fp[6]) >= 5;
    fp = fp.slice(0, 6);
  }
  fp = fp.padEnd(6, '0');
  let f6 = fp;
  if (up) {
    const all = (BigInt(ip + fp) + 1n).toString().padStart(ip.length + 6, '0');
    ip = all.slice(0, all.length - 6);
    f6 = all.slice(all.length - 6);
  }
  if (ip === '') ip = '0';
  if (ip === '0' && f6 === '000000') neg = false;
  return { neg, ip, f6 };
}

/** DZS_PatchNum.Fixed6: six decimals. */
export function fixed6(t: string): string {
  const r = round6(t);
  if (!r) return t;
  return `${r.neg ? '-' : ''}${r.ip}.${r.f6}`;
}

/** DZS_PatchNum.Canon: rounded to six decimals, trailing zeros and a bare point dropped. */
export function canon6(t: string): string {
  const r = round6(t);
  if (!r) return t;
  const f = r.f6.replace(/0+$/, '');
  return `${r.neg ? '-' : ''}${r.ip}${f ? `.${f}` : ''}`;
}

/** The exact decimal text of a finite, positive double ("1234.5677490234375"). */
function exactDecimal(v: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, v);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mant = bits & ((1n << 52n) - 1n);
  if (biased !== 0) mant |= 1n << 52n;
  const exp = (biased === 0 ? 1 : biased) - 1075;
  if (exp >= 0) return (mant << BigInt(exp)).toString();
  const digits = (mant * 5n ** BigInt(-exp)).toString().padStart(-exp + 1, '0');
  const ip = digits.slice(0, digits.length + exp);
  const fp = digits.slice(digits.length + exp).replace(/0+$/, '');
  return fp ? `${ip}.${fp}` : ip;
}

/**
 * The game's float-to-text (float.ToString) of a float32: six significant digits, like C's %g. The layers write
 * every number they compute through it.
 */
export function gameFloat(x: number): string {
  const v = Math.fround(x);
  if (v === 0) return '0';
  if (!Number.isFinite(v)) return String(v);
  const neg = v < 0;
  // the exact decimal value of the float32, then rounded half to even to six significant digits
  const exact = exactDecimal(Math.abs(v));
  const [ip = '', fp = ''] = exact.split('.');
  let digits = (ip + fp).replace(/^0+/, '');
  let e10 = ip === '0' ? -(fp.length - fp.replace(/^0+/, '').length) - 1 : ip.length - 1;
  let head = BigInt(digits.slice(0, 6).padEnd(6, '0'));
  const rest = digits.slice(6);
  if (rest.length > 0) {
    const first = Number(rest[0]);
    const beyond = /[1-9]/.test(rest.slice(1));
    if (first > 5 || (first === 5 && (beyond || head % 2n === 1n))) head += 1n;
  }
  if (head === 1000000n) {
    head = 100000n;
    e10++;
  }
  digits = head.toString();
  const sign = neg ? '-' : '';
  if (e10 < -4 || e10 >= 6) {
    const m = digits.replace(/0+$/, '');
    const mant = m.length > 1 ? `${m[0]}.${m.slice(1)}` : m;
    return `${sign}${mant}e${e10 < 0 ? '-' : '+'}${String(Math.abs(e10)).padStart(2, '0')}`;
  }
  let text: string;
  if (e10 >= 0) text = `${digits.slice(0, e10 + 1)}.${digits.slice(e10 + 1)}`;
  else text = `0.${'0'.repeat(-e10 - 1)}${digits}`;
  text = text.replace(/0+$/, '').replace(/\.$/, '');
  return sign + text;
}

/** NumText of the Spawns layer: the game's text of the float, six decimals. */
export function spawnsNum(x: number): string {
  return fixed6(gameFloat(x));
}

/** NumText of the Effects and Territories layers: the game's text of the float, at most six decimals. */
export function areaNum(x: number): string {
  return canon6(gameFloat(x));
}

export { getBool };
