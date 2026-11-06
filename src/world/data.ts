import { gunzipSync } from 'node:zlib';
import { decodeRaster, decodeTile, modelId, NO_HIT, POINTS, TILE, type Raster, type Tile } from './format.js';
import { DataCorrupt, type WorldDataSource } from './source.js';

const DEG = 180 / Math.PI;

export interface RasterInfo {
  step: number;
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  bytes: number;
  sha256: string;
}

export interface ShapeEntry {
  shape: string;
  scan: 'scanned' | 'dynamic' | 'no_box' | 'failed' | string;
  clip: number[] | null;
  collision: number[] | null;
  size: number[] | null;
  radius: number;
  raster: RasterInfo | null;
}

/** A model of the class index with its id. */
export interface BoxEntry extends ShapeEntry {
  id: string;
}

export interface ClassIndexFile {
  format: number;
  revision: string;
  game: string;
  shapes: Record<string, ShapeEntry>;
  classes: Record<string, { shape: string; flags: number }>;
}

export interface Manifest {
  format: number;
  world: string;
  map?: string;
  revision: string;
  game: string;
  exported: string;
  classes: string;
  size: number;
  grid: { step: number; cols: number; rows: number };
  tile: { size: number; points: number; cols: number; rows: number };
  sea: { min: number; max: number };
  materials: { name: string; water: 'none' | 'sea' | 'pond' }[];
  roadwayShapes: string[];
  objects: [string, string, number][];
  excluded: { flags: number[]; count: number };
  counts: { objects: number; roadway: number };
  places: { id: string; type: string; text: string; x: number; z: number }[];
  tiles: { x: number; z: number; bytes: number; sha256: string; objects: number; reach: number }[];
}

/** A static map object or a project object, in world coordinates. */
export interface WorldObject {
  id: string;
  source: 'map' | 'project';
  class: string;
  shape: string;
  flags: number;
  x: number;
  y: number;
  z: number;
  /** side, up, forward rows ×10⁶, scale included. */
  rows: number[];
  yaw: number;
  pitch: number;
  roll: number;
  scale: number;
  /** null: box unknown. */
  box: BoxEntry | null;
}

export class ClassIndex {
  private readonly byLower = new Map<string, string>();
  private readonly byLoose = new Map<string, string>();
  private readonly entries = new Map<string, BoxEntry>();
  private readonly rasters = new Map<string, Promise<Raster | null>>();

  constructor(
    private readonly source: WorldDataSource,
    readonly index: ClassIndexFile,
  ) {
    for (const name of Object.keys(index.classes)) {
      this.byLower.set(name.toLowerCase(), name);
      const loose = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!this.byLoose.has(loose)) this.byLoose.set(loose, name);
    }
    for (const [id, s] of Object.entries(index.shapes)) this.entries.set(id, { id, ...s });
  }

  get revision(): string {
    return this.index.revision;
  }

  static async load(source: WorldDataSource, revision: string): Promise<ClassIndex> {
    return new ClassIndex(source, await source.json<ClassIndexFile>(`classes/${revision}/index.json`));
  }

  /** A class by name: exact, then ignoring case, then ignoring case and everything but letters and digits. */
  find(query: string): ({ name: string; flags: number } & BoxEntry) | null {
    const q = String(query);
    const name = this.index.classes[q]
      ? q
      : (this.byLower.get(q.toLowerCase()) ?? this.byLoose.get(q.toLowerCase().replace(/[^a-z0-9]/g, '')));
    if (!name) return null;
    const c = this.index.classes[name]!;
    const e = this.entries.get(c.shape);
    if (!e) return null;
    return { name, flags: c.flags, ...e };
  }

  /** A model by its path, or by its model id. */
  shape(modelPathOrId: string): BoxEntry | null {
    return this.entries.get(modelPathOrId) ?? this.entries.get(modelId(modelPathOrId)) ?? null;
  }

  /** Box of an object: via the model path first, then via the class name ignoring case. null = box unknown. */
  boxFor(cls: string, modelPath: string): BoxEntry | null {
    const s = modelPath ? this.entries.get(modelId(modelPath)) : undefined;
    if (s && s.clip) return s;
    const name = cls ? this.byLower.get(cls.toLowerCase()) : undefined;
    const cs = name ? this.entries.get(this.index.classes[name]!.shape) : undefined;
    return cs && cs.clip ? cs : null;
  }

  raster(id: string): Promise<Raster | null> {
    let p = this.rasters.get(id);
    if (!p) {
      const s = this.entries.get(id);
      p = !s?.raster
        ? Promise.resolve(null)
        : this.source
            .verified(`classes/${this.revision}/shapes/${id}.bin.gz`, s.raster.bytes, s.raster.sha256)
            .then((gz) => decodeRaster(gunzipSync(gz)));
      p.catch(() => this.rasters.delete(id));
      this.rasters.set(id, p);
    }
    return p;
  }
}

