/**
 * The layers of a project as the agent reads them: one compact row per element of the Spawns, Effects and
 * Territories layers, and per entry the opening carried over unchanged (read-only), with a position on the map where
 * the entry has one.
 */

import { PROJECT_ID } from './ids.js';
import { compact, get, getStr, isArr, isObj, mStr, type JV } from './jv.js';
import { keptOf } from './layeredits.js';
import { EFFECTS, EXT_LIST, EXT_PROJECT, LAYER_KINDS, SPAWNS, TERRITORIES, territoryEvent } from './layers.js';
import type { Scene } from './scene.js';
import type { Element } from './textform.js';

export type LayerName = 'spawns' | 'effects' | 'territories';

export interface LayerRow {
  id: string;
  layer: LayerName | 'other';
  kind: string;
  /** World X and Z where the entry stands. */
  position?: [number, number];
  radius?: number;
  /** The event, area or zone name the entry belongs to. */
  name?: string;
  /** Carried over from the file unchanged; dzStudio shows it read-only and so does the MCP. */
  kept?: boolean;
  [more: string]: unknown;
}

function num(text: string | undefined): number | undefined {
  if (text === undefined || text === '') return undefined;
  const v = Number(text);
  return Number.isFinite(v) ? v : undefined;
}

function pos(x: string | undefined, z: string | undefined): [number, number] | undefined {
  const a = num(x);
  const b = num(z);
  return a === undefined || b === undefined ? undefined : [a, b];
}

function put(row: LayerRow, key: string, value: unknown): void {
  if (value !== undefined && value !== '') row[key] = value;
}

