import { describe, expect, it } from 'vitest';
import { IdAllocator, readStateText, Scene, writeOperation, writeState } from '../../src/scene/index.js';
import { parseSrc } from '../../src/scene/srcjson.js';
import { getStr, toJV, type JV } from '../../src/scene/jv.js';
import { keptOf, SceneSrc } from '../../src/scene/layeredits.js';
import {
  canon6,
  changeRef,
  effectsModel,
  fixed6,
  gameFloat,
  phpNumber,
  same,
  spawnsModel,
  territoriesModel,
  type LayerModel,
} from '../../src/scene/layers.js';
import { layerRows, projectExtensions } from '../../src/scene/layerview.js';
import { loadProject, LoadRefused } from '../../src/scene/projectload.js';
import type { Element, Operation } from '../../src/scene/textform.js';

const PATRICK = { author: 'p7x2m9q4c1v8b5n3', authorName: 'Patrick' };
const P = 'k3f9a0x2mq';
const EDITOR = 'https://developers.dzbot.de/specs/dzstudio/editor/1.json';
const RULES = 'https://developers.dzbot.de/specs/dzbot/rules/1.json';
const OTHER = 'https://example.org/specs/other/1.json';

// An own event as DZS_SpawnsModel.OwnEventData writes it, a gas area as DZS_EffectsModel.PresetData writes it.
const OWN_EVENT =
  '{"name": "VehicleDzsOffroadHatchback", "nominal": 1, "min": 1, "max": 1, "lifetime": 3888000, "restock": 0, "saferadius": 500, ' +
  '"distanceradius": 500, "cleanupradius": 200, "flags": {"deletable": 0, "init_random": 0, "remove_damaged": 1}, "position": "fixed", ' +
  '"limit": "child", "active": 1}';
const GAS = (posHeight = 20): string =>
  '{"AreaName": "DzsGas1", "Type": "ContaminatedArea_Static", "TriggerType": "ContaminatedTrigger", "Data": {"Pos": [300, 0, 400], ' +
  `"Radius": 75, "PosHeight": ${posHeight}, "NegHeight": 3, "InnerRingCount": 0, "InnerPartDist": 80, "OuterRingToggle": false, "OuterPartDist": 0, ` +
  '"OuterOffset": 30, "VerticalLayers": 0, "VerticalOffset": 0, "ParticleName": "graphics/particles/contaminated_area_gas_bigass", ' +
  '"EffectInterval": 0, "EffectDuration": 0, "EffectModifier": false}, "PlayerData": {"AroundPartName": "graphics/particles/contaminated_area_gas_around", ' +
  '"TinyPartName": "graphics/particles/contaminated_area_gas_around_tiny", "PPERequesterType": "PPERequester_ContaminatedAreaTint"}}';

const FLAG =
  '{"name": "StaticFlagPole", "pos": [1234.5679, 150.125, 9876.543], "ypr": [46.2, 0.0, 0.0], "scale": 1.0, "enableCEPersistency": 0, "customString": "Flag_DayZ"}';

const BLOCKS = [
  `{"id": "g-objects", "kind": "spawnerGroup", "parent": null, "data": {"name": "Objects", "objects": [${FLAG}]}}`,
  `{"id": "sp-old1-5", "kind": "event", "parent": null, "data": ${OWN_EVENT}, "extensions": {"https://example.org/specs/notes/1.json": {"note": "from dzbot"}}}`,
  '{"id": "sp-old1-5-c", "kind": "eventChild", "parent": "sp-old1-5", "data": {"type": "OffroadHatchback", "min": 1, "max": 1, "lootmin": 0, "lootmax": 0}}',
  '{"id": "sp-old1-6", "kind": "spawnPosition", "parent": "sp-old1-5", "data": {"x": 100.000000, "z": 200.000000, "a": 45.000000}}',
  '{"id": "sp-old1-7", "kind": "spawnPosition", "parent": {"event": "VehicleCivilianSedan"}, "data": {"x": 1.5, "z": 2.5, "a": 0}}',
  `{"id": "fx-old1-8", "kind": "effectArea", "parent": null, "data": ${GAS()}}`,
  `{"id": "fx-custom", "kind": "effectArea", "parent": null, "data": ${GAS(25)}}`,
  '{"id": "tr-old1-9", "kind": "territory", "parent": null, "data": {"file": "env/wolf_territories.xml", "color": "4291611852"}}',
  '{"id": "tz-old1-10", "kind": "territoryZone", "parent": "tr-old1-9", "data": {"name": "Graze", "smin": 0, "smax": 0, "dmin": 0, "dmax": 0, "x": 500, "z": 600, "r": 150}}',
  '{"id": "glob-1", "kind": "global", "parent": null, "data": {"name": "ZombieMaxCount", "value": 1200}}',
];