type LoadedTile = Tile & { list?: WorldObject[] };

export interface Ground {
  height: number;
  material: string;
  water: string;
  terrain: number;
  seaLevel?: { min: number; max: number };
  roadway: { model: string; height: number; aboveTerrain: number } | null;
}

export interface Area {
  circle?: { x: number; z: number; radius: number };
  rect?: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export class WorldData {
  readonly cols: number;
  readonly rows: number;
  private readonly cache = new Map<number, Promise<LoadedTile>>();

  constructor(
    private readonly source: WorldDataSource,
    readonly manifest: Manifest,
    readonly classes: ClassIndex,
  ) {
    this.cols = manifest.tile.cols;
    this.rows = manifest.tile.rows;
  }

  get world(): string {
    return this.manifest.world;
  }

  get revision(): string {
    return this.manifest.revision;
  }

  static async load(source: WorldDataSource, world: string, revision: string, classes: ClassIndex): Promise<WorldData> {
    const manifest = await source.json<Manifest>(`worlds/${world}/${revision}/manifest.json`);
    return new WorldData(source, manifest, classes);
  }

  entry(tx: number, tz: number) {
    return this.manifest.tiles[tz * this.cols + tx]!;
  }

  tile(tx: number, tz: number): Promise<LoadedTile> {
    const k = tz * this.cols + tx;
    let p = this.cache.get(k);
    if (p) {
      this.cache.delete(k);
      this.cache.set(k, p);
      return p;
    }
    if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
    const e = this.entry(tx, tz);
    p = this.source
      .verified(`worlds/${this.world}/${this.revision}/tiles/${tx}_${tz}.bin.gz`, e.bytes, e.sha256)
      .then((gz) => decodeTile(gunzipSync(gz)) as LoadedTile);
    p.catch(() => this.cache.delete(k));
    this.cache.set(k, p);
    return p;
  }

  locate(x: number, z: number): { tx: number; tz: number; c: number; r: number } {
    const tx = Math.min(Math.max(Math.floor(x / TILE), 0), this.cols - 1);
    const tz = Math.min(Math.max(Math.floor(z / TILE), 0), this.rows - 1);
    return { tx, tz, c: x - tx * TILE, r: z - tz * TILE };
  }

  /** Terrain height (m), bilinear from the four surrounding grid points. */
  async heightAt(x: number, z: number): Promise<number> {
    const { tx, tz, c, r } = this.locate(x, z);
    const t = await this.tile(tx, tz);
    const c0 = Math.min(Math.max(Math.floor(c), 0), TILE - 1);
    const r0 = Math.min(Math.max(Math.floor(r), 0), TILE - 1);
    const fc = Math.min(Math.max(c - c0, 0), 1);
    const fr = Math.min(Math.max(r - r0, 0), 1);
    const h = (cc: number, rr: number) => t.heights[rr * POINTS + cc]!;
    const v = h(c0, r0) * (1 - fc) * (1 - fr) + h(c0 + 1, r0) * fc * (1 - fr) + h(c0, r0 + 1) * (1 - fc) * fr + h(c0 + 1, r0 + 1) * fc * fr;
    return v / 100;
  }

  /** Material, water and walkable surface of the nearest grid point. */
  async surfaceAt(x: number, z: number): Promise<Omit<Ground, 'height'>> {
    const { tx, tz, c, r } = this.locate(x, z);
    const t = await this.tile(tx, tz);
    const cc = Math.min(Math.max(Math.round(c), 0), TILE);
    const rr = Math.min(Math.max(Math.round(r), 0), TILE);
    const k = rr * POINTS + cc;
    const mat = this.manifest.materials[t.matl[k]!]!;
    const out: Omit<Ground, 'height'> = { material: mat.name, water: mat.water, terrain: t.heights[k]! / 100, roadway: null };
    if (mat.water === 'sea') out.seaLevel = this.manifest.sea;
    const i = binarySearch(t.road.k, k);
    if (i >= 0) {
      out.roadway = {
        model: this.manifest.roadwayShapes[t.road.shape[i]!]!,
        height: (t.heights[k]! + t.road.dh[i]!) / 100,
        aboveTerrain: t.road.dh[i]! / 100,
      };
    }
    return out;
  }

  async groundAt(x: number, z: number): Promise<Ground> {
    return { height: await this.heightAt(x, z), ...(await this.surfaceAt(x, z)) };
  }

  /** Tiles whose objects can reach into the area: those touching it, plus neighbours whose `reach` extends into it. */
  private tilesFor(area: Area) {
    return this.manifest.tiles.filter((e) => {
      if (area.circle) {
        const { x, z, radius } = area.circle;
        const dx = Math.max(e.x * TILE - x, 0, x - (e.x + 1) * TILE);
        const dz = Math.max(e.z * TILE - z, 0, z - (e.z + 1) * TILE);
        return Math.hypot(dx, dz) <= radius + e.reach;
      }
      const r = area.rect!;
      return (
        (e.x + 1) * TILE + e.reach >= r.minX &&
        e.x * TILE - e.reach <= r.maxX &&
        (e.z + 1) * TILE + e.reach >= r.minZ &&
        e.z * TILE - e.reach <= r.maxZ
      );
    });
  }

  /**
   * Static objects whose clipping box (horizontally) touches the area; without a box, whose origin lies in it.
   * Tiles that cannot be loaded are named in `missing`, never treated as empty.
   */
  async objectsIn(
    area: Area,
    filter: { class?: string; flags?: number } = {},
  ): Promise<{ objects: (WorldObject & { distance: number })[]; missing: string[] }> {
    const out: (WorldObject & { distance: number })[] = [];
    const missing: string[] = [];
    const want = filter.class?.toLowerCase();
    for (const e of this.tilesFor(area)) {
      if (!e.objects) continue;
      let t: LoadedTile;
      try {
        t = await this.tile(e.x, e.z);
      } catch (err) {
        missing.push(missingName(`${e.x}_${e.z}`, err));
        continue;
      }
      for (const o of this.objectsOf(t)) {
        if (want !== undefined && o.class.toLowerCase() !== want) continue;
        if (filter.flags && !(o.flags & filter.flags)) continue;
        const d = distanceToArea(o, area);
        if (d !== null) out.push({ ...o, distance: d });
      }
    }
    out.sort((a, b) => a.distance - b.distance);
    return { objects: out, missing };
  }

  objectsOf(t: LoadedTile): WorldObject[] {
    if (t.list) return t.list;
    const o = t.objs;
    const list: WorldObject[] = [];
    for (let i = 0; i < o.n; i++) {
      const [cls, shape, flags] = this.manifest.objects[o.tab[i]!]!;
      const rows = Array.from(o.m.subarray(i * 9, i * 9 + 9));
      const x = (t.tx * TILE * 100 + o.x[i]!) / 100;
      const z = (t.tz * TILE * 100 + o.z[i]!) / 100;
      const y = o.y[i]! / 100;
      list.push({
        id: `${this.world}/${this.revision}/${t.tx}_${t.tz}/${i}`,
        source: 'map',
        class: cls,
        shape,
        flags,
        x,
        y,
        z,
        rows,
        ...angles(rows),
        box: this.classes.boxFor(cls, shape),
      });
    }
    t.list = list;
    return list;
  }

  /** A static object by its id `<world>/<revision>/<tx>_<tz>/<n>`. */
  async objectById(id: string): Promise<WorldObject | undefined> {
    const m = /^([^/]+)\/([^/]+)\/(\d+)_(\d+)\/(\d+)$/.exec(id);
    if (!m || m[1] !== this.world || m[2] !== this.revision) return undefined;
    const tx = Number(m[3]);
    const tz = Number(m[4]);
    if (tx >= this.cols || tz >= this.rows) return undefined;
    return this.objectsOf(await this.tile(tx, tz))[Number(m[5])];
  }

  /**
   * Walkable surfaces of static objects at a point, from the `r` rasters (walkable surface seen from below) of the
   * objects whose clipping box covers it. The model-space cell is found at the object's own height, so for strongly
   * tilted objects it is an approximation.
   */
  async rasterSurfaces(
    x: number,
    z: number,
  ): Promise<{ surfaces: { height: number; model: string; object: string }[]; missing: string[] }> {
    const { objects, missing } = await this.objectsIn({ circle: { x, z, radius: 0 } });
    const surfaces: { height: number; model: string; object: string }[] = [];
    for (const o of objects) {
      if (!o.box?.raster) continue;
      let raster: Raster | null;
      try {
        raster = await this.classes.raster(o.box.id);
      } catch (err) {
        missing.push(missingName(`raster ${o.box.id}`, err));
        continue;
      }
      const r = raster?.channels.r;
      if (!raster || !r) continue;
      const local = toLocal(o, x, o.y, z);
      if (!local) continue;
      const i = Math.round((local[0] * 1000 - raster.x0Mm) / raster.stepMm);
      const j = Math.round((local[2] * 1000 - raster.z0Mm) / raster.stepMm);
      if (i < 0 || j < 0 || i >= raster.nx || j >= raster.nz) continue;
      const v = r[j * raster.nx + i]!;
      if (v === NO_HIT) continue;
      surfaces.push({ height: toWorld(o, local[0], v / 100, local[2])[1], model: o.shape, object: o.id });
    }
    surfaces.sort((a, b) => b.height - a.height);
    return { surfaces, missing };
  }
}

/** A tile (`tx_tz`) or raster that could not be used; marked when its data were corrupt rather than unreachable. */
export function missingName(name: string, err: unknown): string {
  return err instanceof DataCorrupt ? `${name} corrupt` : name;
}

function binarySearch(arr: Int32Array, v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] === v) return mid;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

