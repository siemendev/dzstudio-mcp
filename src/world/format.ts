import { createHash } from 'node:crypto';

/**
 * The binary files of world data format 1: 256 m map tiles (`DZWT`) and model rasters (`DZWS`), both gzip over
 * little-endian bytes. Lengths in the files are whole centimetres (heights, positions) or millimetres (raster grid).
 */

export const FORMAT = 1;
export const TILE = 256;
export const POINTS = TILE + 1;
export const REVISION = /^[0-9]+\.[0-9]+-[1-9][0-9]*$/;
export const CHANNELS = ['f', 'v', 'g', 'r'] as const;
export type Channel = (typeof CHANNELS)[number];

/** First 16 hex characters of the SHA-1 over the lower-case model path. */
export function modelId(shape: string): string {
  return createHash('sha1').update(shape.toLowerCase(), 'utf8').digest('hex').slice(0, 16);
}

export function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Orders revisions `<major>.<minor>-<n>`. */
export function cmpRevision(a: string, b: string): number {
  const [va = '', na = '0'] = a.split('-');
  const [vb = '', nb = '0'] = b.split('-');
  return cmpVersion(va, vb) || Number(na) - Number(nb);
}

class Reader {
  private readonly view: DataView;
  off = 0;

  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  u8(): number {
    return this.view.getUint8(this.off++);
  }
  u16(): number {
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }
  i16(): number {
    const v = this.view.getInt16(this.off, true);
    this.off += 2;
    return v;
  }
  u32(): number {
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }
  i32(): number {
    const v = this.view.getInt32(this.off, true);
    this.off += 4;
    return v;
  }
  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.buf[this.off + i]!);
    this.off += n;
    return s;
  }
  varint(): number {
    let v = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.buf[this.off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  }
  sub(n: number): Reader {
    const r = new Reader(this.buf.subarray(this.off, this.off + n));
    this.off += n;
    return r;
  }
}

export interface TileObjects {
  n: number;
  /** Index into the manifest's `objects`. */
  tab: Int32Array;
  /** cm from the tile's south-west corner. */
  x: Int32Array;
  z: Int32Array;
  /** cm above sea level. */
  y: Int32Array;
  /** Per object 9 values ×10⁶: side, up, forward rows. */
  m: Int32Array;
}

export interface Tile {
  tx: number;
  tz: number;
  /** cm, 257 × 257, row r = 0 (south) first. */
  heights: Int32Array;
  /** Index into the manifest's `materials`. */
  matl: Uint16Array;
  /** Walkable surfaces: point numbers ascending, roadway shape index, height above the terrain in cm. */
  road: { k: Int32Array; shape: Int32Array; dh: Int32Array };
  objs: TileObjects;
}

export function decodeTile(raw: Uint8Array): Tile {
  const r = new Reader(raw);
  if (r.ascii(4) !== 'DZWT') throw new Error('not a tile');
  const format = r.u16();
  if (format !== FORMAT) throw new Error(`tile format ${format}`);
  const tx = r.u16();
  const tz = r.u16();
  const count = r.u16();
  const N = POINTS * POINTS;
  let heights = new Int32Array(N);
  let matl = new Uint16Array(N);
  let road = { k: new Int32Array(0), shape: new Int32Array(0), dh: new Int32Array(0) };
  let objs: TileObjects = {
    n: 0,
    tab: new Int32Array(0),
    x: new Int32Array(0),
    z: new Int32Array(0),
    y: new Int32Array(0),
    m: new Int32Array(0),
  };
  for (let s = 0; s < count; s++) {
    const id = r.ascii(4);
    const enc = r.u8();
    r.off += 3;
    const len = r.u32();
    const p = r.sub(len);
    if (id === 'HGHT') {
      const base = p.i32();
      const h = new Int32Array(N);
      for (let row = 0; row < POINTS; row++) {
        for (let c = 0; c < POINTS; c++) {
          const i = row * POINTS + c;
          if (enc === 1) h[i] = c === 0 ? base + p.i16() : h[i - 1]! + p.i16();
          else h[i] = base + p.i32();
        }
      }
      heights = h;
    } else if (id === 'MATL') {
      const m = new Uint16Array(N);
      for (let i = 0; i < N; i++) m[i] = enc === 1 ? p.u8() : p.u16();
      matl = m;
    } else if (id === 'ROAD') {
      const n = p.u32();
      const k = new Int32Array(n);
      const shape = new Int32Array(n);
      const dh = new Int32Array(n);
      let prev = 0;
      for (let i = 0; i < n; i++) {
        prev += p.varint();
        k[i] = prev;
      }
      for (let i = 0; i < n; i++) shape[i] = p.varint();
      for (let i = 0; i < n; i++) dh[i] = p.i32();
      road = { k, shape, dh };
    } else if (id === 'OBJS') {
      const n = p.u32();
      const tab = new Int32Array(n);
      const x = new Int32Array(n);
      const z = new Int32Array(n);
      const y = new Int32Array(n);
      const m = new Int32Array(n * 9);
      for (let i = 0; i < n; i++) tab[i] = p.varint();
      for (let i = 0; i < n; i++) x[i] = p.i32();
      for (let i = 0; i < n; i++) z[i] = p.i32();
      for (let i = 0; i < n; i++) y[i] = p.i32();
      for (let k = 0; k < 9; k++) for (let i = 0; i < n; i++) m[i * 9 + k] = p.i32();
      objs = { n, tab, x, z, y, m };
    }
  }
  return { tx, tz, heights, matl, road, objs };
}

export const NO_HIT = -2147483648;

export interface Raster {
  nx: number;
  nz: number;
  stepMm: number;
  x0Mm: number;
  z0Mm: number;
  /** Per present channel nx · nz heights in cm relative to the model origin; NO_HIT where nothing was hit. */
  channels: Partial<Record<Channel, Int32Array>>;
}

export function decodeRaster(raw: Uint8Array): Raster {
  const r = new Reader(raw);
  if (r.ascii(4) !== 'DZWS') throw new Error('not a raster');
  const format = r.u16();
  if (format !== FORMAT) throw new Error(`raster format ${format}`);
  const nx = r.u16();
  const nz = r.u16();
  const count = r.u8();
  r.u8();
  const out: Raster = { nx, nz, stepMm: r.u32(), x0Mm: r.i32(), z0Mm: r.i32(), channels: {} };
  for (let c = 0; c < count; c++) {
    const ch = r.ascii(1) as Channel;
    const enc = r.u8();
    const vals = new Int32Array(nx * nz);
    for (let k = 0; k < nx * nz; k++) {
      if (enc === 1) {
        const v = r.i16();
        vals[k] = v === -32768 ? NO_HIT : v;
      } else vals[k] = r.i32();
    }
    out.channels[ch] = vals;
  }
  return out;
}
