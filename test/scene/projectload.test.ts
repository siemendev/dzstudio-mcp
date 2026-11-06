import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IdAllocator, readStateText, Scene, writeFloat32, writeOperation } from '../../src/scene/index.js';
import { loadProject, LoadRefused, neededForLoad } from '../../src/scene/projectload.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const PATRICK = { author: 'p7x2m9q4c1v8b5n3', authorName: 'Patrick' };
const KNOWN = new Set(['staticflagpole', 'woodencrate', 'barrel_blue']);
const classKnown = (n: string): boolean => KNOWN.has(n.toLowerCase());

// The files as dzStudio writes them (the project part of the project file, its group entries and the Object Spawner
// file), so that the load reads exactly what a save left in the store.

const I = (d: number): string => '    '.repeat(d);
const q = (s: string): string => JSON.stringify(s);

interface EntryObject {
  index: number;
  name: string;
  pos: [number, number, number];
  hidden: boolean;
  locked: boolean;
}

function groupEntry(file: string, name: string, color: string, count: number, objects: EntryObject[] = [], hidden = false): string {
  let s = '{\n';
  s += `${I(4)}"file": ${q(file)},\n${I(4)}"name": ${q(name)},\n${I(4)}"color": ${q(color)},\n`;
  s += `${I(4)}"hidden": ${hidden},\n${I(4)}"locked": false,\n${I(4)}"objectCount": ${count},\n`;
  if (!objects.length) s += `${I(4)}"objects": [],\n`;
  else {
    s += `${I(4)}"objects": [\n`;
    s += objects
      .map(
        (o) =>
          `${I(5)}{\n${I(6)}"index": ${o.index},\n${I(6)}"name": ${q(o.name)},\n` +
          `${I(6)}"pos": [${o.pos.map(writeFloat32).join(', ')}],\n${I(6)}"hidden": ${o.hidden},\n${I(6)}"locked": ${o.locked}\n${I(5)}}`,
      )
      .join(',\n');
    s += `\n${I(4)}],\n`;
  }
  return s + `${I(4)}"plugins": {}\n${I(3)}}`;
}

function manifest(groups: string[], plugins = '{}'): string {
  let s = '{\n';
  s += groups.length ? `${I(2)}"groups": [\n${groups.map((g) => I(3) + g).join(',\n')}\n${I(2)}],\n` : `${I(2)}"groups": [],\n`;
  s += `${I(2)}"loot": {\n${I(3)}"enabled": false,\n${I(3)}"hidden": false,\n${I(3)}"locked": false,\n`;
  s += `${I(3)}"projectId": null,\n${I(3)}"writtenTypes": []\n${I(2)}},\n`;
  s += `${I(2)}"plugins": ${plugins}\n${I(1)}}`;
  return `{\n    "format": "dzstudio-project",\n    "version": 1,\n    "project": ${s}\n}\n`;
}

interface SpawnerObject {
  name: string;
  pos: [number, number, number];
  ypr: [number, number, number];
  scale?: number;
  persist?: boolean;
  custom?: string;
}

function spawner(objects: SpawnerObject[]): string {
  if (!objects.length) return '{\n    "Objects": []\n}\n';
  const entries = objects.map(
    (o) =>
      `        {\n            "name": ${q(o.name)},\n            "pos": [${o.pos.map(writeFloat32).join(', ')}],\n` +
      `            "ypr": [${o.ypr.map(writeFloat32).join(', ')}],\n            "scale": ${writeFloat32(o.scale ?? 1)},\n` +
      `            "enableCEPersistency": ${o.persist ? 1 : 0},\n            "customString": ${q(o.custom ?? '')}\n        }`,
  );
  return `{\n    "Objects": [\n${entries.join(',\n')}\n    ]\n}\n`;
}

const FLAG: SpawnerObject = { name: 'StaticFlagPole', pos: [1234.56789, 150.125, 9876.54321], ypr: [46.2, 0, 0], custom: 'Flag_DayZ' };

function load(files: Record<string, string>, opts: { classes?: boolean } = {}) {
  const ids = new IdAllocator('k3f9a0x2mq');
  const res = loadProject({ files: new Map(Object.entries(files)), ids, ...PATRICK, ...(opts.classes === false ? {} : { classKnown }) });
  const scene = new Scene(new IdAllocator('k3f9a0x2mq'));
  expect(scene.apply(res.op)).toEqual({ result: 'applied' });
  return { ...res, scene, state: scene.stateText() };
}

