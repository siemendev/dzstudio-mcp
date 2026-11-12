/**
 * The edits dzStudio's layers make, as the same operations: each function does what one action of the Spawns,
 * Effects or Territories layer does in the editor (DZS_SpawnsPlugin, DZS_EffectsPlugin, DZS_TerrPlugin), on the state
 * alone. An edit that needs the base (the mission's own spawn points, areas, zones and their values, which only the
 * game reads) is not offered.
 */

import { BuildError, type OpBuilder } from './edits.js';
import { PROJECT_ID } from './ids.js';
import { getStr, isArr, isObj, toJV, type JObj, type JV } from './jv.js';
import { areaNum, EFFECTS, KEPT, presetName, spawnsNum, SPAWNS, TERRITORIES, type LayerSrc } from './layers.js';
import type { Scene } from './scene.js';
import { parseSrc } from './srcjson.js';
import type { Element } from './textform.js';

/** DZS_SpawnsModel.Of: the project's top-level elements of a kind, in their order. */
export function layerElements(scene: Scene, kind: string): Element[] {
  return scene
    .children(PROJECT_ID)
    .map((id) => scene.get(id)!)
    .filter((e) => e.kind === kind);
}

/** DZS_LayerSrc.Of: the elements of the state a layer builds its blocks and changes from. */
export class SceneSrc implements LayerSrc {
  constructor(private readonly scene: Scene) {}

  all(kind: string): string[] {
    return layerElements(this.scene, kind).map((e) => e.id);
  }

  field(id: string, key: string): string {
    return this.scene.get(id)?.fields.get(key) ?? '';
  }

  add(): string {
    throw new Error('the state is only read');
  }

  takeExts(): void {}
}

function field(e: Element | undefined, key: string): string {
  return e?.fields.get(key) ?? '';
}

/** The game's string.ToFloat: the leading number, 0 when there is none. */
export function toFloat(text: string): number {
  const v = parseFloat(text);
  return Number.isFinite(v) ? Math.fround(v) : 0;
}

/** What the opening carried over unchanged (DZS_KeptBlocks.From): {blocks, changes, slug?}, undefined when nothing. */
export function keptOf(scene: Scene): JObj | undefined {
  const comp = scene.get(PROJECT_ID)?.comp.get('projects:plugins');
  if (!comp) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(comp.d);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const entry = list.find((e): e is string[] => Array.isArray(e) && e.length >= 3 && e[0] === KEPT);
  if (!entry) return undefined;
  const root = parseSrc(String(entry[2])).root;
  if (!root) return undefined;
  const kept = toJV(root);
  return isObj(kept) ? kept : undefined;
}

/** DZS_KeptBlocks.Entries: the kept blocks or changes of a kind. */
export function keptEntries(scene: Scene, list: 'blocks' | 'changes', kind: string): JV[] {
  const part = keptOf(scene)?.m.get(list);
  if (!isArr(part)) return [];
  return part.a.filter((e) => isObj(e) && getStr(e, list === 'changes' ? 'block' : 'kind') === kind);
}

function need(scene: Scene, id: string, kinds: readonly string[], what: string): Element {
  const el = scene.get(id);
  if (!el || !kinds.includes(el.kind)) throw new BuildError(`No ${what} ${id}`, 'missing');
  return el;
}

// ---------------------------------------------------------------- Spawns

export interface SpawnPointSpec {
  x: number;
  z: number;
  /** Heading in degrees. */
  angle?: number;
}

/** DZS_SpawnsPlugin.AddPoint: an own point of an event (each point a step of its own). */
export function addSpawnPoints(b: OpBuilder, event: string, points: readonly SpawnPointSpec[]): string[] {
  if (event === '') throw new BuildError('Name the event');
  return points.map((p) => {
    let a = Math.fround(p.angle ?? 0);
    if (a < 0) a = Math.fround(a + 360);
    const f = new Map([
      ['event', event],
      ['origin', 'own'],
      ['x', spawnsNum(p.x)],
      ['z', spawnsNum(p.z)],
      ['a', spawnsNum(a)],
    ]);
    return b.createElement(SPAWNS.point, PROJECT_ID, f);
  });
}

/** DZS_SpawnsPlugin.FixedVehicle: an own event "exactly this vehicle here" with its one point. */
export function addFixedVehicle(b: OpBuilder, cls: string, p: SpawnPointSpec): { event: string; name: string; point: string } {
  if (cls === '') throw new BuildError('Name the vehicle class');
  const stem = `VehicleDzs${cls}`;
  let name = stem;
  const own = new Set(layerElements(b.scene, SPAWNS.event).map((e) => field(e, 'name')));
  for (let n = 2; own.has(name); n++) name = `${stem}_${n}`;
  const event = b.createElement(
    SPAWNS.event,
    PROJECT_ID,
    new Map([
      ['name', name],
      ['class', cls],
      ['nominal', '1'],
    ]),
  );
  const [point] = addSpawnPoints(b, name, [p]);
  return { event, name, point: point! };
}