const CHANGES = [
  '{"op": "set", "block": "spawnPosition", "key": {"event": "VehicleCivilianSedan", "x": 10, "z": 20}, "field": "pos", "from": {"x": 10, "z": 20, "a": 90}, "to": {"x": 11, "z": 21, "a": 90}}',
  '{"op": "remove", "block": "spawnPosition", "key": {"event": "VehicleCivilianSedan", "x": 30, "z": 40}}',
  '{"op": "set", "block": "event", "key": {"name": "VehicleCivilianSedan"}, "field": "nominal", "from": 8, "to": 12}',
  '{"op": "set", "block": "effectArea", "key": {"name": "Ship-SW"}, "field": "Data.Radius", "from": 100, "to": 150}',
  '{"op": "set", "block": "territoryZone", "key": {"file": "env/zombie_territories.xml", "name": "InfectedCity", "x": 1000, "z": 2000}, "field": "r", "from": 50, "to": 80}',
  '{"op": "set", "block": "event", "key": {"name": "AnimalWolf"}, "field": "nominal", "from": 4, "to": 6}',
  '{"op": "set", "block": "gameplay", "key": {}, "field": "GeneralData.disableBaseDamage", "from": false, "to": true}',
];

const EDITOR_PART =
  '{"provider": {"name": "My base", "map": "chernarus"}, "base": "vanilla", "project": {"groups": [{"block": "g-objects", "name": "Objects", ' +
  '"color": "#60A5FA", "hidden": false, "locked": false, "objectCount": 1, "objects": [], "plugins": {}}], "loot": {"enabled": false, ' +
  '"hidden": false, "locked": false}, "plugins": {}}}';

function project(opts: { blocks?: string[]; changes?: string[]; extensions?: string } = {}): string {
  const exts =
    opts.extensions ??
    `"${RULES}": {"data": {"settings": [{"name": "MaxCars", "value": 3}]}}, "${OTHER}": {"required": true, "data": {"k": 1}}`;
  return (
    `{"format": "dzstudio-project", "version": 2, "map": "chernarus", "slug": "my-base", "blocks": [${(opts.blocks ?? BLOCKS).join(', ')}], ` +
    `"changes": [${(opts.changes ?? CHANGES).join(', ')}], "extensions": {"${EDITOR}": {"data": ${EDITOR_PART}}${exts ? `, ${exts}` : ''}}}`
  );
}

function open(text: string) {
  const ids = new IdAllocator(P);
  const res = loadProject({ files: new Map([['manifest', text]]), ids, ...PATRICK, classKnown: () => true });
  const scene = new Scene(new IdAllocator(P));
  for (const op of [res.op, ...res.followUps]) expect(scene.apply(op)).toEqual({ result: 'applied' });
  return { ...res, scene, ids };
}

function fields(e: Element | undefined): Record<string, string> {
  return Object.fromEntries(e!.fields);
}

function jv(text: string): JV {
  return toJV(parseSrc(text).root!);
}