function comp(scene: Scene, id: string, type: string): unknown {
  return JSON.parse(scene.get(id)!.comp.get(type)!.d);
}

describe('opening a hosted project from its files', () => {
  it('G1: the project "Objekte" with the flag pole loads byte for byte as in the golden example', () => {
    const files = {
      manifest: manifest([groupEntry('objekte.json', 'Objekte', '#60A5FA', 1)]),
      'objekte.json': spawner([FLAG]),
    };
    const { op, state } = load(files);
    expect(writeOperation(op)).toBe(golden.G1);
    expect(state).toBe(golden.Z1);
  });

  it('keeps hidden and locked objects of the project file, by index and by name and place', () => {
    const crate: SpawnerObject = { name: 'WoodenCrate', pos: [10, 20, 30], ypr: [0, 0, 0] };
    const files = {
      manifest: manifest([
        groupEntry('objekte.json', 'Objekte', '#60A5FA', 2, [
          { index: 1, name: 'WoodenCrate', pos: [10, 20, 30], hidden: true, locked: false },
          { index: 7, name: 'StaticFlagPole', pos: [1234.5679, 150.125, 9876.543], hidden: false, locked: true },
        ]),
      ]),
      'objekte.json': spawner([FLAG, crate]),
    };
    const { scene, notes } = load(files);
    expect(scene.get('k3f9a0x2mq-2')).toMatchObject({ hidden: false, locked: true });
    expect(scene.get('k3f9a0x2mq-3')).toMatchObject({ hidden: true, locked: false });
    expect(notes).toEqual([]);
  });

  it('lifts a hide that no longer matches the file and says so', () => {
    const files = {
      manifest: manifest([
        groupEntry('objekte.json', 'Objekte', '#60A5FA', 1, [
          { index: 0, name: 'StaticFlagPole', pos: [1, 2, 3], hidden: true, locked: false },
        ]),
      ]),
      'objekte.json': spawner([FLAG]),
    };
    const { scene, notes } = load(files);
    expect(scene.get('k3f9a0x2mq-2')!.hidden).toBe(false);
    expect(notes.join()).toContain('no longer matched');
  });

  it('orders groups by the project file, then other group files sorted, with the next free colours', () => {
    const files = {
      manifest: manifest([groupEntry('zelt.json', '', 'bad', 0), groupEntry('weg.json', 'Weg', '#fb923c', 0)]),
      'b/Zweig.json': spawner([]),
      'a.json': spawner([]),
      'weg.json': spawner([]),
      'zelt.json': spawner([]),
      'loot.xml': '<x/>',
      'mapgroupproto.xml': '<x/>',
    };
    const { scene } = load(files);
    const groups = scene.children('project').map((id) => scene.get(id)!);
    expect(groups.map((g) => [g.fields.get('name'), g.fields.get('file'), g.fields.get('color')])).toEqual([
      ['zelt', 'zelt.json', '#60A5FA'],
      ['Weg', 'weg.json', '#FB923C'],
      ['a', 'a.json', '#2DD4BF'],
      ['Zweig', 'b/Zweig.json', '#F472B6'],
    ]);
    expect(groups.map((g) => g.after)).toEqual(['', groups[0]!.id, groups[1]!.id, groups[2]!.id]);
  });

  it('without a project file every group file becomes a group', () => {
    const { scene, notes, state } = load({ 'objekte.json': spawner([FLAG]) });
    const g = scene.get('k3f9a0x2mq-1')!;
    expect(g.fields.get('name')).toBe('objekte');
    expect(g.comp.get('projects:plugins')).toEqual({ v: 1, d: '[]' });
    expect(readStateText(state).elements).toHaveLength(3);
    expect(notes.join()).toContain('missing');
  });

  it('keeps unknown fields and plugin data as source text, and records read warnings', () => {
    const file =
      '{"Objects":[{"name":"WoodenCrate","pos":[1,2,3],"ypr":null,"scale":0,"enableCEPersistency":true,' +
      '"customString":null,"extra": {"a" : [1, 2]},"extra":"last","Ünbekannt":1e999}],"Version" : 2}';
    const files = {
      manifest: manifest([groupEntry('objekte.json', 'Objekte', '#60A5FA', 1)], '{\n            "mine": {"x": 1}\n        }'),
      'objekte.json': file,
    };
    const { scene } = load(files);
    expect(scene.get('project')!.comp.get('projects:plugins')!.d).toBe('[["mine","\\"mine\\"","{\\"x\\": 1}"]]');
    expect(scene.get('k3f9a0x2mq-1')!.comp.get('spawner:root')).toEqual({ v: 1, d: '[["\\"Version\\"","2"]]' });
    const o = scene.get('k3f9a0x2mq-2')!;
    expect(Object.fromEntries(o.fields)).toEqual({
      name: 'WoodenCrate',
      pos: '1.0 2.0 3.0',
      ypr: '0.0 0.0 0.0',
      scale: '1.0',
      persist: '1',
      customString: '',
    });
    expect(comp(scene, o.id, 'spawner:read')).toEqual({
      f: ['WoodenCrate', '1.0 2.0 3.0', '0.0 0.0 0.0', '1.0', '1', ''],
      p: '1.0 2.0 3.0',
      y: '0.0 0.0 0.0',
      ph: false,
      u: [
        ['"extra"', '"last"'],
        ['"Ünbekannt"', '1e999'],
      ],
      w: [
        'ypr: null durch den Standardwert ersetzt\nypr: null replaced by the default',
        'enableCEPersistency wird als 1 geschrieben (gelesen: true)\nenableCEPersistency is written as 1 (read: true)',
        'customString: null durch den Standardwert ersetzt\ncustomString: null replaced by the default',
      ],
    });
  });

  it('replaces a number outside float32 and marks unknown classes as placeholders', () => {
    const file = '﻿{"Objects":[{"name":"ModdedThing","pos":[1e39,0,-0],"ypr":[0,0,0]},{"name":"","pos":[0,0,0]}]}';
    const { scene } = load({ 'objekte.json': file });
    const [a, b] = scene.children('k3f9a0x2mq-1');
    expect(scene.get(a!)!.fields.get('pos')).toBe('0.0 0.0 0.0');
    expect(comp(scene, a!, 'spawner:read')).toMatchObject({
      ph: true,
      w: ['pos: 1e39 ist keine endliche float32-Zahl — ersetzt durch 0.0\npos: 1e39 is not a finite float32 number — replaced by 0.0'],
    });
    expect(comp(scene, b!, 'spawner:read')).toMatchObject({ ph: true, w: [] });
  });

  it('opens a file it cannot read as an unreadable group with its entry kept, even past a model path', () => {
    const entry = groupEntry('kaputt.json', 'Kaputt', '#60A5FA', 3);
    const files = {
      manifest: manifest([entry]),
      'kaputt.json': '{"Objects":[{"name":"x/y.p3d"}, {"name":"WoodenCrate","pos":[1,2]}], "keep": true}',
    };
    const { scene, objects, notes } = load(files);
    const g = scene.get('k3f9a0x2mq-1')!;
    expect(g.fields.get('unreadable')).toBe('1');
    expect(g.comp.get('projects:entry')).toEqual({ v: 1, d: entry });
    expect(g.comp.get('spawner:root')).toEqual({ v: 1, d: '[["\\"keep\\"","true"]]' });
    expect(objects).toBe(0);
    expect(notes.join()).toContain('not readable');
  });

  it('refuses what only the game can open', () => {
    const refused = (files: Record<string, string>, classes = true): string => {
      try {
        load(files, { classes });
      } catch (e) {
        expect(e).toBeInstanceOf(LoadRefused);
        return (e as Error).message;
      }
      throw new Error('not refused');
    };
    expect(refused({ 'a.json': spawner([{ name: 'DZ\\plants\\tree\\t_x.p3d', pos: [0, 0, 0], ypr: [0, 0, 0] }]) })).toContain('model');
    expect(refused({ manifest: manifest([]).replace('"enabled": false', '"enabled": true') })).toContain('Loot');
    expect(refused({ 'a.json': spawner([FLAG]) }, false)).toContain('class data');
    expect(refused({ manifest: '{"format":"dzstudio-project","version":2}' })).toContain('newer');
    expect(refused({ 'a.json': '{"Objects":[{"name":"A\\u0000B"}]}' })).toContain('\\u0000');
    expect(refused({ 'a.json': '{}', 'A.json': '{}' })).toContain('case');
  });

  it('opens without class data when no object names a class', () => {
    expect(load({ 'a.json': spawner([]) }, { classes: false }).groups).toBe(1);
  });

  it('downloads only the project file and the files that can become groups', () => {
    expect(
      [
        'manifest',
        'objekte.json',
        'Sub/B.JSON',
        'mapgroupproto.xml',
        'cfggameplay.json',
        'vanilla/x.json',
        '../x.json',
        'notes.txt',
      ].filter(neededForLoad),
    ).toEqual(['manifest', 'objekte.json', 'Sub/B.JSON']);
  });
});
