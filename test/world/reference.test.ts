import { existsSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { ClassIndex, objectGround, orientedBox, overlapDepth, rowsFrom, WorldData } from '../../src/world/data.js';
import { WorldDataSource } from '../../src/world/source.js';

/**
 * Compares the answers with the JavaScript reader of the converter on a full converted world. Opt-in: needs a converted
 * data set in DZSTUDIO_MCP_WORLD_DATA_REFERENCE (default /tmp/world-data-out) and the reader in
 * DZSTUDIO_MCP_WORLD_DATA_READER (default: the converter's world_data_read.js next to this repository's studio folder).
 */

const DATA = process.env.DZSTUDIO_MCP_WORLD_DATA_REFERENCE ?? '/tmp/world-data-out';
const READER =
  process.env.DZSTUDIO_MCP_WORLD_DATA_READER ?? resolve(import.meta.dirname, '../../../../tools/map-export/tools/world_data_read.js');
const WORLD = process.env.DZSTUDIO_MCP_WORLD_DATA_WORLD ?? 'chernarusplus';
const runnable = existsSync(join(DATA, 'worlds', WORLD)) && existsSync(READER);

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!runnable)(`same answers as the JavaScript reader on ${WORLD}`, () => {
  let js: any;
  let ref: any;
  let wd: WorldData;
  let classes: ClassIndex;
  const random = rng(20261106);

  beforeAll(async () => {
    js = createRequire(import.meta.url)(READER);
    ref = new js.WorldData(DATA, WORLD);
    const source = new WorldDataSource({ base: pathToFileURL(DATA).href, cacheDir: mkdtempSync(join(tmpdir(), 'dzstudio-mcp-ref-')) });
    classes = await ClassIndex.load(source, ref.manifest.classes);
    wd = await WorldData.load(source, WORLD, ref.revision, classes);
  });

  function points(n: number): [number, number][] {
    const size = wd.manifest.size;
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const kind = i % 4;
      let x = random() * size;
      let z = random() * size;
      if (kind === 1) x = Math.floor(x / 256) * 256;
      if (kind === 2) [x, z] = [Math.round(x), Math.round(z)];
      if (kind === 3 && i % 8 === 3) [x, z] = [size - random() * 2, size - random() * 2];
      out.push([x, z]);
    }
    return out;
  }

  it('heights, surface and walkable surfaces at 400 points', async () => {
    for (const [x, z] of points(400)) {
      expect(await wd.heightAt(x, z), `height ${x} ${z}`).toBe(ref.heightAt(x, z));
      expect(await wd.surfaceAt(x, z), `surface ${x} ${z}`).toEqual(ref.surfaceAt(x, z));
    }
  });

  it('objects around 60 points, with distance, angles and boxes', async () => {
    const places = wd.manifest.places;
    let compared = 0;
    for (let i = 0; i < 60; i++) {
      const p = places[Math.floor(random() * places.length)]!;
      const x = i % 5 === 0 ? Math.round(p.x / 256) * 256 : p.x + (random() - 0.5) * 300;
      const z = i % 5 === 0 ? Math.round(p.z / 256) * 256 : p.z + (random() - 0.5) * 300;
      const radius = 10 + random() * 90;
      const want = ref.objectsInCircle(x, z, radius);
      const got = await wd.objectsIn({ circle: { x, z, radius } });
      expect(got.missing).toEqual(want.missing);
      expect(got.objects.map((o) => o.id)).toEqual(want.objects.map((o: any) => o.id));
      compared += got.objects.length;
      got.objects.forEach((o, k) => {
        const w = want.objects[k];
        expect([o.class, o.shape, o.flags, o.x, o.y, o.z, o.yaw, o.pitch, o.roll, o.scale, o.distance]).toEqual([
          w.class,
          w.shape,
          w.flags,
          w.x,
          w.y,
          w.z,
          w.yaw,
          w.pitch,
          w.roll,
          w.scale,
          w.distance,
        ]);
        expect(o.box?.id ?? null).toBe(w.box ? classes.shape(w.box.shape)!.id : null);
      });
    }
    expect(compared).toBeGreaterThan(1000);
    console.log(`compared ${compared} objects`);
  });

  it('class lookup for 300 names, case-insensitive and loose, and by model path', async () => {
    const jsClasses = ref.classes;
    const names = Object.keys(jsClasses.index.classes);
    for (let i = 0; i < 300; i++) {
      const name = names[Math.floor(random() * names.length)]!;
      const q = i % 3 === 0 ? name : i % 3 === 1 ? name.toLowerCase() : name.toUpperCase().replace(/_/g, '');
      const want = jsClasses.find(q);
      const got = classes.find(q);
      expect(got?.name).toBe(want?.name);
      expect(got?.id).toBe(want?.id);
      const shape = jsClasses.index.shapes[want.id].shape;
      expect(classes.shape(shape)?.id).toBe(jsClasses.shape(shape)?.id);
    }
    expect(classes.find('No_Such_Class_Anywhere')).toBeNull();
  });

  it('height above ground and overlap of 150 hypothetical placements', async () => {
    const names = Object.keys(classes.index.classes).filter((n) => classes.find(n)?.clip);
    const seen = { verdicts: new Set<string>(), pairs: 0, hits: 0 };
    for (let i = 0; i < 150; i++) {
      const name = names[Math.floor(random() * names.length)]!;
      const entry = classes.find(name)!;
      const [x, z] = points(1)[0]!;
      const o = {
        x,
        z,
        y: ref.heightAt(x, z) + (random() - 0.3) * 2,
        rows: rowsFrom(random() * 360 - 180, (random() - 0.5) * 20, (random() - 0.5) * 20, 0.5 + random()),
      };
      expect(rowsFrom(1, 2, 3, 1.2)).toEqual(js.rowsFrom(1, 2, 3, 1.2));
      const want = js.objectGround(ref, entry, o);
      const got = await objectGround(wd, entry, o);
      expect([got.verdict, got.min, got.max]).toEqual([want.verdict, want.min, want.max]);
      seen.verdicts.add(String(got.verdict).replace(/[\d.]+/, 'x'));

      const near = ref.objectsInCircle(x, z, 30).objects.filter((s: any) => s.box);
      const A = orientedBox(entry, o);
      const Aj = js.orientedBox(entry, o);
      for (const s of near.slice(0, 5)) {
        const depth = overlapDepth(A!, orientedBox(s.box, s)!);
        expect(depth).toBe(js.overlapDepth(Aj, js.orientedBox(s.box, s)));
        seen.pairs++;
        if (depth !== null) seen.hits++;
      }
    }
    expect(seen.verdicts.size).toBe(3);
    expect(seen.pairs).toBeGreaterThan(50);
    expect(seen.hits).toBeGreaterThan(0);
    console.log(`compared ${seen.pairs} overlap pairs (${seen.hits} intersecting), verdicts ${[...seen.verdicts].join(' / ')}`);
  });
});