describe('layer kinds and operation types', () => {
  const ALL = [
    'spawns:event',
    'spawns:point',
    'spawns:set',
    'territories:zone',
    'territories:territory',
    'territories:change',
    'territories:nominal',
    'effects:area',
    'effects:change',
  ];

  it('opens a snapshot holding every element kind of the layers', () => {
    const elements: Element[] = [
      { id: 'project', kind: 'core:project', parent: '', after: '', hidden: false, locked: false, fields: new Map(), comp: new Map() },
    ];
    let after = '';
    ALL.forEach((kind, i) => {
      const id = `${P}-${i + 1}`;
      elements.push({ id, kind, parent: 'project', after, hidden: false, locked: false, fields: new Map([['x', '1']]), comp: new Map() });
      after = id;
    });
    const text = writeState({ kinds: new Map([['core:project', 1], ...ALL.map((k) => [k, 1] as [string, number])]), elements });
    const scene = new Scene(new IdAllocator('m1x0c7r2ab'));
    scene.open(text);
    expect(scene.children('project')).toHaveLength(9);
    expect(scene.stateText()).toBe(text);
    expect(readStateText(text).elements).toHaveLength(10);
  });

  it('applies operations of the three layers and rejects a layer element below a group', () => {
    const scene = new Scene(new IdAllocator('m1x0c7r2ab'));
    scene.open(
      writeState({
        kinds: new Map([['core:project', 1]]),
        elements: [
          { id: 'project', kind: 'core:project', parent: '', after: '', hidden: false, locked: false, fields: new Map(), comp: new Map() },
        ],
      }),
    );
    const create = (opId: string, type: string, id: string, kind: string, parent = 'project'): Operation => ({
      id: opId,
      type,
      tv: 1,
      author: 'a1a1a1a1a1a1a1a1',
      authorName: 'Anna',
      origin: 'remote',
      changes: [
        {
          k: 'create',
          el: {
            id,
            kind,
            parent,
            after: scene.lastChild(parent),
            hidden: false,
            locked: false,
            fields: new Map([['event', 'X']]),
            comp: new Map(),
          },
        },
      ],
    });
    expect(scene.apply(create('a-1', 'spawns:edit', 'a-2', 'spawns:point'))).toEqual({ result: 'applied' });
    expect(scene.apply(create('a-3', 'effects:edit', 'a-4', 'effects:area'))).toEqual({ result: 'applied' });
    expect(scene.apply(create('a-5', 'territories:edit', 'a-6', 'territories:nominal'))).toEqual({ result: 'applied' });
    expect(scene.apply(create('a-7', 'spawns:edit', 'a-8', 'spawns:event', 'a-2'))).toMatchObject({
      result: 'precondition',
      failure: 'invalid',
    });
    expect(scene.apply({ ...create('a-9', 'spawns:edit', 'a-10', 'spawns:set'), tv: 2 })).toEqual({
      result: 'unknown_type',
      plugin: 'spawns',
      version: 2,
    });
  });
});