/** The extensions an element holds (fields "ext" and "ext:…"), by the entity they belong to. */
function extsOf(el: Element): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [k, v] of el.fields) {
    if (k !== 'ext' && !k.startsWith('ext:')) continue;
    try {
      out[k] = JSON.parse(v);
    } catch {
      out[k] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function elementRow(scene: Scene, el: Element): LayerRow | undefined {
  const f = (k: string): string | undefined => el.fields.get(k);
  let row: LayerRow;
  switch (el.kind) {
    case SPAWNS.event:
      row = { id: el.id, layer: 'spawns', kind: 'event', name: f('name') ?? '' };
      put(row, 'class', f('class'));
      put(row, 'nominal', num(f('nominal')) ?? f('nominal'));
      break;
    case SPAWNS.point: {
      row = { id: el.id, layer: 'spawns', kind: 'point', name: f('event') ?? '', origin: f('origin') === 'base' ? 'base' : 'own' };
      const p = pos(f('x'), f('z'));
      if (p) row.position = p;
      put(row, 'angle', num(f('a')));
      if (f('origin') === 'base') {
        put(row, 'basePosition', pos(f('bx'), f('bz')));
        if (f('gone') === '1') row.removed = true;
      }
      break;
    }
    case SPAWNS.set:
      row = { id: el.id, layer: 'spawns', kind: 'event_value', name: f('event') ?? '', field: f('field') ?? '' };
      put(row, 'from', num(f('from')) ?? f('from'));
      put(row, 'to', num(f('to')) ?? f('to'));
      break;
    case EFFECTS.area: {
      row = { id: el.id, layer: 'effects', kind: 'area', name: f('name') ?? '', preset: f('preset') ?? '' };
      const p = pos(f('x'), f('z'));
      if (p) row.position = p;
      put(row, 'radius', num(f('r')));
      put(row, 'aboveGround', num(f('above')));
      break;
    }
    case EFFECTS.change: {
      row = { id: el.id, layer: 'effects', kind: 'area_change', name: f('area') ?? '' };
      if (f('gone') === '1') row.removed = true;
      const p = pos(f('x'), f('z'));
      if (p) {
        row.position = p;
        put(row, 'basePosition', pos(f('bx'), f('bz')));
      }
      if (num(f('r')) !== undefined) {
        row.radius = num(f('r'))!;
        put(row, 'baseRadius', num(f('br')));
      }
      break;
    }
    case TERRITORIES.territory:
      row = { id: el.id, layer: 'territories', kind: 'territory', file: f('file') ?? '', color: f('color') ?? '' };
      row.zones = scene.children(PROJECT_ID).filter((c) => scene.get(c)?.fields.get('territory') === el.id).length;
      break;
    case TERRITORIES.zone: {
      row = { id: el.id, layer: 'territories', kind: 'zone', name: f('name') ?? '' };
      const t = f('territory');
      if (t) {
        row.territory = t;
        put(row, 'file', scene.get(t)?.fields.get('file'));
      } else {
        put(row, 'file', f('file'));
        put(row, 'color', f('color'));
      }
      const p = pos(f('x'), f('z'));
      if (p) row.position = p;
      put(row, 'radius', num(f('r')));
      for (const k of ['dmin', 'dmax', 'smin', 'smax']) put(row, k, num(f(k)) ?? f(k));
      break;
    }
    case TERRITORIES.change: {
      row = { id: el.id, layer: 'territories', kind: 'zone_change', name: f('name') ?? '', file: f('file') ?? '' };
      put(row, 'basePosition', pos(f('bx'), f('bz')));
      if (f('gone') === '1') row.removed = true;
      const p = pos(f('x') || f('bx'), f('z') || f('bz'));
      if (p) row.position = p;
      put(row, 'radius', num(f('r')));
      for (const k of ['br', 'dmin', 'bdmin', 'dmax', 'bdmax']) put(row, k === 'br' ? 'baseRadius' : k, num(f(k)) ?? f(k));
      break;
    }
    case TERRITORIES.nominal:
      row = { id: el.id, layer: 'territories', kind: 'count', name: f('event') ?? '' };
      put(row, 'from', num(f('from')) ?? f('from'));
      put(row, 'to', num(f('to')) ?? f('to'));
      break;
    default:
      return undefined;
  }
  const exts = extsOf(el);
  if (exts) row.extensions = exts;
  return row;
}

function layerOfKept(kind: string, change: JV | undefined): LayerName | 'other' {
  if (kind === 'spawnPosition' || kind === 'eventChild') return 'spawns';
  if (kind === 'event') return change && territoryEvent(getStr(get(change, 'key'), 'name')) ? 'territories' : 'spawns';
  if (kind === 'effectArea') return 'effects';
  if (kind === 'territory' || kind === 'territoryZone') return 'territories';
  return 'other';
}

function numAt(o: JV | undefined, key: string): number | undefined {
  const v = get(o, key);
  return v?.t === 'num' ? num(v.s) : undefined;
}

/** Where a carried-over block or change stands, for the kinds that have a place on the map. */
function keptPlace(row: LayerRow, entry: JV, isChange: boolean): void {
  if (isChange) {
    const key = get(entry, 'key');
    const kx = numAt(key, 'x');
    const kz = numAt(key, 'z');
    if (kx !== undefined && kz !== undefined) row.position = [kx, kz];
    return;
  }
  const d = get(entry, 'data');
  const data = get(d, 'Data');
  const p = isObj(data) ? get(data, 'Pos') : undefined;
  if (isArr(p) && p.a.length >= 2) {
    const x = num(mStr(p.a[0]));
    const z = num(mStr(p.a[p.a.length - 1]));
    if (x !== undefined && z !== undefined) row.position = [x, z];
    const r = numAt(data, 'Radius');
    if (r !== undefined) row.radius = r;
    return;
  }
  const x = numAt(d, 'x');
  const z = numAt(d, 'z');
  if (x !== undefined && z !== undefined) row.position = [x, z];
  const r = numAt(d, 'r');
  if (r !== undefined) row.radius = r;
}

function keptRows(scene: Scene): LayerRow[] {
  const kept = keptOf(scene);
  if (!kept) return [];
  const rows: LayerRow[] = [];
  const blocks = kept.m.get('blocks');
  if (isArr(blocks)) {
    blocks.a.forEach((b, i) => {
      const kind = getStr(b, 'kind');
      const row: LayerRow = { id: `kept:block:${i}`, layer: layerOfKept(kind, undefined), kind, kept: true, block: JSON.parse(compact(b)) };
      const d = get(b, 'data');
      const name = getStr(d, 'name') || getStr(d, 'AreaName');
      if (name) row.name = name;
      keptPlace(row, b, false);
      rows.push(row);
    });
  }
  const changes = kept.m.get('changes');
  if (isArr(changes)) {
    changes.a.forEach((c, i) => {
      const kind = getStr(c, 'block');
      const row: LayerRow = {
        id: `kept:change:${i}`,
        layer: layerOfKept(kind, c),
        kind: `${kind} change`,
        kept: true,
        change: JSON.parse(compact(c)),
      };
      const key = get(c, 'key');
      const name = getStr(key, 'name') || getStr(key, 'event');
      if (name) row.name = name;
      keptPlace(row, c, true);
      rows.push(row);
    });
  }
  return rows;
}

export interface LayerQuery {
  layer?: LayerName;
  ids?: string[];
  /** Event, area or zone name (exact, ignoring case). */
  name?: string;
  near?: { x: number; z: number; radius: number };
  rect?: { minX: number; minZ: number; maxX: number; maxZ: number };
  /** Include the entries carried over unchanged (default true). */
  kept?: boolean;
}

/** Every row of the layers that matches the query: the state's elements first, in their order, then the kept entries. */
export function layerRows(scene: Scene, q: LayerQuery = {}): LayerRow[] {
  const rows: LayerRow[] = [];
  for (const id of scene.children(PROJECT_ID)) {
    const el = scene.get(id)!;
    if (!LAYER_KINDS.has(el.kind)) continue;
    const row = elementRow(scene, el);
    if (row) rows.push(row);
  }
  if (q.kept !== false) rows.push(...keptRows(scene));
  const ids = q.ids?.length ? new Set(q.ids) : undefined;
  const name = q.name?.toLowerCase();
  return rows.filter((r) => {
    if (q.layer && r.layer !== q.layer) return false;
    if (ids && !ids.has(r.id)) return false;
    if (name !== undefined && (r.name ?? '').toLowerCase() !== name) return false;
    if (q.near || q.rect) {
      if (!r.position) return false;
      const [x, z] = r.position;
      const reach = r.radius ?? 0;
      if (q.near && Math.hypot(x - q.near.x, z - q.near.z) > q.near.radius + reach) return false;
      if (q.rect && (x + reach < q.rect.minX || x - reach > q.rect.maxX || z + reach < q.rect.minZ || z - reach > q.rect.maxZ))
        return false;
    }
    return true;
  });
}

export interface LayerSummary {
  spawns: { events: number; points: number; eventValues: number };
  effects: { areas: number; areaChanges: number };
  territories: { territories: number; zones: number; zoneChanges: number; counts: number };
  kept: { blocks: number; changes: number };
}

function listLength(v: JV | undefined): number {
  return isArr(v) ? v.a.length : 0;
}

export function layerSummary(scene: Scene): LayerSummary {
  const n = new Map<string, number>();
  for (const id of scene.children(PROJECT_ID)) {
    const k = scene.get(id)!.kind;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  const kept = keptOf(scene);
  const c = (k: string): number => n.get(k) ?? 0;
  return {
    spawns: { events: c(SPAWNS.event), points: c(SPAWNS.point), eventValues: c(SPAWNS.set) },
    effects: { areas: c(EFFECTS.area), areaChanges: c(EFFECTS.change) },
    territories: {
      territories: c(TERRITORIES.territory),
      zones: c(TERRITORIES.zone),
      zoneChanges: c(TERRITORIES.change),
      counts: c(TERRITORIES.nominal),
    },
    kept: { blocks: listLength(kept?.m.get('blocks')), changes: listLength(kept?.m.get('changes')) },
  };
}

export interface ProjectExtension {
  url: string;
  required?: boolean;
  /** The extension's data as the session holds it, when it holds any. */
  data?: unknown;
}

/** The project's extensions as the session holds them (its list and each one's data), e.g. the dzbot rules. */
export function projectExtensions(scene: Scene): ProjectExtension[] {
  const project = scene.get(PROJECT_ID);
  if (!project) return [];
  const out: ProjectExtension[] = [];
  const seen = new Set<string>();
  const listText = project.fields.get(EXT_LIST);
  if (listText) {
    try {
      const list = JSON.parse(listText) as Record<string, unknown>;
      for (const [url, meta] of Object.entries(list)) {
        const e: ProjectExtension = { url };
        if (meta && typeof meta === 'object' && (meta as Record<string, unknown>).required === true) e.required = true;
        out.push(e);
        seen.add(url);
      }
    } catch {
      // an unreadable list is shown by its entries' data alone
    }
  }
  for (const k of project.fields.keys()) {
    if (!k.startsWith(EXT_PROJECT)) continue;
    const url = k.slice(EXT_PROJECT.length);
    if (!seen.has(url)) {
      out.push({ url });
      seen.add(url);
    }
  }
  for (const e of out) {
    const text = project.fields.get(EXT_PROJECT + e.url);
    if (text === undefined) continue;
    try {
      e.data = JSON.parse(text);
    } catch {
      e.data = text;
    }
  }
  return out;
}
