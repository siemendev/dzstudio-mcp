import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cmpRevision, FORMAT, REVISION, sha256 } from './format.js';

export const DEFAULT_BASE = 'https://uploads.dzbot.de/world-data/';
export const DEFAULT_POINTER = 'https://dzbot.de/api/public/world-data';
const POINTER_TTL_MS = 5 * 60_000;
export const DEFAULT_CACHE_LIMIT = 2 * 1024 ** 3;

/** Where world data come from, configured once: a base address (https:// or file://) and, for https, the pointer. */
export interface WorldDataConfig {
  base?: string;
  pointer?: string;
  cacheDir?: string;
  /** Most bytes the disk cache may hold; above it the least recently used files go. */
  cacheLimit?: number;
}

export interface PointerWorld {
  map?: string;
  world: string;
  revision: string;
  game?: string;
}

export interface Pointer {
  format: number;
  base?: string;
  classes: string;
  worlds: PointerWorld[];
}

/** Data that cannot be had right now (offline, not published). */
export class DataUnavailable extends Error {}
/** A file whose size or checksum does not match, even after loading it again. */
export class DataCorrupt extends Error {}
export class NewerFormat extends Error {
  constructor() {
    super('World data in a newer format — update the MCP');
  }
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface SourceOptions extends WorldDataConfig {
  /** Folder for downloaded files; one subfolder per base address. */
  cacheDir: string;
  fetch?: FetchFn;
}

function slash(url: string): string {
  return url.endsWith('/') ? url : url + '/';
}

function cacheName(base: string): string {
  return base
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^A-Za-z0-9.-]+/g, '_')
    .replace(/_+$/, '');
}