describe('opening a project with layers from its files', () => {
  it('restores the layers, carries the rest over and takes the project extensions, in the order dzStudio does', () => {
    const { scene, followUps, layerElements, op } = open(project());
    expect(op.id).toBe(`${P}-3`);
    expect(followUps.map((o) => `${o.type} ${o.id} ${o.origin}`)).toEqual([
      `effects:edit ${P}-5 system`,
      `spawns:edit ${P}-9 system`,
      `territories:edit ${P}-12 system`,
      `projects:edit ${P}-13 system`,
      `projects:edit ${P}-14 system`,
      `projects:edit ${P}-15 system`,
    ]);
    expect(layerElements).toBe(12);
    const top = scene.children('project').map((id) => `${scene.get(id)!.kind} ${id}`);
    expect(top).toEqual([
      `core:group ${P}-1`,
      'effects:area old1-8',
      `effects:change ${P}-4`,
      'spawns:event old1-5',
      'spawns:point old1-6',
      'spawns:point old1-7',
      `spawns:point ${P}-6`,
      `spawns:point ${P}-7`,
      `spawns:set ${P}-8`,
      'territories:territory old1-9',
      'territories:zone old1-10',
      `territories:nominal ${P}-10`,
      `territories:change ${P}-11`,
    ]);
    expect(fields(scene.get('old1-8'))).toEqual({ bid: 'fx-old1-8', name: 'DzsGas1', preset: 'gas', r: '75', x: '300', z: '400' });
    expect(fields(scene.get(`${P}-4`))).toEqual({ area: 'Ship-SW', br: '100', bx: '', bz: '', r: '150', x: '', z: '' });
    expect(fields(scene.get('old1-5'))).toEqual({
      bid: 'sp-old1-5',
      class: 'OffroadHatchback',
      ext: '{"https://example.org/specs/notes/1.json":{"note":"from dzbot"}}',
      name: 'VehicleDzsOffroadHatchback',
      nominal: '1',
    });
    expect(fields(scene.get('old1-6'))).toEqual({
      a: '45.000000',
      bid: 'sp-old1-6',
      event: 'VehicleDzsOffroadHatchback',
      origin: 'own',
      x: '100.000000',
      z: '200.000000',
    });
    expect(fields(scene.get('old1-7'))).toMatchObject({ event: 'VehicleCivilianSedan', origin: 'own', a: '0' });
    expect(fields(scene.get(`${P}-6`))).toEqual({
      a: '90',
      ba: '90',
      bx: '10',
      bz: '20',
      event: 'VehicleCivilianSedan',
      origin: 'base',
      x: '11',
      z: '21',
    });
    expect(fields(scene.get(`${P}-7`))).toEqual({
      bx: '30',
      bz: '40',
      event: 'VehicleCivilianSedan',
      gone: '1',
      origin: 'base',
      x: '30',
      z: '40',
    });
    expect(fields(scene.get(`${P}-8`))).toEqual({ event: 'VehicleCivilianSedan', field: 'nominal', from: '8', to: '12' });
    expect(fields(scene.get('old1-10'))).toEqual({
      bid: 'tz-old1-10',
      dmax: '0',
      dmin: '0',
      name: 'Graze',
      r: '150',
      smax: '0',
      smin: '0',
      territory: 'old1-9',
      x: '500',
      z: '600',
    });
    expect(fields(scene.get(`${P}-10`))).toEqual({ event: 'AnimalWolf', from: '4', to: '6' });
    expect(fields(scene.get(`${P}-11`))).toEqual({
      br: '50',
      bx: '1000',
      bz: '2000',
      file: 'env/zombie_territories.xml',
      name: 'InfectedCity',
      r: '80',
    });

    const root = scene.get('project')!;
    expect(root.fields.get('ext:list')).toBe(`{"${RULES}":{"data":null},"${OTHER}":{"required":true,"data":null}}`);
    expect(root.fields.get(`ext:project:${RULES}`)).toBe('{"settings":[{"name":"MaxCars","value":3}]}');
    expect(root.fields.get(`ext:project:${OTHER}`)).toBe('{"k":1}');
    const entries = JSON.parse(root.comp.get('projects:plugins')!.d) as string[][];
    expect(entries.map((e) => e[0])).toEqual(['territories', 'spawns', 'effects', 'kept']);

    const kept = keptOf(scene)!;
    expect((kept.m.get('blocks') as { a: JV[] }).a.map((b) => getStr(b, 'id'))).toEqual(['fx-custom', 'glob-1']);
    expect((kept.m.get('changes') as { a: JV[] }).a.map(changeRef)).toEqual(['gameplay {} GeneralData.disableBaseDamage']);
    expect(getStr(kept, 'slug')).toBe('my-base');
  });

  it('builds back exactly the blocks and changes each layer took (what a save writes)', () => {
    const { scene } = open(project());
    const entries = JSON.parse(scene.get('project')!.comp.get('projects:plugins')!.d) as string[][];
    const part = (name: string): JV => jv(entries.find((e) => e[0] === name)![2]!);
    const list = (v: JV | undefined): JV[] => (v?.t === 'arr' ? v.a : []);
    const models: [string, LayerModel][] = [
      ['spawns', spawnsModel],
      ['effects', effectsModel],
      ['territories', territoriesModel],
    ];
    for (const [name, model] of models) {
      const built = model.build(new SceneSrc(scene))!;
      const taken = part(name);
      const get = (v: JV, k: string): JV | undefined => (v.t === 'obj' ? v.m.get(k) : undefined);
      expect(same(list(get(built, 'blocks')), list(get(taken, 'blocks'))), name).toBe(true);
      expect(same(list(get(built, 'changes')), list(get(taken, 'changes'))), name).toBe(true);
    }
    // the file's own block ids stay
    const built = spawnsModel.build(new SceneSrc(scene))!;
    expect(list(built.m.get('blocks')).map((b) => getStr(b, 'id'))).toEqual(['sp-old1-5', 'sp-old1-5-c', 'sp-old1-6', 'sp-old1-7']);
  });

  it('a new element id of a restored block is used when the block id is taken already', () => {
    const blocks = [...BLOCKS];
    blocks.push('{"id": "fx-old1-5", "kind": "effectArea", "parent": null, "data": ' + GAS().replace('DzsGas1', 'DzsGas2') + '}');
    const { scene } = open(project({ blocks, changes: [], extensions: '' }));
    // effects restore first: old1-5 is the area's; the event of block sp-old1-5 gets a new id and keeps its block id
    expect(scene.get('old1-5')!.kind).toBe('effects:area');
    const event = scene
      .children('project')
      .map((id) => scene.get(id)!)
      .find((e) => e.kind === 'spawns:event')!;
    expect(event.id).toMatch(new RegExp(`^${P}-\\d+$`));
    expect(event.fields.get('bid')).toBe('sp-old1-5');
  });

  it('counts the load in parts of 100 changes, as dzStudio applies it', () => {
    const many = Array.from({ length: 150 }, () => FLAG).join(', ');
    const blocks = [
      `{"id": "g-objects", "kind": "spawnerGroup", "parent": null, "data": {"name": "Objects", "objects": [${many}]}}`,
      BLOCKS[7]!,
    ];
    const { op, followUps } = open(project({ blocks, changes: [], extensions: '' }));
    expect(op.changes).toHaveLength(152);
    expect(op.id).toBe(`${P}-152`);
    // the second part of the load takes -153, the restored territory keeps its own id
    expect(followUps[0]!.id).toBe(`${P}-154`);
  });

  it('refuses extensions dzStudio hands to its model only after indexing the project', () => {
    const refused = (text: string): string => {
      try {
        open(text);
      } catch (e) {
        if (e instanceof LoadRefused) return e.message;
        throw e;
      }
      throw new Error('not refused');
    };
    const onGroup = BLOCKS.map((b, i) =>
      i === 0 ? b.replace('"parent": null, "data"', '"parent": null, "extensions": {"https://x.org/1.json": {}}, "data"') : b,
    );
    expect(refused(project({ blocks: onGroup }))).toContain('object groups');
    const onObject = BLOCKS.map((b, i) =>
      i === 0
        ? b.replace('"customString": "Flag_DayZ"}', '"customString": "Flag_DayZ", "extensions": {"https://x.org/1.json": {"a": 1}}}')
        : b,
    );
    expect(refused(project({ blocks: onObject }))).toContain('objects');
    const onKept = CHANGES.map((c, i) =>
      i === 6 ? c.replace('"to": true}', '"to": true, "extensions": {"https://x.org/1.json": {"a": 1}}}') : c,
    );
    expect(refused(project({ changes: onKept }))).toContain('carried-over');
    // an empty extensions object is none
    const empty = BLOCKS.map((b, i) => (i === 0 ? b.replace('"parent": null, "data"', '"parent": null, "extensions": {}, "data"') : b));
    expect(open(project({ blocks: empty })).groups).toBe(1);
  });

  it('gives a change taken by a layer its extensions on the element that makes it', () => {
    const changes = CHANGES.map((c, i) =>
      i === 2 ? c.replace('"to": 12}', '"to": 12, "extensions": {"https://x.org/1.json": {"why": "more cars"}}}') : c,
    );
    const { scene } = open(project({ changes }));
    expect(scene.get(`${P}-8`)!.fields.get('ext:nominal')).toBe('{"https://x.org/1.json":{"why":"more cars"}}');
  });

  it('shows the layers, the carried-over entries and the extensions to the agent', () => {
    const { scene } = open(project());
    const rows = layerRows(scene);
    expect(rows.find((r) => r.id === 'old1-6')).toMatchObject({
      layer: 'spawns',
      kind: 'point',
      name: 'VehicleDzsOffroadHatchback',
      position: [100, 200],
      angle: 45,
    });
    expect(rows.find((r) => r.id === `${P}-7`)).toMatchObject({ origin: 'base', removed: true, basePosition: [30, 40] });
    expect(rows.find((r) => r.id === 'old1-8')).toMatchObject({
      layer: 'effects',
      kind: 'area',
      preset: 'gas',
      position: [300, 400],
      radius: 75,
    });
    expect(rows.find((r) => r.id === 'old1-10')).toMatchObject({
      layer: 'territories',
      kind: 'zone',
      territory: 'old1-9',
      file: 'env/wolf_territories.xml',
    });
    expect(rows.find((r) => r.id === 'old1-5')!.extensions).toEqual({
      ext: { 'https://example.org/specs/notes/1.json': { note: 'from dzbot' } },
    });
    const kept = rows.filter((r) => r.kept);
    expect(kept.map((r) => `${r.layer} ${r.kind}`)).toEqual(['effects effectArea', 'other global', 'other gameplay change']);
    expect(kept[0]).toMatchObject({ name: 'DzsGas1', position: [300, 400], radius: 75 });
    expect(layerRows(scene, { near: { x: 300, z: 470, radius: 0 } }).map((r) => r.id)).toEqual(['old1-8', 'kept:block:0']);
    expect(layerRows(scene, { layer: 'territories', kept: false }).map((r) => r.kind)).toEqual([
      'territory',
      'zone',
      'count',
      'zone_change',
    ]);
    expect(layerRows(scene, { name: 'vehicleciviliansedan' }).map((r) => r.id)).toEqual(['old1-7', `${P}-6`, `${P}-7`, `${P}-8`]);
    expect(projectExtensions(scene)).toEqual([
      { url: RULES, data: { settings: [{ name: 'MaxCars', value: 3 }] } },
      { url: OTHER, required: true, data: { k: 1 } },
    ]);
  });

  it('opens a file of object groups only exactly as before', () => {
    const { followUps, scene } = open(project({ blocks: [BLOCKS[0]!], changes: [], extensions: '' }));
    expect(followUps).toEqual([]);
    expect(writeOperation).toBeDefined();
    const entries = JSON.parse(scene.get('project')!.comp.get('projects:plugins')!.d) as string[][];
    expect(entries.map((e) => e[0])).toEqual(['kept']);
  });
});

describe('numbers as the layers write them', () => {
  it('formats like PHP after json_decode', () => {
    expect(['5.0', '1.50', '1e2', '0.00001', '1e17', '1e18', '-0.5', '100.000000', '007', ''].map(phpNumber)).toEqual([
      '5',
      '1.5',
      '100',
      '1.0e-5',
      '1.0e+17',
      '1.0e+18',
      '-0.5',
      '100',
      '7',
      '0',
    ]);
  });

  it("writes floats through the game's six significant digits", () => {
    expect(gameFloat(1234.5678)).toBe('1234.57');
    expect(gameFloat(0.1)).toBe('0.1');
    expect(gameFloat(15360)).toBe('15360');
    expect(gameFloat(1000000)).toBe('1e+06');
    expect(gameFloat(0.00001)).toBe('1e-05');
    expect(gameFloat(-270.5)).toBe('-270.5');
    expect(fixed6(gameFloat(1234.5678))).toBe('1234.570000');
    expect(fixed6('1e-05')).toBe('0.000010');
    expect(canon6(gameFloat(75))).toBe('75');
    expect(canon6('2.0000005')).toBe('2.000001');
    expect(fixed6('-0.0000001')).toBe('0.000000');
  });
});
