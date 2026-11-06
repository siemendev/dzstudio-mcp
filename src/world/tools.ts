import { PAGE_SIZE, ToolError, type Agent, type ProjectObject, type ToolResult } from '../mcp/agent.js';
import {
  angles,
  ClassIndex,
  distanceToArea,
  footprint,
  missingName,
  objectGround,
  orientedBox,
  overlapDepth,
  rasterHitsBox,
  rowsFrom,
  WorldData,
  type Area,
  type BoxEntry,
  type WorldObject,
} from './data.js';
import { cmpRevision, TILE, type Raster } from './format.js';
import { DataUnavailable, NewerFormat, type Pointer, type PointerWorld, type WorldDataSource } from './source.js';

export const MAX_POINTS = 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10_000) / 10_000;

export interface Placement {
  class: string;
  position: [number, number, number];
  orientation?: [number, number, number];
  scale?: number;
}

interface Context {
  map: string;
  /** null: no map data; the note says why. */
  wd: WorldData | null;
  note?: string;
  classes: ClassIndex | null;
  classNote?: string;
  objects: ProjectObject[];
  handle?: string;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function areaName(name: string): string {
  const m = /^(\d+)_(\d+)$/.exec(name);
  if (!m) return name;
  const tx = Number(m[1]);
  const tz = Number(m[2]);
  return `tile ${name} (X ${tx * TILE}–${(tx + 1) * TILE}, Z ${tz * TILE}–${(tz + 1) * TILE})`;
}

function missingText(missing: string[]): string {
  const all = [...new Set(missing)];
  const corrupt = all.filter((m) => m.endsWith(' corrupt')).map((m) => areaName(m.slice(0, -' corrupt'.length)));
  const absent = all.filter((m) => !m.endsWith(' corrupt')).map(areaName);
  let out = '';
  if (absent.length) out += `; map data missing for ${absent.join(', ')}`;
  if (corrupt.length) out += `; map data corrupt for ${corrupt.join(', ')}`;
  return out;
}

function unknownText(classes: string[]): string {
  if (!classes.length) return '';
  const names = [...new Set(classes.map((c) => c || '(no class)'))];
  return `; ${plural(classes.length, 'object')} without a known box: ${names.join(', ')}`;
}

/**
 * The six tools for classes and map: they read static world data (local folder or base address) and the session's
 * project, and never change the session or locks. Missing data is always "unknown", never zero.
 */
export class WorldTools {
  private readonly pins = new Map<string, PointerWorld | null>();
  private readonly worlds = new Map<string, Promise<WorldData>>();
  private readonly classIndexes = new Map<string, Promise<ClassIndex>>();

  constructor(
    private readonly agent: Agent,
    readonly source: WorldDataSource,
  ) {}

  private classIndex(revision: string): Promise<ClassIndex> {
    let p = this.classIndexes.get(revision);
    if (!p) {
      p = ClassIndex.load(this.source, revision);
      p.catch(() => this.classIndexes.delete(revision));
      this.classIndexes.set(revision, p);
    }
    return p;
  }

  private worldData(w: PointerWorld, classes: ClassIndex): Promise<WorldData> {
    const key = `${w.world}/${w.revision}`;
    let p = this.worlds.get(key);
    if (!p) {
      p = WorldData.load(this.source, w.world, w.revision, classes);
      p.catch(() => this.worlds.delete(key));
      this.worlds.set(key, p);
    }
    return p;
  }

  private async pointer(): Promise<{ pointer?: Pointer; note?: string }> {
    try {
      return { pointer: await this.source.pointer() };
    } catch (e) {
      if (e instanceof NewerFormat) return { note: e.message };
      return { note: `world data not reachable (${(e as Error).message})` };
    }
  }

  private async classesFor(pointer: Pointer | undefined, atLeast?: string): Promise<{ classes: ClassIndex | null; note?: string }> {
    let revision = pointer?.classes;
    if (atLeast && (!revision || cmpRevision(atLeast, revision) > 0)) revision = atLeast;
    if (!revision) return { classes: null, note: 'class data unknown' };
    try {
      return { classes: await this.classIndex(revision) };
    } catch (e) {
      return { classes: null, note: `class data ${revision} not available (${(e as Error).message})` };
    }
  }