const footprints = new WeakMap<WorldObject, number[][]>();

function footprintOf(o: WorldObject, clip: number[]): number[][] {
  let p = footprints.get(o);
  if (!p) {
    p = footprint(clip, o);
    footprints.set(o, p);
  }
  return p;
}

/** Distance of an object to an area (0 inside), or null if it does not touch it. */
export function distanceToArea(o: WorldObject, area: Area): number | null {
  if (area.circle) {
    const { x, z, radius } = area.circle;
    const d = o.box?.clip ? distanceToPolygon(x, z, footprintOf(o, o.box.clip)) : Math.hypot(o.x - x, o.z - z);
    return d <= radius ? d : null;
  }
  const r = area.rect!;
  const cx = (r.minX + r.maxX) / 2;
  const cz = (r.minZ + r.maxZ) / 2;
  if (o.box?.clip) {
    const poly = footprintOf(o, o.box.clip);
    if (!polygonTouchesRect(poly, r)) return null;
    return distanceToPolygon(cx, cz, poly);
  }
  if (o.x < r.minX || o.x > r.maxX || o.z < r.minZ || o.z > r.maxZ) return null;
  return Math.hypot(o.x - cx, o.z - cz);
}

/** Separating axes in 2D between a convex polygon and an axis-aligned rectangle; touching counts. */
function polygonTouchesRect(poly: number[][], r: { minX: number; minZ: number; maxX: number; maxZ: number }): boolean {
  const rect = [
    [r.minX, r.minZ],
    [r.maxX, r.minZ],
    [r.maxX, r.maxZ],
    [r.minX, r.maxZ],
  ];
  const axes: number[][] = [
    [1, 0],
    [0, 1],
  ];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    axes.push([-(b[1]! - a[1]!), b[0]! - a[0]!]);
  }
  for (const [ax, az] of axes) {
    if (!ax && !az) continue;
    const proj = (pts: number[][]) => pts.map((p) => p[0]! * ax! + p[1]! * az!);
    const pa = proj(poly);
    const pb = proj(rect);
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}

