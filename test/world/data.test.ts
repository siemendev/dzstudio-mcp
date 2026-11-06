import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClassIndex, objectGround, orientedBox, overlapDepth, rowsFrom, WorldData } from '../../src/world/data.js';
import { NewerFormat, WorldDataSource } from '../../src/world/source.js';
import { FIXTURE } from '../support/world-fixture.js';

const TILE_0_0 = 'worlds/testworld/1.30-1/tiles/0_0.bin.gz';

async function open(source: WorldDataSource): Promise<WorldData> {
  const p = await source.pointer();
  const w = p.worlds.find((x) => x.map === 'testmap')!;
  return WorldData.load(source, w.world, w.revision, await ClassIndex.load(source, p.classes));
}

const crate = (y: number) => ({ x: 100, y, z: 300, rows: rowsFrom(0, 0, 0, 1) });

describe('world data from a local folder', () => {
  let wd: WorldData;

  beforeAll(async () => {
    wd = await open(new WorldDataSource({ base: pathToFileURL(FIXTURE).href, cacheDir: mkdtempSync(join(tmpdir(), 'wd-')) }));
  });

  it('finds the world and the class data of the folder', async () => {
    const source = new WorldDataSource({ base: pathToFileURL(FIXTURE).href, cacheDir: '' });
    expect(await source.pointer()).toEqual({
      format: 1,
      classes: '1.30-1',
      worlds: [{ world: 'testworld', map: 'testmap', revision: '1.30-1', game: '1.30.164078' }],
    });
  });

  it('terrain height: exact on grid points, the mean between four points, the same on a tile edge', async () => {
    expect(await wd.heightAt(100, 100)).toBe(100);
    expect(await wd.heightAt(350, 10)).toBe(105);
    expect(await wd.heightAt(350.5, 10.5)).toBeCloseTo(105.05, 6);
    expect(await wd.heightAt(256, 300)).toBe(100);
    expect(await wd.heightAt(511.5, 100)).toBeCloseTo(121.1, 6);
  });

  it('surface: road with its walkable surface, sea with sea level, pond', async () => {
    expect(await wd.surfaceAt(100.2, 102)).toEqual({
      material: 'cp_concrete',
      water: 'none',
      terrain: 100,
      roadway: { model: 'dz\\structures\\roads\\parts\\asf1_25.p3d', height: 100.12, aboveTerrain: 0.12 },
    });
    expect(await wd.surfaceAt(100, 500)).toMatchObject({
      material: 'sea_water',
      water: 'sea',
      seaLevel: { min: 0.5, max: 1 },
      roadway: null,
    });
    expect(await wd.surfaceAt(25, 25)).toMatchObject({ water: 'pond', roadway: null });
  });

  it('objects: boxes from neighbouring tiles by reach, unknown boxes by origin, angles', async () => {
    const near = await wd.objectsIn({ circle: { x: 300, z: 60, radius: 5 } });
    expect(near.objects.map((o) => o.class)).toEqual(['Land_Test_PowerLine']);
    expect(near.objects[0]!.id).toMatch(/^testworld\/1\.30-1\/0_0\/\d+$/);

    const wall = await wd.objectsIn({ circle: { x: 160, z: 170, radius: 1 } });
    expect(wall.objects.map((o) => [o.class, o.box])).toEqual([['SomeMod_Wall', null]]);
    expect((await wd.objectsIn({ circle: { x: 400, z: 400, radius: 0.5 } })).objects.map((o) => [o.shape, o.box])).toEqual([
      ['dz\\plants\\tree\\t_testtree.p3d', null],
    ]);

    const turned = (await wd.objectsIn({ rect: { minX: 410, minZ: 140, maxX: 430, maxZ: 160 } })).objects;
    expect(turned).toHaveLength(1);
    expect([turned[0]!.yaw, turned[0]!.pitch, turned[0]!.roll, turned[0]!.scale].map((v) => v + 0)).toEqual([90, 0, 0, 1]);
    expect((await wd.objectsIn({ circle: { x: 100, z: 100, radius: 1 } })).objects).toEqual([]);
  });

  it('classes by name ignoring case and punctuation, by model path, unknown as null', () => {
    const c = wd.classes.find('landmilbarracks2')!;
    expect(c.name).toBe('Land_Mil_Barracks2');
    expect(c.size).toEqual([25.76, 8.08, 10.32]);
    expect(c.collision).toEqual([-10.73, -3.37, -4.3, 8.23, 3.37, 4.3]);
    expect(c.raster).toMatchObject({ nx: 134, nz: 57, step: 0.2 });
    expect(wd.classes.shape('DZ\\Structures\\Military\\Houses\\Mil_Barracks2.p3d')?.id).toBe(c.id);
    expect(wd.classes.find('SomeMod_Wall')).toBeNull();
  });

  it('walkable surfaces of buildings from their rasters', async () => {
    const inside = await wd.rasterSurfaces(150, 200);
    expect(inside.missing).toEqual([]);
    expect(inside.surfaces).toHaveLength(1);
    expect(inside.surfaces[0]!.model).toBe('dz\\structures\\military\\houses\\mil_barracks2.p3d');
    expect(inside.surfaces[0]!.height).toBeGreaterThan(99);
    expect((await wd.rasterSurfaces(100, 300)).surfaces).toEqual([]);
  });

  it('height above ground: floats 0.3 m, or standing on the ground', async () => {
    const entry = wd.classes.find('WoodenCrate')!;
    expect((await objectGround(wd, entry, crate(100.3))).verdict).toBe('floats 0.30 m');
    const standing = await objectGround(wd, entry, crate(100));
    expect([standing.verdict, standing.min, standing.max]).toEqual([null, 0, 0]);
    expect((await objectGround(wd, entry, crate(99))).verdict).toBe('1.00 m in the ground');
  });

  it('overlap: barracks on the static barracks 6.74 m deep, 30 m east none', async () => {
    const entry = wd.classes.find('Land_Mil_Barracks2')!;
    const statics = (await wd.objectsIn({ circle: { x: 150, z: 200, radius: 1 } })).objects;
    const there = { x: 150, y: 103.37, z: 200, rows: rowsFrom(0, 0, 0, 1) };
    expect(overlapDepth(orientedBox(entry, there)!, orientedBox(statics[0]!.box!, statics[0]!)!)).toBeCloseTo(6.74, 6);
    const east = { ...there, x: 180 };
    expect(overlapDepth(orientedBox(entry, east)!, orientedBox(statics[0]!.box!, statics[0]!)!)).toBeNull();
  });
});

