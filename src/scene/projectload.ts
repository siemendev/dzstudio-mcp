/**
 * Opening a hosted project from its files, the way dzStudio does when it loads a project from a server and no
 * session is running yet: the project file (the store's `manifest`), then every group file in the Object Spawner
 * format, all as one `core:load` operation. The result is the same state a dzStudio would upload as snapshot 0.
 *
 * Where the editor's result depends on the running game and not on the files alone — a model path (the game places
 * the model to learn its origin) or loot that is turned on (it reads the loot files and the vanilla baseline) — the
 * project is refused instead of opened differently.
 */

import { readFloat32, writeFloat32 } from './float32.js';
import type { IdAllocator } from './ids.js';
import { PROJECT_ID } from './ids.js';
import { writeString } from './json.js';
import { parseSrc, SrcUnsupported, type SrcDoc, type SrcNode } from './srcjson.js';
import type { Change, Comp, Element, Operation } from './textform.js';

export const PROJECT_FILE = 'project.dzstudio.json';
const LEGACY_PROJECT_FILE = 'projekt.dzstudio.json';
const PROJECT_FILE_VERSION = 1;
const PALETTE = ['#60A5FA', '#FB923C', '#2DD4BF', '#F472B6', '#A3E635', '#FDE047', '#94A3B8', '#E879F9'];
const KNOWN_ENTRY_KEYS = ['name', 'pos', 'ypr', 'scale', 'enableCEPersistency', 'customString'];

/** The project cannot be opened outside the game without ending up in a different state than dzStudio would. */
export class LoadRefused extends Error {}

export interface LoadInput {
  /** Every file of the project as the store names it, with its content. */
  files: ReadonlyMap<string, string>;
  /** Whether the game knows a class (ignoring case); undefined while no class data are available. */
  classKnown?: (name: string) => boolean;
  ids: IdAllocator;
  author: string;
  authorName: string;
}

export interface LoadResult {
  op: Operation;
  groups: number;
  objects: number;
  /** What the editor would report on opening, in English. */
  notes: string[];
}

// ---------------------------------------------------------------- small rules of the editor