  /** The world of a map key: from the session's pin, else the pointer's current revision. */
  private async context(handle: string | undefined, mapOverride: string | undefined): Promise<Context> {
    const session = await this.agent.sessionWorld(handle);
    const map = mapOverride ?? session?.map ?? '';
    if (!map) {
      if (!session) throw new ToolError('Not in a session — join one or name a map');
      return { map: '', wd: null, note: 'No map data for an unknown map — project objects only', classes: null, objects: session.objects };
    }
    const objects = session && (!mapOverride || mapOverride === session.map) ? session.objects : [];
    const pinKey = session && map === session.map ? session.key : undefined;
    const { pointer, note: pointerNote } = await this.pointer();
    let w: PointerWorld | null | undefined = pinKey !== undefined ? this.pins.get(pinKey) : undefined;
    if (w === undefined && pointer) {
      const want = map.toLowerCase();
      w = pointer.worlds.find((x) => x.map?.toLowerCase() === want) ?? pointer.worlds.find((x) => x.world.toLowerCase() === want) ?? null;
      if (pinKey !== undefined) this.pins.set(pinKey, w);
    }
    const ctx: Context = { map, wd: null, classes: null, objects };
    if (session) ctx.handle = session.handle;
    if (!w) {
      ctx.note = `No map data for ${map} — project objects only${pointerNote ? ` (${pointerNote})` : ''}`;
      const c = await this.classesFor(pointer);
      ctx.classes = c.classes;
      if (c.note) ctx.classNote = c.note;
      return ctx;
    }
    try {
      const manifest = await this.source.json<{ classes: string }>(`worlds/${w.world}/${w.revision}/manifest.json`);
      const c = await this.classesFor(pointer, manifest.classes);
      ctx.classes = c.classes;
      if (c.note) ctx.classNote = c.note;
      if (!c.classes) {
        ctx.note = `No map data for ${map} — project objects only (${c.note})`;
        return ctx;
      }
      ctx.wd = await this.worldData(w, c.classes);
    } catch (e) {
      const why = e instanceof DataUnavailable ? e.message : (e as Error).message;
      ctx.note = `No map data for ${map} — project objects only (${why})`;
    }
    return ctx;
  }

  private projectObject(p: ProjectObject, classes: ClassIndex | null, id?: string): WorldObject {
    const rows = rowsFrom(p.orientation[0], p.orientation[1], p.orientation[2], p.scale);
    const named = classes?.find(p.class);
    const found = named && named.name.toLowerCase() === p.class.toLowerCase() ? named : undefined;
    return {
      id: id ?? p.id,
      source: 'project',
      class: p.class,
      shape: found?.shape ?? '',
      flags: found?.flags ?? 0,
      x: p.position[0],
      y: p.position[1],
      z: p.position[2],
      rows,
      ...angles(rows),
      box: classes?.boxFor(p.class, '') ?? null,
    };
  }

  private subjects(ctx: Context, ids: string[] | undefined, placement: Placement | undefined): { list: WorldObject[]; notFound: string[] } {
    const list: WorldObject[] = [];
    const notFound: string[] = [];
    for (const id of ids ?? []) {
      const p = ctx.objects.find((o) => o.id === id);
      if (p) list.push(this.projectObject(p, ctx.classes));
      else notFound.push(id);
    }
    if (placement) {
      const p: ProjectObject = {
        id: 'placement',
        class: placement.class,
        position: placement.position,
        orientation: placement.orientation ?? [0, 0, 0],
        scale: placement.scale ?? 1,
      };
      list.push(this.projectObject(p, ctx.classes, 'placement'));
    }
    if (!list.length && !notFound.length) throw new ToolError('Name project object ids or a placement');
    return { list, notFound };
  }

  private row(o: WorldObject & { distance?: number }): Record<string, unknown> {
    const row: Record<string, unknown> = { id: o.id, source: o.source, class: o.class };
    if (o.shape) row.model = o.shape;
    row.position = [r2(o.x), r2(o.y), r2(o.z)];
    row.orientation = [r2(o.yaw), r2(o.pitch), r2(o.roll)];
    row.scale = r4(o.scale);
    if (o.distance !== undefined) row.distance = r2(o.distance);
    row.size = o.box?.size ? o.box.size.map(r2) : 'box unknown';
    return row;
  }

  // ------------------------------------------------------------ tools