/**
 * yaw/pitch/roll/scale as the export reports them. The engine's pitch is asin of the forward row's Y *with* the scale
 * in it; its scale is the RMS length of the three rows (some walls and rocks are slightly non-uniform).
 */
export function angles(rows: number[]): { yaw: number; pitch: number; roll: number; scale: number } {
  const [ax, ay, az, ux, uy, uz, dx, dy, dz] = rows.map((v) => v / 1e6) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  return {
    yaw: Math.atan2(dx, dz) * DEG,
    pitch: Math.asin(Math.max(-1, Math.min(1, dy))) * DEG,
    roll: Math.atan2(-ay, uy) * DEG,
    scale: Math.sqrt((ax * ax + ay * ay + az * az + ux * ux + uy * uy + uz * uz + dx * dx + dy * dy + dz * dz) / 3),
  };
}

/** Rows (×10⁶, scale included) from yaw/pitch/roll/scale; the inverse of `angles` for |scale · sin(pitch)| ≤ 1. */
export function rowsFrom(yaw: number, pitch: number, roll: number, scale = 1): number[] {
  const y = yaw / DEG;
  const r = roll / DEG;
  const sp = Math.sin(pitch / DEG) / scale;
  const p = Math.asin(Math.max(-1, Math.min(1, sp)));
  const cy = Math.cos(y);
  const sy = Math.sin(y);
  const cp = Math.cos(p);
  const spp = Math.sin(p);
  const cr = Math.cos(r);
  const sr = Math.sin(r);
  const aside = [cy * cr + sy * spp * sr, -cp * sr, -sy * cr + cy * spp * sr];
  const up = [cy * sr - sy * spp * cr, cp * cr, -sy * sr - cy * spp * cr];
  const dir = [sy * cp, spp, cy * cp];
  return [...aside, ...up, ...dir].map((v) => Math.round(v * scale * 1e6));
}