/** The editor lower-cases only ASCII letters. */
function lowerAscii(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function comparePaths(a: string, b: string): number {
  const la = lowerAscii(a);
  const lb = lowerAscii(b);
  if (la !== lb) return compareBytes(la, lb);
  return compareBytes(a, b);
}

function isNeverGroup(rel: string): boolean {
  const low = lowerAscii(rel);
  const leaf = low.slice(low.lastIndexOf('/') + 1);
  if (low.startsWith('vanilla/')) return true;
  return [
    PROJECT_FILE,
    LEGACY_PROJECT_FILE,
    'cfggameplay.json',
    'mapgroupproto.xml',
    'mapgrouppos.xml',
    'cfglimitsdefinition.xml',
  ].includes(leaf);
}

function isProjectFile(name: string): boolean {
  return name === 'manifest' || name === PROJECT_FILE || name === LEGACY_PROJECT_FILE;
}

function invalidRel(rel: string): boolean {
  if (rel === '' || rel.includes(':') || rel[0] === '/' || rel[0] === '\\' || rel.includes('..')) return true;
  return isNeverGroup(rel);
}

/** Whether opening needs this file of the store: the project file and every file that can become a group. */
export function neededForLoad(name: string): boolean {
  return isProjectFile(name) || (!invalidRel(name) && handlesFile(name));
}

function handlesFile(name: string): boolean {
  const low = lowerAscii(name);
  return low.length > 5 && low.endsWith('.json');
}

function leaf(rel: string): string {
  let l = rel.slice(rel.lastIndexOf('/') + 1);
  const dot = l.lastIndexOf('.');
  if (dot > 0) l = l.slice(0, dot);
  return l;
}

function validColor(c: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(c);
}

function nextColor(used: string[]): string {
  const upper = used.map((u) => u.toUpperCase());
  return PALETTE.find((c) => !upper.includes(c)) ?? PALETTE[used.length % 8]!;
}

function isProjectId(t: string): boolean {
  return /^[0-9a-f]{16}$/.test(t);
}

/** The game's `ToInt`: the leading digits; refused where it would overflow. */
function toInt(text: string): number {
  const m = /^-?[0-9]+/.exec(text);
  if (!m) return 0;
  const n = Number(m[0]);
  if (Math.abs(n) > 2147483647) throw new LoadRefused(`the number ${text} in the project file is too large for the editor`);
  return n;
}

/** float32 of a number text; undefined where the editor finds no finite float32. */
function f32(text: string): number | undefined {
  try {
    return readFloat32(text);
  } catch {
    return undefined;
  }
}

function vecText(a: number, b: number, c: number): string {
  return `${writeFloat32(a)} ${writeFloat32(b)} ${writeFloat32(c)}`;
}

function jsonList(items: string[]): string {
  return `[${items.join(',')}]`;
}

/** The editor's `Near`: |a − b| ≤ 0.001, computed in float32. */
function near(a: number, b: number): boolean {
  return Math.fround(Math.abs(Math.fround(a - b))) <= Math.fround(0.001);
}

function bool(n: SrcNode | undefined): boolean | undefined {
  return n?.type === 'bool' ? n.bool : undefined;
}

/** Entries of a plugin data block: `[name, key as source text, value as source text]`, the last of duplicates. */
function pluginEntries(doc: SrcDoc, p: SrcNode | undefined): string {
  const list: string[] = [];
  if (p?.type === 'obj') {
    p.keys.forEach((k, i) => {
      if (p.countKey(k) > 1 && p.get(k) !== p.items[i]) return;
      const v = p.items[i]!;
      list.push(jsonList([writeString(k), writeString(doc.slice(v.keyStart, v.keyEnd)), writeString(doc.raw(v))]));
    });
  }
  return jsonList(list);
}

// ---------------------------------------------------------------- the project file

interface PFObject {
  index: number;
  name: string;
  x: number;
  y: number;
  z: number;
  hidden: boolean;
  locked: boolean;
}

interface PFGroup {
  file: string;
  name: string;
  color: string;
  hidden: boolean;
  locked: boolean;
  objectCount: number;
  objects: PFObject[];
  plugins: string;
  rawEntry: string;
}

interface PFData {
  hasProject: boolean;
  groups: PFGroup[];
  lootEnabled: boolean;
  lootHidden: boolean;
  lootLocked: boolean;
  writtenTypes: string[];
  writtenOrig: string[];
  projectId: string;
  plugins: string;
}

function emptyPF(): PFData {
  return {
    hasProject: false,
    groups: [],
    lootEnabled: false,
    lootHidden: false,
    lootLocked: false,
    writtenTypes: [],
    writtenOrig: [],
    projectId: '',
    plugins: '[]',
  };
}

function readObjectEntry(o: SrcNode): PFObject | undefined {
  if (o.type !== 'obj') return undefined;
  const idx = o.get('index');
  const nm = o.get('name');
  const pos = o.get('pos');
  if (idx?.type !== 'num' || idx.str.includes('.') || idx.str.includes('-') || nm?.type !== 'str' || pos?.type !== 'arr') return undefined;
  if (pos.items.length !== 3 || pos.items.some((i) => i.type !== 'num')) return undefined;
  const [x, y, z] = pos.items.map((i) => f32(i.str));
  if (x === undefined || y === undefined || z === undefined) return undefined;
  return {
    index: toInt(idx.str),
    name: nm.str,
    x,
    y,
    z,
    hidden: bool(o.get('hidden')) ?? false,
    locked: bool(o.get('locked')) ?? false,
  };
}

function readProjectPart(doc: SrcDoc, proj: SrcNode, notes: string[]): PFData {
  const d = emptyPF();
  d.hasProject = true;
  const groups = proj.get('groups');
  if (groups?.type === 'arr') {
    for (const g of groups.items) {
      if (g.type !== 'obj') continue;
      const f = g.get('file');
      const n = g.get('name');
      const c = g.get('color');
      const oc = g.get('objectCount');
      const objs = g.get('objects');
      const pg: PFGroup = {
        file: f?.type === 'str' ? f.str : '',
        name: n?.type === 'str' ? n.str : '',
        color: c?.type === 'str' && validColor(c.str) ? c.str.toUpperCase() : '',
        hidden: bool(g.get('hidden')) ?? false,
        locked: bool(g.get('locked')) ?? false,
        objectCount: -1,
        objects: [],
        plugins: pluginEntries(doc, g.get('plugins')),
        rawEntry: doc.raw(g),
      };
      if (oc?.type === 'num' && !/[.\-e]/.test(oc.str) && oc.str.length < 10) pg.objectCount = toInt(oc.str);
      if (objs?.type === 'arr') {
        for (const o of objs.items) {
          const po = readObjectEntry(o);
          if (po) pg.objects.push(po);
        }
      }
      d.groups.push(pg);
    }
  } else notes.push('project.groups is missing or not a list');
  const loot = proj.get('loot');
  if (loot?.type === 'obj') {
    d.lootEnabled = bool(loot.get('enabled')) ?? false;
    d.lootHidden = bool(loot.get('hidden')) ?? false;
    d.lootLocked = bool(loot.get('locked')) ?? false;
    const pid = loot.get('projectId');
    if (pid?.type === 'str' && isProjectId(pid.str)) d.projectId = pid.str;
    const wt = loot.get('writtenTypes');
    if (wt?.type === 'arr') {
      const lows: string[] = [];
      for (const t of wt.items) {
        const tn = t.type === 'obj' ? t.get('name') : undefined;
        const to = t.type === 'obj' ? t.get('original') : undefined;
        const okName = tn?.type === 'str' && tn.str !== '';
        const okOrig = !to || to.type === 'null' || to.type === 'str';
        if (!okName || !okOrig) continue;
        const lt = lowerAscii(tn.str);
        if (lows.includes(lt)) continue;
        lows.push(lt);
        d.writtenTypes.push(tn.str);
        d.writtenOrig.push(to?.type === 'str' ? to.str : '');
      }
    }
  }
  d.plugins = pluginEntries(doc, proj.get('plugins'));
  return d;
}

/**
 * The project file as the editor reads it after loading from a server: the store keeps only format, version and
 * project, the editor puts the project part into a project file of its own and reads that.
 */
function readProjectFile(text: string | undefined, notes: string[]): PFData {
  if (text === undefined) {
    notes.push('Project file was missing — every group file becomes a group');
    return emptyPF();
  }
  const doc = parseSrc(text);
  const root = doc.root;
  const proj = root?.type === 'obj' ? root.get('project') : undefined;
  if (proj?.type === 'obj') {
    const reparsed = parseSrc(doc.raw(proj));
    return readProjectPart(reparsed, reparsed.root!, notes);
  }
  if (root?.type === 'obj') {
    const fmt = root.get('format');
    const ver = root.get('version');
    if (fmt?.type === 'str' && fmt.str === 'dzstudio-project' && ver?.type === 'num' && !/[.e-]/.test(ver.str) && toInt(ver.str) >= 1) {
      if (ver.str.length > 6 || toInt(ver.str) > PROJECT_FILE_VERSION)
        throw new LoadRefused('The project file comes from a newer version of dzStudio');
    }
  }
  notes.push('Project file was missing or unreadable — every group file becomes a group');
  return emptyPF();
}

// ---------------------------------------------------------------- group files (Object Spawner)

interface ReadObject {
  fields: Map<string, string>;
  comp: Map<string, Comp>;
  fileName: string;
  fileX: number;
  fileY: number;
  fileZ: number;
}

interface ReadResult {
  readable: boolean;
  error: string;
  objects: ReadObject[];
  groupComp: Map<string, Comp>;
}

class Unreadable extends Error {}

function intOutOfRange(num: string): boolean {
  if (/[.eE]/.test(num)) return false;
  const d = num.startsWith('-') ? num.slice(1) : num;
  if (d.length > 10) return true;
  if (d.length < 10) return false;
  return d > '2147483647';
}

function badInts(n: SrcNode | undefined): boolean {
  if (!n) return false;
  if (n.type === 'num') return intOutOfRange(n.str);
  if (n.type === 'arr') return n.items.some((it) => it.type === 'num' && intOutOfRange(it.str));
  return false;
}

class SpawnerReader {
  readonly warns: string[] = [];

  constructor(private readonly classKnown: (name: string) => boolean) {}

  private warn(de: string, en: string): void {
    this.warns.push(`${de}\n${en}`);
  }

  private number(n: SrcNode, fallback: number, field: string): number {
    const f = f32(n.str);
    if (f === undefined) {
      const fb = writeFloat32(fallback);
      this.warn(
        `${field}: ${n.str} ist keine endliche float32-Zahl — ersetzt durch ${fb}`,
        `${field}: ${n.str} is not a finite float32 number — replaced by ${fb}`,
      );
      return fallback;
    }
    return f;
  }

  private vec3(n: SrcNode | undefined, field: string): [number, number, number] | undefined {
    if (!n) return [0, 0, 0];
    if (n.type === 'null') {
      this.warn(`${field}: null durch den Standardwert ersetzt`, `${field}: null replaced by the default`);
      return [0, 0, 0];
    }
    if (n.type !== 'arr' || n.items.length !== 3 || n.items.some((i) => i.type !== 'num')) return undefined;
    return [this.number(n.items[0]!, 0, field), this.number(n.items[1]!, 0, field), this.number(n.items[2]!, 0, field)];
  }

  entry(doc: SrcDoc, e: SrcNode, index: number): ReadObject {
    const no = index + 1;
    for (const kk of KNOWN_ENTRY_KEYS) if (badInts(e.get(kk))) throw new Unreadable(`integer outside 32 bits in entry ${no}`);
    let name = '';
    const nn = e.get('name');
    if (nn) {
      if (nn.type === 'str') name = nn.str;
      else if (nn.type === 'null') this.warn('name: null durch den Standardwert ersetzt', 'name: null replaced by the default');
      else throw new Unreadable(`"name" is not text in entry ${no}`);
    }
    const pos = this.vec3(e.get('pos'), 'pos');
    const ypr = pos ? this.vec3(e.get('ypr'), 'ypr') : undefined;
    if (!pos || !ypr) throw new Unreadable(`"pos" or "ypr" is not exactly 3 numbers in entry ${no}`);
    let scale = 1;
    const sn = e.get('scale');
    if (sn) {
      if (sn.type === 'num') {
        scale = this.number(sn, 1, 'scale');
        if (scale === 0) scale = 1;
      } else if (sn.type === 'null') this.warn('scale: null durch den Standardwert ersetzt', 'scale: null replaced by the default');
      else throw new Unreadable(`"scale" is not a number in entry ${no}`);
    }
    let persist = '0';
    const pn = e.get('enableCEPersistency');
    if (pn) {
      if (pn.type === 'bool') {
        if (pn.bool) persist = '1';
        const readAs = pn.bool ? 'true' : 'false';
        this.warn(
          `enableCEPersistency wird als ${persist} geschrieben (gelesen: ${readAs})`,
          `enableCEPersistency is written as ${persist} (read: ${readAs})`,
        );
      } else if (pn.type === 'num') {
        const pv = f32(pn.str) ?? 0;
        if (pv !== 0) persist = '1';
        if (pn.str !== '0' && pn.str !== '1')
          this.warn(
            `enableCEPersistency wird als ${persist} geschrieben (gelesen: ${pn.str})`,
            `enableCEPersistency is written as ${persist} (read: ${pn.str})`,
          );
      } else if (pn.type === 'null')
        this.warn('enableCEPersistency: null durch den Standardwert ersetzt', 'enableCEPersistency: null replaced by the default');
      else throw new Unreadable(`"enableCEPersistency" has the wrong type in entry ${no}`);
    }
    let custom = '';
    const cn = e.get('customString');
    if (cn) {
      if (cn.type === 'str') custom = cn.str;
      else if (cn.type === 'null')
        this.warn('customString: null durch den Standardwert ersetzt', 'customString: null replaced by the default');
      else throw new Unreadable(`"customString" is not text in entry ${no}`);
    }
    const unknown: string[] = [];
    e.keys.forEach((key, k) => {
      if (KNOWN_ENTRY_KEYS.includes(key)) return;
      if (e.countKey(key) > 1 && e.get(key) !== e.items[k]) return;
      const uv = e.items[k]!;
      unknown.push(jsonList([writeString(doc.slice(uv.keyStart, uv.keyEnd)), writeString(doc.raw(uv))]));
    });
    return this.fromValues(name, pos, ypr, scale, persist, custom, unknown);
  }

  private fromValues(
    name: string,
    p: [number, number, number],
    y: [number, number, number],
    scale: number,
    persist: string,
    custom: string,
    unknown: string[],
  ): ReadObject {
    let placeholder = false;
    if (name === '') placeholder = true;
    else if (name.includes('\\') || name.includes('/'))
      throw new LoadRefused(
        `It places a model by its path (${name}); where such a model stands is known only to the game. Ask a person to open it in dzStudio.`,
      );
    else placeholder = !this.classKnown(name);
    const posText = vecText(...p);
    const yprText = vecText(...y);
    const scaleText = writeFloat32(scale);
    const fields = new Map([
      ['name', name],
      ['pos', posText],
      ['ypr', yprText],
      ['scale', scaleText],
      ['persist', persist],
      ['customString', custom],
    ]);
    const f = jsonList([name, posText, yprText, scaleText, persist, custom].map(writeString));
    const d =
      `{"f":${f},"p":${writeString(posText)},"y":${writeString(yprText)},"ph":${placeholder},` +
      `"u":${jsonList(unknown)},"w":${jsonList(this.warns.map(writeString))}}`;
    return { fields, comp: new Map([['spawner:read', { v: 1, d }]]), fileName: name, fileX: p[0], fileY: p[1], fileZ: p[2] };
  }
}

function readSpawner(text: string, classKnown: (name: string) => boolean): ReadResult {
  const res: ReadResult = { readable: false, error: '', objects: [], groupComp: new Map() };
  const doc = parseSrc(text);
  const root = doc.root;
  if (!root) {
    res.error = `not valid JSON: ${doc.error}`;
    return res;
  }
  if (root.type !== 'obj') {
    res.error = 'the root is not an object';
    return res;
  }
  const rootUnknown: string[] = [];
  root.keys.forEach((rk, r) => {
    if (root.countKey(rk) > 1 && root.get(rk) !== root.items[r]) return;
    if (rk === 'Objects') return;
    const rv = root.items[r]!;
    rootUnknown.push(jsonList([writeString(doc.slice(rv.keyStart, rv.keyEnd)), writeString(doc.raw(rv))]));
  });
  if (rootUnknown.length) res.groupComp.set('spawner:root', { v: 1, d: jsonList(rootUnknown) });
  const objs = root.get('Objects');
  if (!objs || objs.type === 'null') {
    res.readable = true;
    return res;
  }
  if (objs.type !== 'arr') {
    res.error = '"Objects" is not a list';
    return res;
  }
  // A refusal counts only if the file turns out readable: the editor drops the objects of an unreadable file.
  let refused: LoadRefused | undefined;
  try {
    objs.items.forEach((e, i) => {
      if (e.type !== 'obj') throw new Unreadable(`entry ${i + 1} is not an object`);
      try {
        res.objects.push(new SpawnerReader(classKnown).entry(doc, e, i));
      } catch (r) {
        if (!(r instanceof LoadRefused)) throw r;
        refused ??= r;
      }
    });
  } catch (e) {
    if (!(e instanceof Unreadable)) throw e;
    res.objects = [];
    res.error = e.message;
    return res;
  }
  if (refused) throw refused;
  res.readable = true;
  return res;
}

/** Hidden and locked objects of the project file, assigned to the objects read from the group file. */
function match(g: PFGroup, rr: ReadResult): { got: (PFObject | undefined)[]; lost: number } {
  const n = rr.objects.length;
  const got: (PFObject | undefined)[] = new Array<PFObject | undefined>(n).fill(undefined);
  const same = (o: ReadObject, e: PFObject): boolean =>
    o.fileName === e.name && near(o.fileX, e.x) && near(o.fileY, e.y) && near(o.fileZ, e.z);
  const left: PFObject[] = [];
  for (const e of g.objects.filter((o) => o.hidden || o.locked)) {
    if (g.objectCount === n && e.index >= 0 && e.index < n && !got[e.index] && same(rr.objects[e.index]!, e)) got[e.index] = e;
    else left.push(e);
  }
  let lost = 0;
  for (const l of left) {
    let found = -1;
    let count = 0;
    for (let k = 0; k < n; k++) {
      if (got[k]) continue;
      if (same(rr.objects[k]!, l)) {
        found = k;
        count++;
      }
    }
    if (count === 1) got[found] = l;
    else lost++;
  }
  return { got, lost };
}

// ---------------------------------------------------------------- the load

function writtenJson(names: string[], origs: string[]): string {
  return jsonList(names.map((n, i) => `{"name":${writeString(n)},"original":${origs[i] === '' ? 'null' : writeString(origs[i]!)}}`));
}

function element(id: string, kind: string, parent: string, after: string, fields: Map<string, string>, comp: Map<string, Comp>): Element {
  return { id, kind, parent, after, hidden: false, locked: false, fields, comp };
}

/**
 * Builds the `core:load` of a hosted project from its files. Throws LoadRefused where the editor's result would
 * depend on the game, or where this reader could not tell what the editor holds.
 */
export function loadProject(input: LoadInput): LoadResult {
  const notes: string[] = [];
  let projectText: string | undefined;
  const groupFiles: string[] = [];
  const keys = new Set<string>();
  for (const [name, text] of input.files) {
    if (isProjectFile(name)) {
      if (projectText !== undefined) throw new LoadRefused('The project has two project files');
      projectText = text;
      continue;
    }
    if (invalidRel(name)) continue;
    if (name.includes('\\')) throw new LoadRefused(`The file name ${name} cannot be a path in dzStudio`);
    const key = lowerAscii(name);
    if (keys.has(key)) throw new LoadRefused(`Two files differ only in case (${name})`);
    keys.add(key);
    if (handlesFile(name)) groupFiles.push(name);
  }

  let pf: PFData;
  try {
    pf = readProjectFile(projectText, notes);
  } catch (e) {
    if (e instanceof SrcUnsupported) throw new LoadRefused(`The project file holds ${e.message}`);
    throw e;
  }
  if (pf.lootEnabled)
    throw new LoadRefused(
      'Loot is turned on in this project; only dzStudio can open it from its files. Ask a person to open it in dzStudio.',
    );

  const order: { entry: PFGroup | undefined; file: string }[] = [];
  const taken = new Set<string>();
  if (pf.hasProject) {
    for (const g of pf.groups) {
      const rel = g.file.replace(/\\/g, '/');
      if (invalidRel(rel)) {
        notes.push(`Group entry with invalid file "${g.file}" is dropped`);
        continue;
      }
      const key = lowerAscii(rel);
      if (order.some((o) => o.entry && lowerAscii(o.entry.file.replace(/\\/g, '/')) === key)) {
        notes.push(`Two entries name "${g.file}" — the second is dropped`);
        continue;
      }
      let at = -1;
      groupFiles.forEach((f, i) => {
        if (lowerAscii(f) === key) at = i;
      });
      if (at < 0) {
        notes.push(`Group ${g.name || g.file}: file ${g.file} not found — removed from the project`);
        continue;
      }
      taken.add(groupFiles[at]!);
      order.push({ entry: g, file: groupFiles[at]! });
    }
  }
  const rest = groupFiles.filter((f) => !taken.has(f)).sort(comparePaths);
  for (const f of rest) order.push({ entry: undefined, file: f });

  const changes: Change[] = [];
  const projectFields = new Map([
    ['lootEnabled', String(pf.lootEnabled)],
    ['lootHidden', String(pf.lootHidden)],
    ['lootLocked', String(pf.lootLocked)],
    ['writtenTypes', writtenJson(pf.writtenTypes, pf.writtenOrig)],
    ['lootProjectId', pf.projectId],
  ]);
  changes.push({
    k: 'create',
    el: element(PROJECT_ID, 'core:project', '', '', projectFields, new Map([['projects:plugins', { v: 1, d: pf.plugins }]])),
  });

  const classKnown = (name: string): boolean => {
    if (!input.classKnown)
      throw new LoadRefused('Opening a project from its files needs the class data (to tell known classes); they are not available');
    return input.classKnown(name);
  };
  const colors: string[] = [];
  let lastGroup = '';
  let objects = 0;
  for (const { entry, file } of order) {
    let rr: ReadResult;
    try {
      rr = readSpawner(input.files.get(file)!, classKnown);
    } catch (e) {
      if (e instanceof SrcUnsupported) throw new LoadRefused(`${file} holds ${e.message}`);
      throw e;
    }
    let gname = leaf(file);
    let color = '';
    if (entry) {
      if (entry.name !== '') gname = entry.name;
      color = entry.color;
    }
    if (color === '') color = nextColor(colors);
    colors.push(color);
    const gf = new Map([
      ['name', gname],
      ['color', color],
      ['file', file],
      ['format', 'spawner'],
    ]);
    const gcomp = new Map<string, Comp>([['projects:plugins', { v: 1, d: entry ? entry.plugins : '[]' }]]);
    if (!rr.readable) {
      gf.set('unreadable', '1');
      if (entry) gcomp.set('projects:entry', { v: 1, d: entry.rawEntry });
      notes.push(`Group ${gname}: file not readable: ${rr.error}`);
    }
    for (const [k, c] of rr.groupComp) gcomp.set(k, c);
    const gid = input.ids.next();
    const g = element(gid, 'core:group', PROJECT_ID, lastGroup, gf, gcomp);
    g.hidden = entry?.hidden ?? false;
    g.locked = entry?.locked ?? false;
    changes.push({ k: 'create', el: g });
    lastGroup = gid;
    if (!rr.readable) continue;
    const { got, lost } = entry ? match(entry, rr) : { got: [], lost: 0 };
    if (lost) notes.push(`Group ${gname}: ${lost} hidden or locked object(s) no longer matched the file and were lifted`);
    let lastObject = '';
    rr.objects.forEach((ro, i) => {
      const id = input.ids.next();
      const o = element(id, 'core:object', gid, lastObject, ro.fields, ro.comp);
      o.hidden = got[i]?.hidden ?? false;
      o.locked = got[i]?.locked ?? false;
      changes.push({ k: 'create', el: o });
      lastObject = id;
      objects++;
    });
  }
  const op: Operation = {
    id: input.ids.next(),
    type: 'core:load',
    tv: 1,
    author: input.author,
    authorName: input.authorName,
    origin: 'system',
    changes,
  };
  return { op, groups: order.length, objects, notes };
}