  async worldInfo(
    handle: string | undefined,
    map: string | undefined,
    near?: { x: number; z: number; radius?: number },
    place?: string,
  ): Promise<ToolResult> {
    const ctx = await this.context(handle, map);
    if (!ctx.wd) {
      const data: Record<string, unknown> = { map: ctx.map || 'unknown', data: false };
      if (ctx.classes) data.classes = ctx.classes.revision;
      return { text: ctx.note!, data };
    }
    const m = ctx.wd.manifest;
    const data: Record<string, unknown> = {
      map: ctx.map,
      world: m.world,
      data: true,
      revision: m.revision,
      game: m.game,
      exported: m.exported,
      classes: ctx.wd.classes.revision,
      size: m.size,
      tiles: { size: m.tile.size, cols: m.tile.cols, rows: m.tile.rows },
      seaLevel: m.sea,
      staticObjects: m.counts.objects,
    };
    let places = m.places.map((p) => ({ ...p, distance: near ? Math.hypot(p.x - near.x, p.z - near.z) : undefined }));
    if (place) {
      const q = place.toLowerCase();
      places = places.filter((p) => p.text.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    }
    if (near) {
      places = places.filter((p) => p.distance! <= (near.radius ?? 2000)).sort((a, b) => a.distance! - b.distance!);
    }
    if (near || place) {
      data.places = places.slice(0, 50).map((p) => {
        const row: Record<string, unknown> = { id: p.id, type: p.type, name: p.text, x: r2(p.x), z: r2(p.z) };
        if (p.distance !== undefined) row.distance = r2(p.distance);
        return row;
      });
    } else data.places = m.places.length;
    return {
      text: `${ctx.map} is ${m.world}, map data ${m.revision} (game ${m.game}, exported ${m.exported}), class data ${ctx.wd.classes.revision}`,
      data,
    };
  }

  async worldObjects(
    handle: string | undefined,
    map: string | undefined,
    q: {
      near?: { x: number; z: number; radius: number };
      rect?: Area['rect'];
      class?: string;
      flags?: number;
      source?: 'all' | 'map' | 'project';
      page?: number;
    },
  ): Promise<ToolResult> {
    if (!q.near && !q.rect) throw new ToolError('Name an area: near (X, Z, radius) or rect');
    const ctx = await this.context(handle, map);
    const area: Area = q.near ? { circle: q.near } : { rect: q.rect! };
    const want = q.source ?? 'all';
    const found: (WorldObject & { distance: number })[] = [];
    let missing: string[] = [];
    if (ctx.wd && want !== 'project') {
      const filter: { class?: string; flags?: number } = {};
      if (q.class) filter.class = q.class;
      if (q.flags) filter.flags = q.flags;
      const res = await ctx.wd.objectsIn(area, filter);
      found.push(...res.objects);
      missing = res.missing;
    }
    let projectCount = 0;
    if (want !== 'map') {
      for (const p of ctx.objects) {
        if (q.class && p.class.toLowerCase() !== q.class.toLowerCase()) continue;
        const o = this.projectObject(p, ctx.classes);
        if (q.flags && !(o.flags & q.flags)) continue;
        const d = distanceToArea(o, area);
        if (d === null) continue;
        found.push({ ...o, distance: d });
        projectCount++;
      }
    }
    found.sort((a, b) => a.distance - b.distance);
    const page = Math.max(0, Math.floor(q.page ?? 0));
    const slice = found.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const data: Record<string, unknown> = { total: found.length, page, objects: slice.map((o) => this.row(o)) };
    if ((page + 1) * PAGE_SIZE < found.length) data.nextPage = page + 1;
    if (missing.length) data.missingTiles = missing;
    const unknown = found.filter((o) => !o.box).map((o) => o.class);
    let text = `${plural(found.length, 'object')} (${found.length - projectCount} map, ${projectCount} project)`;
    if (data.nextPage !== undefined) text += `, page ${page + 1} of ${Math.ceil(found.length / PAGE_SIZE)}`;
    text += unknownText(unknown) + missingText(missing);
    if (ctx.note) text = `${ctx.note}. ${text}`;
    return { text, data };
  }

  async groundAt(handle: string | undefined, map: string | undefined, points: { x: number; z: number; y?: number }[]): Promise<ToolResult> {
    if (!points.length) throw new ToolError('Name at least one point');
    if (points.length > MAX_POINTS) throw new ToolError(`At most ${MAX_POINTS} points at once`);
    const ctx = await this.context(handle, map);
    const wd = ctx.wd;
    if (!wd) return { text: `${ctx.note}. Ground: unknown`, data: { points: points.map((p) => ({ x: p.x, z: p.z, ground: 'unknown' })) } };
    const missing: string[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const p of points) {
      let g;
      try {
        g = await wd.groundAt(p.x, p.z);
      } catch (err) {
        const { tx, tz } = wd.locate(p.x, p.z);
        missing.push(missingName(`${tx}_${tz}`, err));
        rows.push({ x: p.x, z: p.z, ground: 'unknown' });
        continue;
      }
      const row: Record<string, unknown> = { x: p.x, z: p.z, height: r2(g.height), material: g.material, water: g.water };
      if (g.seaLevel) row.seaLevel = g.seaLevel;
      if (g.roadway) row.roadway = { model: g.roadway.model, height: r2(g.roadway.height), aboveTerrain: r2(g.roadway.aboveTerrain) };
      const floors = await wd.rasterSurfaces(p.x, p.z);
      missing.push(...floors.missing);
      if (floors.surfaces.length)
        row.objectSurfaces = floors.surfaces.map((s) => ({ height: r2(s.height), model: s.model, object: s.object }));
      if (p.y !== undefined) {
        const all = [
          { height: g.height, kind: 'terrain' },
          ...(g.roadway ? [{ height: g.roadway.height, kind: 'roadway', model: g.roadway.model }] : []),
          ...floors.surfaces.map((s) => ({ height: s.height, kind: 'object', model: s.model })),
        ].filter((s) => s.height <= p.y!);
        const top = all.reduce<(typeof all)[number] | undefined>((a, c) => (!a || c.height > a.height ? c : a), undefined);
        row.below = top ? { ...top, height: r2(top.height), distance: r2(p.y - top.height) } : 'unknown';
      }
      rows.push(row);
    }
    const text = `${plural(points.length, 'point')} on ${wd.world}${missingText(missing)}`;
    return { text, data: { points: rows } };
  }

  async objectGround(handle: string | undefined, map: string | undefined, ids?: string[], placement?: Placement): Promise<ToolResult> {
    const ctx = await this.context(handle, map);
    const { list, notFound } = this.subjects(ctx, ids, placement);
    const rows: Record<string, unknown>[] = [];
    const missing: string[] = [];
    const lines: string[] = [];
    for (const o of list) {
      const row: Record<string, unknown> = { id: o.id, class: o.class };
      if (!o.box) {
        row.ground = 'box unknown';
        lines.push(`${o.id} (${o.class}): box unknown`);
      } else if (!ctx.wd) {
        row.ground = 'unknown';
        lines.push(`${o.id} (${o.class}): ground unknown`);
      } else {
        try {
          const g = await objectGround(ctx.wd, o.box, o, { rasters: true });
          if (g.missing) missing.push(...g.missing);
          row.verdict = g.verdict ?? `between ${r2(g.min!).toFixed(2)} and ${r2(g.max!).toFixed(2)} m above the ground`;
          row.min = r2(g.min!);
          row.max = r2(g.max!);
          row.corners = g.corners!.map((c) => ({
            position: c.corner.map(r2),
            surface: r2(c.surface),
            kind: c.kind,
            distance: r2(c.distance),
          }));
          lines.push(`${o.id} (${o.class}): ${row.verdict}`);
        } catch (err) {
          const { tx, tz } = ctx.wd.locate(o.x, o.z);
          missing.push(missingName(`${tx}_${tz}`, err));
          row.ground = 'unknown';
          lines.push(`${o.id} (${o.class}): ground unknown`);
        }
      }
      rows.push(row);
    }
    const data: Record<string, unknown> = { objects: rows };
    if (notFound.length) data.notFound = notFound;
    let text = lines.join('; ') + missingText(missing);
    if (notFound.length) text += `; not in the project: ${notFound.join(', ')}`;
    if (ctx.note) text = `${ctx.note}. ${text}`;
    return { text, data };
  }

  /** The collision raster of an object, or null when it has none or it cannot be loaded (then named in `missing`). */
  private async collisionRaster(ctx: Context, o: WorldObject, missing: string[]): Promise<Raster | null> {
    if (!o.box?.raster || !ctx.classes) return null;
    try {
      const r = await ctx.classes.raster(o.box.id);
      return r?.channels.g ? r : null;
    } catch (err) {
      missing.push(missingName(`raster ${o.box.id}`, err));
      return null;
    }
  }

  async checkOverlap(
    handle: string | undefined,
    map: string | undefined,
    ids?: string[],
    placement?: Placement,
    precise = false,
  ): Promise<ToolResult> {
    const ctx = await this.context(handle, map);
    const { list, notFound } = this.subjects(ctx, ids, placement);
    const project = ctx.objects.map((p) => this.projectObject(p, ctx.classes));
    const rows: Record<string, unknown>[] = [];
    const lines: string[] = [];
    const missing: string[] = [];
    for (const s of list) {
      const box = s.box ? orientedBox(s.box, s) : null;
      if (!s.box || !box) {
        rows.push({ id: s.id, class: s.class, overlaps: 'box unknown' });
        lines.push(`${s.id} (${s.class}): box unknown`);
        continue;
      }
      const reach = Math.max(
        ...[s.box.clip!, s.box.collision ?? s.box.clip!].flatMap((b) =>
          footprint(b, s).map(([px, pz]) => Math.hypot(px! - box.center[0], pz! - box.center[2])),
        ),
      );
      const area: Area = { circle: { x: box.center[0], z: box.center[2], radius: reach } };
      const candidates: WorldObject[] = [];
      if (ctx.wd) {
        const res = await ctx.wd.objectsIn(area);
        candidates.push(...res.objects);
        missing.push(...res.missing);
      }
      for (const o of project) if (o.id !== s.id && distanceToArea(o, area) !== null) candidates.push(o);
      const overlaps: Record<string, unknown>[] = [];
      const unknown: string[] = [];
      let cleared = 0;
      let boxesOnly = 0;
      const own = precise ? await this.collisionRaster(ctx, s, missing) : null;
      for (const c of candidates) {
        const cb = c.box ? orientedBox(c.box, c) : null;
        if (!cb) {
          unknown.push(c.class);
          continue;
        }
        const depth = overlapDepth(box, cb);
        if (depth === null) continue;
        const hit: Record<string, unknown> = { id: c.id, source: c.source, class: c.class, depth: r2(depth) };
        if (precise) {
          const other = await this.collisionRaster(ctx, c, missing);
          if (!own && !other) {
            hit.compared = 'boxes (no collision raster)';
            boxesOnly++;
          } else {
            const ok = (!own || rasterHitsBox(s, s.box, own, cb)) && (!other || rasterHitsBox(c, c.box!, other, box));
            if (!ok) {
              cleared++;
              continue;
            }
            hit.compared = own && other ? 'collision rasters' : `collision raster of ${own ? s.id : c.id}`;
          }
        }
        overlaps.push(hit);
      }
      overlaps.sort((a, b) => (b.depth as number) - (a.depth as number));
      const row: Record<string, unknown> = { id: s.id, class: s.class, overlaps };
      if (precise && cleared) row.clearedByRasters = cleared;
      if (unknown.length) row.withoutKnownBox = { count: unknown.length, classes: [...new Set(unknown)] };
      rows.push(row);
      let line = `${s.id} (${s.class}): ${overlaps.length ? `intersects ${plural(overlaps.length, 'object')}` : precise ? 'no intersection' : 'no intersection with known boxes'}`;
      if (cleared) line += `; ${plural(cleared, 'box intersection')} free by the collision rasters`;
      if (boxesOnly) line += `; ${boxesOnly} of them compared as boxes only (no collision raster)`;
      lines.push(line + unknownText(unknown));
    }
    const data: Record<string, unknown> = { objects: rows };
    if (notFound.length) data.notFound = notFound;
    if (missing.length) data.missingTiles = [...new Set(missing)];
    let text = lines.join('; ') + missingText(missing);
    if (notFound.length) text += `; not in the project: ${notFound.join(', ')}`;
    if (ctx.note) text = `${ctx.note}. ${text}`;
    return { text, data };
  }

  async classInfo(names: string[]): Promise<ToolResult> {
    if (!names.length) throw new ToolError('Name at least one class or model path');
    const { pointer, note } = await this.pointer();
    const { classes, note: classNote } = await this.classesFor(pointer);
    if (!classes)
      return { text: `Class data unknown (${classNote ?? note})`, data: { classes: names.map((n) => ({ query: n, unknown: true })) } };
    const rows = names.map((q) => {
      const c = classes.find(q);
      const s: (BoxEntry & { name?: string; flags?: number }) | null = c ?? classes.shape(q);
      if (!s) return { query: q, unknown: true };
      const row: Record<string, unknown> = { query: q };
      if (c) row.class = c.name;
      row.model = s.shape;
      row.modelId = s.id;
      if (c) row.flags = c.flags;
      row.scan = s.scan;
      row.size = s.size ?? 'unknown';
      row.clip = s.clip ?? 'unknown';
      row.collision = s.collision ?? 'none';
      row.radius = s.radius;
      row.raster = !!s.raster;
      return row;
    });
    const unknown = rows.filter((r) => r.unknown).map((r) => r.query);
    return {
      text: `${rows.length - unknown.length} of ${rows.length} found in class data ${classes.revision}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}`,
      data: { classes: rows },
    };
  }
}
