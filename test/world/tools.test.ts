import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/config/config.js';
import { Agent } from '../../src/mcp/agent.js';
import { createServer } from '../../src/mcp/server.js';
import { WorldDataSource } from '../../src/world/source.js';
import { WorldTools } from '../../src/world/tools.js';
import { FakeServer } from '../support/fake-server.js';
import { FIXTURE } from '../support/world-fixture.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));

describe('world tools through MCP', () => {
  let agent: Agent;
  let client: Client;
  let ids: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    const json = text.indexOf('\n{');
    const end = text.indexOf('\n\nEvents:');
    const data = json >= 0 ? JSON.parse(text.slice(json + 1, end >= 0 ? end : undefined)) : undefined;
    return { text: json >= 0 ? text.slice(0, json) : text, isError: !!res.isError, data };
  };

  beforeAll(async () => {
    const fake = new FakeServer();
    const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'dzstudio-mcp-world-')), { DZSTUDIO_MCP_WORLD_DATA: FIXTURE });
    store.addServer('fake', 'http://fake.invalid/dzcollab/');
    store.setCredential('fake', { token: 't-agent-Patrick', name: 'Patrick' });
    expect(store.worldData().base!.replace(/\/?$/, '/')).toBe(pathToFileURL(FIXTURE).href);
    agent = new Agent({ store, transport: () => fake, timing: { pollWaitMs: 100, retryDelayMs: 10, confirmTimeoutMs: 2000 } });
    const mcp = createServer(agent, new WorldTools(agent, new WorldDataSource(store.worldData())));
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' });
    await Promise.all([mcp.connect(a), client.connect(b)]);

    const host = fake.createSession({ state: golden.Z1!, map: 'testmap' });
    expect((await call('join_session', { session_id: host.sessionId })).isError).toBe(false);
    const created = await call('create_objects', {
      groups: [{ ref: 'g', name: 'Camp' }],
      objects: [
        { class: 'WoodenCrate', group: 'g', position: [100, 100.3, 300] },
        { class: 'Land_Mil_Barracks2', group: 'g', position: [150, 103.37, 200] },
        { class: 'SomeMod_Crate', group: 'g', position: [161, 100, 171] },
      ],
    });
    expect(created.isError).toBe(false);
    ids = created.data.objects;
  });

  afterAll(async () => {
    await agent.shutdown();
    await client.close();
  });

  it('world_info: the session map, revisions and places', async () => {
    const r = await call('world_info', { near: { x: 150, z: 200, radius: 100 } });
    expect(r.text).toBe('testmap is testworld, map data 1.30-1 (game 1.30.164078, exported 2026-11-06), class data 1.30-1');
    expect(r.data).toMatchObject({ world: 'testworld', revision: '1.30-1', size: 512, tiles: { cols: 2, rows: 2 } });
    expect(r.data.places).toEqual([{ id: 'Village_Testdorf', type: 'Village', name: 'Testdorf', x: 150, z: 200, distance: 0 }]);
    expect((await call('world_info', { place: 'berg' })).data.places.map((p: any) => p.name)).toEqual(['Testberg']);
  });

  it('world_objects: map and project objects, with "box unknown"', async () => {
    const r = await call('world_objects', { near: { x: 155, z: 190, radius: 25 } });
    expect(r.data.objects.map((o: any) => [o.source, o.class, o.size])).toEqual([
      ['map', 'Land_Mil_Barracks2', [25.76, 8.08, 10.32]],
      ['project', 'Land_Mil_Barracks2', [25.76, 8.08, 10.32]],
      ['project', 'SomeMod_Crate', 'box unknown'],
      ['map', 'SomeMod_Wall', 'box unknown'],
    ]);
    expect(r.text).toBe('4 objects (2 map, 2 project); 2 objects without a known box: SomeMod_Crate, SomeMod_Wall');
    expect(r.data.objects[0]).toMatchObject({ position: [150, 103.37, 200], orientation: [0, 0, 0], scale: 1, distance: 4.84 });
    const lines = await call('world_objects', { near: { x: 300, z: 60, radius: 5 }, flags: 1 });
    expect(lines.data.objects.map((o: any) => o.class)).toEqual(['Land_Test_PowerLine']);
  });

  it('ground_at: height, road, sea, and the highest surface below a height', async () => {
    const r = await call('ground_at', {
      points: [
        { x: 350.5, z: 10.5 },
        { x: 100, z: 102, y: 101 },
        { x: 100, z: 500 },
        { x: 150, z: 200, y: 120 },
      ],
    });
    const [slope, road, sea, building] = r.data.points;
    expect(slope).toEqual({ x: 350.5, z: 10.5, height: 105.05, material: 'cp_grass', water: 'none' });
    expect(road.roadway).toEqual({ model: 'dz\\structures\\roads\\parts\\asf1_25.p3d', height: 100.12, aboveTerrain: 0.12 });
    expect(road.below).toMatchObject({ kind: 'roadway', height: 100.12, distance: 0.88 });
    expect(sea).toMatchObject({ water: 'sea', seaLevel: { min: 0.5, max: 1 } });
    expect(building.objectSurfaces).toHaveLength(1);
    expect(building.below.kind).toBe('object');
  });

  it('object_ground: a crate 0.3 m above flat ground floats; a placement on the ground does not', async () => {
    const r = await call('object_ground', { ids: [ids[0]], placement: { class: 'WoodenCrate', position: [100, 100, 300] } });
    expect(r.data.objects[0]).toMatchObject({ class: 'WoodenCrate', verdict: 'floats 0.30 m', min: 0.3, max: 0.3 });
    expect(r.data.objects[1]).toMatchObject({ id: 'placement', min: 0, max: 0 });
    expect(r.data.objects[1].verdict).toMatch(/^between/);
    expect((await call('object_ground', { ids: [ids[2]] })).data.objects[0]).toEqual({
      id: ids[2],
      class: 'SomeMod_Crate',
      ground: 'box unknown',
    });
  });

  it('check_overlap: a barracks on the static one; unknown boxes named, never free', async () => {
    const r = await call('check_overlap', { ids: [ids[1]], placement: { class: 'Land_Mil_Barracks2', position: [180, 103.37, 200] } });
    const [onTop, east] = r.data.objects;
    expect(onTop.overlaps).toEqual([expect.objectContaining({ source: 'map', class: 'Land_Mil_Barracks2', depth: 6.74 })]);
    expect(east.overlaps).toEqual([]);
    expect(r.text).toBe(
      `${ids[1]} (Land_Mil_Barracks2): intersects 1 object; placement (Land_Mil_Barracks2): no intersection with known boxes`,
    );

    const beside = await call('check_overlap', { placement: { class: 'WoodenCrate', position: [160.5, 100, 170.5] } });
    expect(beside.data.objects[0]).toEqual({
      id: 'placement',
      class: 'WoodenCrate',
      overlaps: [],
      withoutKnownBox: { count: 2, classes: ['SomeMod_Wall', 'SomeMod_Crate'] },
    });
    expect(beside.text).toBe(
      'placement (WoodenCrate): no intersection with known boxes; 2 objects without a known box: SomeMod_Wall, SomeMod_Crate',
    );
    const unknown = await call('check_overlap', { ids: [ids[2]] });
    expect(unknown.data.objects[0].overlaps).toBe('box unknown');
  });

  it('class_info: by name ignoring case, by model path, unknown', async () => {
    const r = await call('class_info', { names: ['landmilbarracks2', 'dz\\gear\\camping\\wooden_case.p3d', 'SomeMod_Wall'] });
    expect(r.text).toBe('2 of 3 found in class data 1.30-1; unknown: SomeMod_Wall');
    expect(r.data.classes[0]).toMatchObject({ class: 'Land_Mil_Barracks2', size: [25.76, 8.08, 10.32], flags: 273, raster: true });
    expect(r.data.classes[1]).toMatchObject({ model: 'dz\\gear\\camping\\wooden_case.p3d', scan: 'dynamic', raster: false });
    expect(r.data.classes[2]).toEqual({ query: 'SomeMod_Wall', unknown: true });
  });

  it('a map without data: project objects only, ground unknown', async () => {
    const info = await call('world_info', { map: 'deerisle' });
    expect(info.text).toBe('No map data for deerisle — project objects only');
    const ground = await call('ground_at', { map: 'deerisle', points: [{ x: 1, z: 2 }] });
    expect(ground.text).toBe('No map data for deerisle — project objects only. Ground: unknown');
    expect(ground.data.points).toEqual([{ x: 1, z: 2, ground: 'unknown' }]);
    const og = await call('object_ground', { map: 'deerisle', placement: { class: 'WoodenCrate', position: [1, 2, 3] } });
    expect(og.data.objects[0].ground).toBe('unknown');
  });
});