describe('world data from a base address', () => {
  let server: Server;
  let root = '';
  let url = '';
  const requests: string[] = [];
  let pointer = { format: 1, classes: '1.30-1', worlds: [{ map: 'testmap', world: 'testworld', revision: '1.30-1', game: '1.30.164078' }] };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'wd-http-'));
    cpSync(FIXTURE, root, { recursive: true });
    server = createServer((req, res) => {
      requests.push(req.url!);
      if (req.url === '/pointer') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(pointer));
        return;
      }
      try {
        const body = readFileSync(join(root, decodeURIComponent(req.url!.replace(/^\/data\//, ''))));
        res.writeHead(200);
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const source = (cacheDir: string) => new WorldDataSource({ base: `${url}/data/`, pointer: `${url}/pointer`, cacheDir });

  it('downloads once per revision, checks every tile, reloads a changed one and reports a corrupt one', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'wd-cache-'));
    const first = await open(source(cache));
    expect(await first.heightAt(100, 100)).toBe(100);
    expect(requests.filter((r) => r.endsWith('0_0.bin.gz'))).toHaveLength(1);

    const again = await open(source(cache));
    expect(await again.heightAt(100, 100)).toBe(100);
    expect(requests.filter((r) => r.endsWith('0_0.bin.gz'))).toHaveLength(1);

    const cached = join(cache, `127.0.0.1_${url.split(':').pop()}_data`, ...TILE_0_0.split('/'));
    const bytes = readFileSync(cached);
    bytes[bytes.length - 1]! ^= 0xff;
    writeFileSync(cached, bytes);
    const fixed = await open(source(cache));
    expect(await fixed.heightAt(100, 100)).toBe(100);
    expect(requests.filter((r) => r.endsWith('0_0.bin.gz'))).toHaveLength(2);

    const served = join(root, ...TILE_0_0.split('/'));
    const good = readFileSync(served);
    writeFileSync(served, Buffer.concat([good, Buffer.from([0])]));
    try {
      const fresh = await open(source(mkdtempSync(join(tmpdir(), 'wd-cache-'))));
      expect((await fresh.objectsIn({ circle: { x: 150, z: 200, radius: 5 } })).missing).toEqual(['0_0 corrupt']);
      await expect(fresh.heightAt(10, 10)).rejects.toThrow('map data corrupt');
    } finally {
      writeFileSync(served, good);
    }
  });

  it('works offline from the cache and names what is missing', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'wd-cache-'));
    const online = await open(source(cache));
    const want = await online.objectsIn({ circle: { x: 150, z: 200, radius: 30 } });
    const offline = new WorldDataSource({ base: 'http://127.0.0.1:9/data/', pointer: 'http://127.0.0.1:9/pointer', cacheDir: cache });
    await expect(offline.pointer()).rejects.toThrow();
    const copy = join(cache, '127.0.0.1_9_data');
    cpSync(join(cache, `127.0.0.1_${url.split(':').pop()}_data`), copy, { recursive: true });
    const wd = await open(offline);
    expect(await wd.objectsIn({ circle: { x: 150, z: 200, radius: 30 } })).toEqual(want);
    expect((await wd.objectsIn({ circle: { x: 400, z: 400, radius: 5 } })).missing).toEqual(['1_1']);
  });

  it('refuses a pointer in a newer format', async () => {
    pointer = { ...pointer, format: 2 };
    try {
      await expect(source(mkdtempSync(join(tmpdir(), 'wd-cache-'))).pointer()).rejects.toThrow(NewerFormat);
    } finally {
      pointer = { ...pointer, format: 1 };
    }
  });
});