type Placed = Pick<WorldObject, 'x' | 'y' | 'z' | 'rows'>;

export function toWorld(o: Placed, lx: number, ly: number, lz: number): [number, number, number] {
  const m = o.rows;
  return [
    o.x + (m[0]! * lx + m[3]! * ly + m[6]! * lz) / 1e6,
    o.y + (m[1]! * lx + m[4]! * ly + m[7]! * lz) / 1e6,
    o.z + (m[2]! * lx + m[5]! * ly + m[8]! * lz) / 1e6,
  ];
}

/** Model-space coordinates of a world point, or null for a degenerate transformation. */
export function toLocal(o: Placed, x: number, y: number, z: number): [number, number, number] | null {
  const m = o.rows.map((v) => v / 1e6);
  const [a, b, c] = [m[0]!, m[3]!, m[6]!];
  const [d, e, f] = [m[1]!, m[4]!, m[7]!];
  const [g, h, i] = [m[2]!, m[5]!, m[8]!];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) return null;
  const px = x - o.x;
  const py = y - o.y;
  const pz = z - o.z;
  return [
    ((e * i - f * h) * px - (b * i - c * h) * py + (b * f - c * e) * pz) / det,
    (-(d * i - f * g) * px + (a * i - c * g) * py - (a * f - c * d) * pz) / det,
    ((d * h - e * g) * px - (a * h - b * g) * py + (a * e - b * d) * pz) / det,
  ];
}