/** DZS_SpawnsPlugin.MovePoint: an own point, or a base point the project moved already. */
export function moveSpawnPoint(b: OpBuilder, id: string, p: { x?: number; z?: number; angle?: number }): void {
  const el = need(b.scene, id, [SPAWNS.point], 'spawn point');
  if (field(el, 'gone') === '1') throw new BuildError(`${id} is a removed base point`);
  b.setField(id, 'x', spawnsNum(p.x ?? toFloat(field(el, 'x'))));
  b.setField(id, 'z', spawnsNum(p.z ?? toFloat(field(el, 'z'))));
  b.setField(id, 'a', spawnsNum(p.angle ?? toFloat(field(el, 'a'))));
}

/** The own event of that name the layer edits: of two with the same name, the later one (it wins in the layer's map). */
function ownEvent(scene: Scene, name: string): Element | undefined {
  return layerElements(scene, SPAWNS.event).findLast((e) => field(e, 'name') === name);
}

/** The points of an event the layer shows (DZS_SpawnsPlugin.PointsOf), as far as the state tells them. */
function pointsOf(scene: Scene, event: string): number {
  let n = layerElements(scene, SPAWNS.point).filter((p) => field(p, 'origin') !== 'base' && field(p, 'event') === event).length;
  const evNames = new Map<string, string>();
  for (const ke of keptEntries(scene, 'blocks', 'event'))
    evNames.set(getStr(ke, 'id'), getStr(ke.t === 'obj' ? ke.m.get('data') : undefined, 'name'));
  for (const kb of keptEntries(scene, 'blocks', 'spawnPosition')) {
    const d = kb.t === 'obj' ? kb.m.get('data') : undefined;
    const x = isObj(d) ? d.m.get('x') : undefined;
    const z = isObj(d) ? d.m.get('z') : undefined;
    if (x?.t !== 'num' || z?.t !== 'num') continue;
    const par = kb.t === 'obj' ? kb.m.get('parent') : undefined;
    const ev = par?.t === 'obj' ? getStr(par, 'event') : par?.t === 'str' ? (evNames.get(par.s) ?? '') : '';
    if (ev === event) n++;
  }
  return n;
}

/**
 * DZS_SpawnsPlugin.RemoveSelected: an own point is deleted (with its own event when it was the event's last point), a
 * base point the project moved is marked removed.
 */
export function removeSpawnPoint(b: OpBuilder, id: string): { deletedEvent?: string } {
  const el = need(b.scene, id, [SPAWNS.point], 'spawn point');
  if (field(el, 'origin') === 'base') {
    b.setField(id, 'gone', '1');
    return {};
  }
  const event = field(el, 'event');
  const own = ownEvent(b.scene, event);
  const last = !!own && pointsOf(b.scene, event) <= 1;
  b.deleteTree(id);
  if (own && last) {
    b.deleteTree(own.id);
    return { deletedEvent: own.id };
  }
  return {};
}

/**
 * DZS_SpawnsPlugin.SetEventValue for "nominal": an own event keeps it on its element; a base event's value the project
 * changed already is changed again, or the change dropped when it goes back to the base's value (the change's "from").
 */
export function setSpawnNominal(b: OpBuilder, event: string, value: string): void {
  const own = ownEvent(b.scene, event);
  if (own) {
    b.setField(own.id, 'nominal', value);
    return;
  }
  let found: Element | undefined;
  for (const s of layerElements(b.scene, SPAWNS.set)) if (field(s, 'event') === event && field(s, 'field') === 'nominal') found = s;
  if (!found)
    throw new BuildError(
      `${event} is no own event and the project does not change its count yet; that needs the base's value, which only dzStudio reads`,
    );
  backToBase(b, found, value);
}

/** A changed count set again: the change dropped when the value is the base's (its "from"), else its "to" set. */
function backToBase(b: OpBuilder, found: Element, value: string): void {
  const base = field(found, 'from');
  if (base === '') throw new BuildError(`The change ${found.id} does not name the base's value, which only dzStudio reads`);
  if (value === base) b.deleteTree(found.id);
  else b.setField(found.id, 'to', value);
}

// ---------------------------------------------------------------- Effects

export const PRESET_RADIUS: Record<string, number> = { gas: 75, geyser: 2, spring: 8, volcanic: 8, hearts: 40, smoke: 2 };