function writeAtomic(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

function latestIn(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const revs = readdirSync(dir).filter((r) => REVISION.test(r));
  revs.sort(cmpRevision);
  return revs[revs.length - 1];
}

/**
 * Reads world data from a local folder or a base address. Downloaded files are kept on disk below their revision and
 * never requested again; tiles and rasters are checked against size and SHA-256 on every load, and a mismatch in the
 * cache is discarded and loaded once more.
 */
export class WorldDataSource {
  readonly base: string;
  readonly local: string | undefined;
  readonly pointerUrl: string | undefined;
  private readonly cache: string | undefined;
  private readonly fetchFn: FetchFn;
  private pointerAt = 0;
  private pointerValue: Pointer | undefined;
  readonly cacheLimit: number;
  /** Cached files below the base (path relative to it, with `/`): size and last use. */
  private cached: Map<string, { bytes: number; used: number }> | undefined;
  private inUse: () => Iterable<string> = () => [];

  constructor(opts: SourceOptions) {
    const base = slash(opts.base ?? DEFAULT_BASE);
    this.base = base;
    this.fetchFn = opts.fetch ?? fetch;
    this.cacheLimit = opts.cacheLimit ?? DEFAULT_CACHE_LIMIT;
    if (base.startsWith('file:')) {
      this.local = fileURLToPath(base);
    } else if (/^https?:/.test(base)) {
      this.cache = join(opts.cacheDir, cacheName(base));
    } else {
      this.local = base;
    }
    this.pointerUrl = opts.pointer ?? (!this.local && base === DEFAULT_BASE ? DEFAULT_POINTER : undefined);
  }

  /** The current revisions; at most every 5 minutes from the network, otherwise the last answer. */
  async pointer(): Promise<Pointer> {
    if (this.pointerValue && Date.now() - this.pointerAt < POINTER_TTL_MS) return this.pointerValue;
    let p: Pointer | undefined;
    if (this.pointerUrl) {
      const stored = this.cache ? join(this.cache, 'pointer.json') : undefined;
      try {
        const bytes = await this.download(this.pointerUrl);
        p = JSON.parse(Buffer.from(bytes).toString('utf8')) as Pointer;
        if (stored) writeAtomic(stored, bytes);
      } catch (e) {
        if (this.pointerValue) return this.pointerValue;
        if (stored && existsSync(stored)) p = JSON.parse(readFileSync(stored, 'utf8')) as Pointer;
        else throw e instanceof DataUnavailable ? e : new DataUnavailable((e as Error).message);
      }
    } else if (this.local) {
      p = this.scanLocal();
    } else {
      throw new DataUnavailable(`No pointer configured for ${this.base}`);
    }
    if (typeof p.format !== 'number' || p.format > FORMAT) throw new NewerFormat();
    this.pointerValue = p;
    this.pointerAt = Date.now();
    return p;
  }

  /** A pointer built from a local folder: the newest revision of every world and of the class data. */
  private scanLocal(): Pointer {
    const root = this.local!;
    const worlds: PointerWorld[] = [];
    const worldsDir = join(root, 'worlds');
    if (existsSync(worldsDir)) {
      for (const world of readdirSync(worldsDir).sort()) {
        const revision = latestIn(join(worldsDir, world));
        if (!revision) continue;
        const entry: PointerWorld = { world, revision };
        try {
          const m = JSON.parse(readFileSync(join(worldsDir, world, revision, 'manifest.json'), 'utf8'));
          if (typeof m.map === 'string') entry.map = m.map;
          if (typeof m.game === 'string') entry.game = m.game;
        } catch {
          continue;
        }
        worlds.push(entry);
      }
    }
    const classes = latestIn(join(root, 'classes'));
    if (!classes && !worlds.length) throw new DataUnavailable(`No world data in ${root}`);
    return { format: FORMAT, classes: classes ?? '', worlds };
  }

  private async download(url: string): Promise<Uint8Array> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new DataUnavailable(`not reachable: ${url} (${(e as Error).message})`);
    }
    if (res.status === 404) throw new DataUnavailable(`not published: ${url}`);
    if (!res.ok) throw new DataUnavailable(`HTTP ${res.status}: ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Bytes of an immutable file below the base (a path under a revision). */
  async file(rel: string): Promise<Uint8Array> {
    if (this.local) {
      const p = join(this.local, ...rel.split('/'));
      if (!existsSync(p)) throw new DataUnavailable(`missing: ${rel}`);
      return readFileSync(p);
    }
    const p = join(this.cache!, ...rel.split('/'));
    if (existsSync(p)) {
      const bytes = readFileSync(p);
      this.touch(rel, p, bytes.length);
      return bytes;
    }
    const bytes = await this.download(this.base + rel);
    writeAtomic(p, bytes);
    this.touch(rel, p, bytes.length);
    this.trim();
    return bytes;
  }

  /**
   * Names the revisions that must stay in the cache: a function returning path prefixes below the base, such as
   * `worlds/chernarusplus/1.30-1/` or `classes/1.30-1/`. Nothing below them is ever evicted.
   */
  protect(inUse: () => Iterable<string>): void {
    this.inUse = inUse;
  }

  private index(): Map<string, { bytes: number; used: number }> {
    if (this.cached) return this.cached;
    const out = new Map<string, { bytes: number; used: number }>();
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && !e.name.endsWith('.tmp')) {
          const rel = relative(this.cache!, full).split(sep).join('/');
          if (rel === 'pointer.json') continue;
          const st = statSync(full);
          out.set(rel, { bytes: st.size, used: st.mtimeMs });
        }
      }
    };
    walk(this.cache!);
    this.cached = out;
    return out;
  }

  /** Records a use; the file's modification time carries it across restarts. */
  private touch(rel: string, path: string, bytes: number): void {
    const now = Date.now();
    const idx = this.index();
    const prev = idx.get(rel);
    idx.delete(rel);
    idx.set(rel, { bytes, used: Math.max(now, (prev?.used ?? 0) + 1) });
    try {
      utimesSync(path, new Date(now), new Date(now));
    } catch {
      // the use still counts for this run
    }
  }

  private forget(rel: string): void {
    rmSync(join(this.cache!, ...rel.split('/')), { force: true });
    this.cached?.delete(rel);
  }

  /** Bytes the disk cache holds now. */
  get cacheBytes(): number {
    let n = 0;
    if (this.cache) for (const e of this.index().values()) n += e.bytes;
    return n;
  }

  /** Deletes the least recently used files until the cache fits its limit, sparing the revisions in use. */
  trim(): void {
    if (!this.cache) return;
    const idx = this.index();
    let total = this.cacheBytes;
    if (total <= this.cacheLimit) return;
    const keep = [...this.inUse()];
    const order = [...idx.entries()].sort((a, b) => a[1].used - b[1].used);
    for (const [rel, e] of order) {
      if (total <= this.cacheLimit) break;
      if (keep.some((k) => rel.startsWith(k))) continue;
      this.forget(rel);
      total -= e.bytes;
    }
  }

  async json<T>(rel: string): Promise<T> {
    return JSON.parse(Buffer.from(await this.file(rel)).toString('utf8')) as T;
  }

  /** A file the manifest or class index lists with size and SHA-256. */
  async verified(rel: string, bytes: number, sum: string): Promise<Uint8Array> {
    const ok = (b: Uint8Array) => b.length === bytes && sha256(b) === sum;
    const first = await this.file(rel);
    if (ok(first)) return first;
    if (this.local) throw new DataCorrupt(`map data corrupt: ${rel}`);
    this.forget(rel);
    const again = await this.file(rel);
    if (ok(again)) return again;
    this.forget(rel);
    throw new DataCorrupt(`map data corrupt: ${rel}`);
  }
}