export function corners(box: number[], o: Placed): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const lx of [box[0]!, box[3]!])
    for (const ly of [box[1]!, box[4]!]) for (const lz of [box[2]!, box[5]!]) out.push(toWorld(o, lx, ly, lz));
  return out;
}

/** Horizontal outline of a box: the convex hull of its eight corners on X/Z. */
export function footprint(box: number[], o: Placed): number[][] {
  const pts = corners(box, o)
    .map(([px, , pz]) => [px, pz])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!);
  const cross = (o1: number[], a: number[], b: number[]) => (a[0]! - o1[0]!) * (b[1]! - o1[1]!) - (a[1]! - o1[1]!) * (b[0]! - o1[0]!);
  const lower: number[][] = [];
  const upper: number[][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  for (const p of pts.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

export function distanceToPolygon(x: number, z: number, poly: number[][]): number {
  if (poly.length === 1) return Math.hypot(poly[0]![0]! - x, poly[0]![1]! - z);
  let inside = poly.length >= 3;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ex = b[0]! - a[0]!;
    const ez = b[1]! - a[1]!;
    if (ex * (z - a[1]!) - ez * (x - a[0]!) < 0) inside = false;
    const len = ex * ex + ez * ez;
    const t = len ? Math.max(0, Math.min(1, ((x - a[0]!) * ex + (z - a[1]!) * ez) / len)) : 0;
    best = Math.min(best, Math.hypot(a[0]! + t * ex - x, a[1]! + t * ez - z));
  }
  return inside ? 0 : best;
}

export interface OrientedBox {
  center: [number, number, number];
  axes: number[][];
  half: number[];
}

/** Oriented box (collision box, otherwise clipping box) of an object, with its scale. */
export function orientedBox(entry: ShapeEntry, o: Placed): OrientedBox | null {
  const b = entry.collision || entry.clip;
  if (!b) return null;
  const m = o.rows.map((v) => v / 1e6);
  const axes: number[][] = [];
  const half: number[] = [];
  for (let k = 0; k < 3; k++) {
    const v = [m[k * 3]!, m[k * 3 + 1]!, m[k * 3 + 2]!];
    const len = Math.hypot(...v);
    axes.push(v.map((q) => q / len));
    half.push(((b[k + 3]! - b[k]!) / 2) * len);
  }
  return { center: toWorld(o, (b[0]! + b[3]!) / 2, (b[1]! + b[4]!) / 2, (b[2]! + b[5]!) / 2), axes, half };
}

/** Separating-axis test: penetration depth along the axis where it is smallest, or null if they do not intersect. */
export function overlapDepth(A: OrientedBox, B: OrientedBox): number | null {
  const dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
  const crossV = (p: number[], q: number[]) => [
    p[1]! * q[2]! - p[2]! * q[1]!,
    p[2]! * q[0]! - p[0]! * q[2]!,
    p[0]! * q[1]! - p[1]! * q[0]!,
  ];
  const d = [B.center[0] - A.center[0], B.center[1] - A.center[1], B.center[2] - A.center[2]];
  const candidates = [...A.axes, ...B.axes];
  for (const a of A.axes) for (const b of B.axes) candidates.push(crossV(a, b));
  let depth = Infinity;
  for (const L0 of candidates) {
    const len = Math.hypot(...L0);
    if (len < 1e-6) continue;
    const L = L0.map((v) => v / len);
    const rA = A.half.reduce((s, h, i) => s + h * Math.abs(dot(A.axes[i]!, L)), 0);
    const rB = B.half.reduce((s, h, i) => s + h * Math.abs(dot(B.axes[i]!, L)), 0);
    const o = rA + rB - Math.abs(dot(d, L));
    if (o <= 0) return null;
    depth = Math.min(depth, o);
  }
  return depth;
}

/** Whether the segment from p to q passes through the box (slab test in the box's frame). */
export function segmentInBox(p: number[], q: number[], box: OrientedBox): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let k = 0; k < 3; k++) {
    const ax = box.axes[k]!;
    const a = (p[0]! - box.center[0]) * ax[0]! + (p[1]! - box.center[1]) * ax[1]! + (p[2]! - box.center[2]) * ax[2]!;
    const d = (q[0]! - p[0]!) * ax[0]! + (q[1]! - p[1]!) * ax[1]! + (q[2]! - p[2]!) * ax[2]!;
    const h = box.half[k]!;
    if (Math.abs(d) < 1e-12) {
      if (a < -h || a > h) return false;
      continue;
    }
    let lo = (-h - a) / d;
    let hi = (h - a) / d;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * Whether a cell of an object's collision raster (`g`), taken as a vertical column in model space from the bottom of
 * its box up to the hit height, lies inside another box.
 */
export function rasterHitsBox(o: Placed, entry: ShapeEntry, raster: Raster, other: OrientedBox): boolean {
  const g = raster.channels.g;
  const b = entry.collision || entry.clip;
  if (!g || !b) return false;
  const bottom = b[1]!;
  for (let j = 0; j < raster.nz; j++) {
    const lz = (raster.z0Mm + j * raster.stepMm) / 1000;
    for (let i = 0; i < raster.nx; i++) {
      const v = g[j * raster.nx + i]!;
      if (v === NO_HIT) continue;
      const lx = (raster.x0Mm + i * raster.stepMm) / 1000;
      const top = v / 100;
      if (segmentInBox(toWorld(o, lx, Math.min(bottom, top), lz), toWorld(o, lx, top, lz), other)) return true;
    }
  }
  return false;
}

export interface CornerGround {
  corner: [number, number, number];
  surface: number;
  distance: number;
  kind: 'terrain' | 'roadway' | 'object';
}

export interface ObjectGround {
  verdict: string | null;
  min?: number;
  max?: number;
  corners?: CornerGround[];
  missing?: string[];
}

/**
 * The four lower corners of the box (collision box, otherwise clipping box), each with the highest surface below it
 * (terrain, walkable surface and, with `rasters`, the walkable rasters of static objects) and the distance to it.
 */
export async function objectGround(wd: WorldData, entry: ShapeEntry, o: Placed, opts: { rasters?: boolean } = {}): Promise<ObjectGround> {
  const b = entry.collision || entry.clip;
  if (!b) return { verdict: 'box unknown' };
  const pts = (
    [
      [b[0]!, b[2]!],
      [b[3]!, b[2]!],
      [b[0]!, b[5]!],
      [b[3]!, b[5]!],
    ] as const
  ).map(([lx, lz]) => toWorld(o, lx, b[1]!, lz));
  const missing: string[] = [];
  const corners: CornerGround[] = [];
  for (const p of pts) {
    const [x, y, z] = p;
    const g = await wd.groundAt(x, z);
    const surfaces: { h: number; kind: CornerGround['kind'] }[] = [{ h: g.height, kind: 'terrain' }];
    if (g.roadway) surfaces.push({ h: g.roadway.height, kind: 'roadway' });
    if (opts.rasters) {
      const r = await wd.rasterSurfaces(x, z);
      missing.push(...r.missing);
      for (const s of r.surfaces) surfaces.push({ h: s.height, kind: 'object' });
    }
    const below = surfaces.filter((s) => s.h <= y);
    const s = below.length ? below.reduce((a, c) => (c.h > a.h ? c : a)) : surfaces.reduce((a, c) => (c.h < a.h ? c : a));
    corners.push({ corner: p, surface: s.h, distance: y - s.h, kind: s.kind });
  }
  const dist = corners.map((c) => c.distance);
  const min = Math.min(...dist);
  const max = Math.max(...dist);
  const out: ObjectGround = { verdict: null, min, max, corners };
  if (missing.length) out.missing = [...new Set(missing)];
  if (min > 0.05) out.verdict = `floats ${min.toFixed(2)} m`;
  else if (max < -0.05) out.verdict = `${(-max).toFixed(2)} m in the ground`;
  return out;
}