/** The names of effect areas the state knows: own areas, areas the project changes, areas carried over. */
function areaNames(scene: Scene): Set<string> {
  const names = new Set<string>();
  for (const a of layerElements(scene, EFFECTS.area)) names.add(field(a, 'name'));
  for (const c of layerElements(scene, EFFECTS.change)) names.add(field(c, 'area'));
  for (const kb of keptEntries(scene, 'blocks', 'effectArea')) {
    const d = kb.t === 'obj' ? kb.m.get('data') : undefined;
    const data = isObj(d) ? d.m.get('Data') : undefined;
    const pos = isObj(data) ? data.m.get('Pos') : undefined;
    if (isArr(pos) && pos.a.length >= 2) names.add(getStr(d, 'AreaName'));
  }
  return names;
}

/** DZS_EffectsPlugin.Create: an own area of a preset, named Dzs<Preset><n>. */
export function addEffectArea(b: OpBuilder, preset: string, x: number, z: number, r: number): { id: string; name: string } {
  if (!(preset in PRESET_RADIUS)) throw new BuildError(`Unknown preset ${preset}`);
  const stem = `Dzs${presetName(preset)}`.replace(/ /g, '');
  const taken = areaNames(b.scene);
  let name = `${stem}1`;
  for (let n = 2; taken.has(name); n++) name = `${stem}${n}`;
  const id = b.createElement(
    EFFECTS.area,
    PROJECT_ID,
    new Map([
      ['name', name],
      ['preset', preset],
      ['x', areaNum(x)],
      ['z', areaNum(z)],
      ['r', areaNum(r)],
    ]),
  );
  return { id, name };
}

/** DZS_EffectsPlugin.Change for an own area: position and radius. */
export function changeEffectArea(b: OpBuilder, id: string, p: { x?: number; z?: number; radius?: number }): void {
  const el = b.scene.get(id);
  if (el?.kind === EFFECTS.change)
    throw new BuildError(`${id} changes an area of the base; moving it needs the base's values, which only dzStudio reads`);
  need(b.scene, id, [EFFECTS.area], 'effect area');
  b.setField(id, 'x', areaNum(p.x ?? toFloat(field(el, 'x'))));
  b.setField(id, 'z', areaNum(p.z ?? toFloat(field(el, 'z'))));
  b.setField(id, 'r', areaNum(p.radius ?? toFloat(field(el, 'r'))));
}

/** DZS_EffectsPlugin.RemoveSelected: an own area is deleted, a base area the project changes is marked removed. */
export function removeEffectArea(b: OpBuilder, id: string): void {
  const el = need(b.scene, id, [EFFECTS.area, EFFECTS.change], 'effect area');
  if (el.kind === EFFECTS.area) b.deleteTree(id);
  else b.setField(id, 'gone', '1');
}

// ---------------------------------------------------------------- Territories

/** DZS_TerrPlugin.Change for an own zone: position, radius and the dmin/dmax counts. */
export function changeZone(b: OpBuilder, id: string, p: { x?: number; z?: number; radius?: number; dmin?: string; dmax?: string }): void {
  const el = b.scene.get(id);
  if (el?.kind === TERRITORIES.change)
    throw new BuildError(`${id} changes a zone of the base; changing it needs the base's values, which only dzStudio reads`);
  need(b.scene, id, [TERRITORIES.zone], 'zone');
  b.setField(id, 'x', areaNum(p.x ?? toFloat(field(el, 'x'))));
  b.setField(id, 'z', areaNum(p.z ?? toFloat(field(el, 'z'))));
  b.setField(id, 'r', areaNum(p.radius ?? toFloat(field(el, 'r'))));
  b.setField(id, 'dmin', p.dmin ?? field(el, 'dmin'));
  b.setField(id, 'dmax', p.dmax ?? field(el, 'dmax'));
}

/** DZS_TerrPlugin.RemoveSelected: an own zone is deleted, a base zone the project changes is marked removed. */
export function removeZone(b: OpBuilder, id: string): void {
  const el = need(b.scene, id, [TERRITORIES.zone, TERRITORIES.change], 'zone');
  if (el.kind === TERRITORIES.zone) b.deleteTree(id);
  else b.setField(id, 'gone', '1');
}

/**
 * DZS_TerrPlugin.SetKindCount: a kind's count (its event's nominal) the project changes already is changed again, or
 * the change dropped when it goes back to the base's value (the change's "from").
 */
export function setKindCount(b: OpBuilder, event: string, value: string): void {
  let found: Element | undefined;
  for (const n of layerElements(b.scene, TERRITORIES.nominal)) if (field(n, 'event') === event) found = n;
  if (!found)
    throw new BuildError(`The project does not change the count of ${event} yet; that needs the base's value, which only dzStudio reads`);
  backToBase(b, found, value);
}
