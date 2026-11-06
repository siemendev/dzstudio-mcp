import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IdAllocator, inverseChange, OpBuilder, readOperation, Scene, writeChange, writeOperation, type Change, type Operation } from '../../src/scene/index.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const BY = { author: 'z9y8x7w6v5u4t3s2', authorName: 'Tester' };
const GROUP = 'k3f9a0x2mq-1';
const FLAG = 'k3f9a0x2mq-2';

function z1(): Scene {
  const s = new Scene(new IdAllocator('q8w7e6r5t4'));
  s.open(golden.Z1!);
  return s;
}

function op(changes: Change[], id = 'q8w7e6r5t4-900', type = 'placement:edit'): Operation {
  return { id, type, tv: 1, author: BY.author, authorName: BY.authorName, origin: 'local', changes };
}

function objectEl(id: string, after = '', parent = GROUP) {
  return {
    id,
    kind: 'core:object',
    parent,
    after,
    hidden: false,
    locked: false,
    fields: new Map([['name', 'Barrel_Blue']]),
    comp: new Map(),
  };
}

describe('preconditions', () => {
  it('create: exists, missing parent, wrong parent type, a second project', () => {
    const s = z1();
    const before = s.stateText();
    expect(s.apply(op([{ k: 'create', el: objectEl(FLAG) }]))).toMatchObject({ result: 'precondition', failure: 'exists' });
    expect(s.apply(op([{ k: 'create', el: objectEl('', '') }]))).toMatchObject({ result: 'precondition', failure: 'exists' });
    expect(s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-1', '', 'nope') }]))).toMatchObject({ failure: 'missing', message: 'Object was deleted' });
    expect(s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-1', '', 'project') }]))).toMatchObject({ failure: 'invalid', message: 'Change no longer fits' });
    expect(s.apply(op([{ k: 'create', el: { ...objectEl('project'), kind: 'core:project', parent: '' } }]))).toMatchObject({ failure: 'exists' });
    expect(s.stateText()).toBe(before);
  });

  it('create with parent "" only for the project on an empty state', () => {
    const s = new Scene();
    expect(s.apply(op([{ k: 'create', el: { ...objectEl('x'), kind: 'core:project', parent: '' } }]))).toMatchObject({ failure: 'invalid' });
    expect(s.apply(op([{ k: 'create', el: { ...objectEl('project'), kind: 'core:group', parent: '' } }]))).toMatchObject({ failure: 'invalid' });
    expect(s.apply(op([{ k: 'create', el: { ...objectEl('project'), kind: 'core:project', parent: '' } }]))).toEqual({ result: 'applied' });
  });

  it('a create into a deleted group reports "Group was deleted"', () => {
    const s = z1();
    const b = new OpBuilder(s, 'projects:edit', BY);
    b.deleteTree(GROUP);
    expect(s.apply(b.finish())).toEqual({ result: 'applied' });
    expect(s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-50') }]))).toMatchObject({ failure: 'missing', message: 'Group was deleted' });
  });

  it('delete: missing, has children, any difference is changed', () => {
    const s = z1();
    const flag = s.get(FLAG)!;
    expect(s.apply(op([{ k: 'delete', el: { ...flag, id: 'nope' } }]))).toMatchObject({ failure: 'missing' });
    expect(s.apply(op([{ k: 'delete', el: s.get(GROUP)! }]))).toMatchObject({ failure: 'changed' });
    const variants = [
      { ...flag, after: 'x' },
      { ...flag, hidden: true },
      { ...flag, locked: true },
      { ...flag, kind: 'core:group' },
      { ...flag, fields: new Map([...flag.fields, ['extra', '']]) },
      { ...flag, comp: new Map() },
      { ...flag, comp: new Map([...flag.comp].map(([k, c]) => [k, { v: 2, d: c.d }])) },
    ];
    for (const el of variants) expect(s.apply(op([{ k: 'delete', el }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'delete', el: flag }]))).toEqual({ result: 'applied' });
  });

  it('field: missing and present distinguish absent from empty', () => {
    const s = z1();
    expect(s.apply(op([{ k: 'field', id: FLAG, key: 'nope', old: '', new: 'x' }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'field', id: FLAG, key: 'customString', new: 'x' }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'field', id: 'nope', key: 'customString', old: 'Flag_DayZ', new: 'x' }]))).toMatchObject({ failure: 'missing' });
    expect(s.apply(op([{ k: 'field', id: FLAG, key: 'nope', new: '' }], 'q8w7e6r5t4-901'))).toEqual({ result: 'applied' });
    expect(s.get(FLAG)!.fields.get('nope')).toBe('');
    expect(s.apply(op([{ k: 'field', id: FLAG, key: 'nope', old: '' }], 'q8w7e6r5t4-902'))).toEqual({ result: 'applied' });
    expect(s.get(FLAG)!.fields.has('nope')).toBe(false);
  });

  it('hidden and locked: a change that changes nothing is applied', () => {
    const s = z1();
    expect(s.apply(op([{ k: 'locked', id: FLAG, old: true, new: false }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'hidden', id: FLAG, old: false, new: false }]))).toEqual({ result: 'applied' });
  });

  it('comp: version and content must match exactly', () => {
    const s = z1();
    const d = s.get(FLAG)!.comp.get('spawner:read')!.d;
    expect(s.apply(op([{ k: 'comp', id: FLAG, type: 'spawner:read', old: { v: 2, d } }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'comp', id: FLAG, type: 'spawner:read', new: { v: 1, d } }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'comp', id: FLAG, type: 'spawner:read', old: { v: 1, d } }]))).toEqual({ result: 'applied' });
    expect(s.get(FLAG)!.comp.has('spawner:read')).toBe(false);
  });

  it('move: changed, missing target, into itself or a wrong parent type is invalid', () => {
    const s = z1();
    const b = new OpBuilder(s, 'projects:edit', BY);
    const g2 = b.createGroup({ name: 'Two', color: '#FF0000', file: 'two.json' });
    expect(s.apply(b.finish())).toEqual({ result: 'applied' });
    expect(s.apply(op([{ k: 'move', id: FLAG, from: g2, fromAfter: '', to: g2, toAfter: '' }]))).toMatchObject({ failure: 'changed' });
    expect(s.apply(op([{ k: 'move', id: FLAG, from: GROUP, fromAfter: '', to: 'nope', toAfter: '' }]))).toMatchObject({ failure: 'missing' });
    expect(s.apply(op([{ k: 'move', id: FLAG, from: GROUP, fromAfter: '', to: 'project', toAfter: '' }]))).toMatchObject({ failure: 'invalid' });
    expect(s.apply(op([{ k: 'move', id: GROUP, from: 'project', fromAfter: '', to: GROUP, toAfter: '' }]))).toMatchObject({ failure: 'invalid' });
    expect(s.apply(op([{ k: 'move', id: FLAG, from: GROUP, fromAfter: '', to: g2, toAfter: '' }]))).toEqual({ result: 'applied' });
    expect(s.get(FLAG)!.parent).toBe(g2);
    expect(s.childCount(GROUP)).toBe(0);
  });
});

describe('position among siblings', () => {
  function threeObjects(): { s: Scene; ids: string[] } {
    const s = z1();
    const b = new OpBuilder(s, 'placement:edit', BY);
    const ids = [FLAG, ...[1, 2, 3].map((i) => b.createObject({ group: GROUP, name: `O${i}`, pos: [i, 0, i] }))];
    expect(s.apply(b.finish())).toEqual({ result: 'applied' });
    return { s, ids };
  }

  it('creates after, first, and at the end for a missing sibling', () => {
    const { s, ids } = threeObjects();
    expect(s.children(GROUP)).toEqual(ids);
    s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-100', ids[1]) }], 'q8w7e6r5t4-200'));
    s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-101', '') }], 'q8w7e6r5t4-201'));
    s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-102', 'gone') }], 'q8w7e6r5t4-202'));
    s.apply(op([{ k: 'create', el: objectEl('q8w7e6r5t4-103', 'project') }], 'q8w7e6r5t4-203'));
    expect(s.children(GROUP)).toEqual(['q8w7e6r5t4-101', ids[0], ids[1], 'q8w7e6r5t4-100', ids[2], ids[3], 'q8w7e6r5t4-102', 'q8w7e6r5t4-103']);
  });

  it('move with toAfter = own id goes to the end; the inverse puts it back', () => {
    const { s, ids } = threeObjects();
    const m: Change = { k: 'move', id: ids[1]!, from: GROUP, fromAfter: ids[0]!, to: GROUP, toAfter: ids[1]! };
    expect(s.apply(op([m]))).toEqual({ result: 'applied' });
    expect(s.children(GROUP)).toEqual([ids[0], ids[2], ids[3], ids[1]]);
    const back: Change = { k: 'move', id: ids[1]!, from: GROUP, fromAfter: ids[3]!, to: GROUP, toAfter: ids[0]! };
    expect(s.apply(op([back], 'q8w7e6r5t4-901'))).toEqual({ result: 'applied' });
    expect(s.children(GROUP)).toEqual(ids);
  });

  it('the state text writes after = the sibling before', () => {
    const { s, ids } = threeObjects();
    const els = [...s.walk()].filter((e) => e.parent === GROUP);
    expect(els.map((e) => e.after)).toEqual(['', ids[0], ids[1], ids[2]]);
  });
});

describe('rollback', () => {
  it('takes back every kind of change exactly when a later change fails', () => {
    const s = z1();
    const b = new OpBuilder(s, 'placement:edit', BY);
    const a = b.createObject({ group: GROUP, name: 'A', pos: [1, 2, 3] });
    const c = b.createObject({ group: GROUP, name: 'C', pos: [1, 2, 3] });
    expect(s.apply(b.finish())).toEqual({ result: 'applied' });
    const before = s.stateText();
    const flag = s.get(FLAG)!;
    const changes: Change[] = [
      { k: 'create', el: objectEl('q8w7e6r5t4-300', FLAG) },
      { k: 'field', id: a, key: 'name', old: 'A', new: 'AA' },
      { k: 'hidden', id: a, old: false, new: true },
      { k: 'locked', id: c, old: false, new: true },
      { k: 'comp', id: a, type: 'loot:setting', new: { v: 1, d: 'own' } },
      { k: 'delete', el: { ...flag } },
      { k: 'move', id: c, from: GROUP, fromAfter: a, to: GROUP, toAfter: '' },
      { k: 'field', id: a, key: 'name', old: 'wrong', new: 'x' },
    ];
    expect(s.apply(op(changes))).toMatchObject({ result: 'precondition', failure: 'changed', index: 7 });
    expect(s.stateText()).toBe(before);
    expect(s.isKnownOperation('q8w7e6r5t4-900')).toBe(false);
    expect(s.has('q8w7e6r5t4-300')).toBe(false);
  });

  it('every inverse undoes its change', () => {
    const s = z1();
    const before = s.stateText();
    const b = new OpBuilder(s, 'placement:edit', BY);
    const a = b.createObject({ group: GROUP, name: 'A', pos: [1, 2, 3] });
    b.setField(a, 'name', 'B');
    b.setFlag(FLAG, 'locked', true);
    b.setComp(FLAG, 'loot:setting', { v: 1, d: 'base' });
    b.move(a, GROUP, '');
    b.deleteTree(FLAG);
    const forward = b.finish();
    expect(s.apply(forward)).toEqual({ result: 'applied' });
    const inv = op([...forward.changes].reverse().map(inverseChange), 'q8w7e6r5t4-901', 'core:undo');
    expect(s.apply(inv)).toEqual({ result: 'applied' });
    expect(s.stateText()).toBe(before);
  });

  it('tentative applies and takes back', () => {
    const s = z1();
    const before = s.stateText();
    const b = new OpBuilder(s, 'placement:edit', BY);
    const a = b.createObject({ group: GROUP, name: 'A', pos: [1, 2, 3] });
    const o = b.finish();
    const seen = s.tentative([o], (r) => {
      expect(r).toEqual([{ result: 'applied' }]);
      return s.has(a);
    });
    expect(seen).toBe(true);
    expect(s.stateText()).toBe(before);
    expect(s.isKnownOperation(o.id)).toBe(false);
  });
});

describe('stages', () => {
  const base = JSON.parse(JSON.stringify(golden.G4!)) as string;
  it.each([
    ['not JSON', '{'],
    ['not an object', '[1]'],
    ['no textform', '{"op":{}}'],
    ['op missing', '{"textform":1}'],
    ['invalid origin', base.replace('"origin":"local"', '"origin":"elsewhere"')],
    ['origin missing', base.replace('"origin":"local",', '')],
    ['changes not a list', base.replace(/"changes":\[.*\]\}\}$/, '"changes":{}}}')],
    ['unknown change kind', base.replace('"k":"hidden"', '"k":"rename"')],
    ['change not an object', base.replace(/"changes":\[.*\]\}\}$/, '"changes":[1]}}')],
    ['element without kind', golden.G2!.replace('"kind":"core:object",', '')],
    ['field value not a string', golden.G2!.replace('"name":"WoodenCrate"', '"name":5')],
    ['companion data without v', golden.G1!.replace('"projects:plugins":{"v":1,"d":"[]"}', '"projects:plugins":{"d":"[]"}')],
  ])('%s is invalid', (_name, text) => {
    expect(new Scene().applyText(text).result).toBe('invalid');
  });

  it('duplicate comes before unknown type', () => {
    const s = z1();
    const o = op([], 'q8w7e6r5t4-1');
    expect(s.apply(o)).toEqual({ result: 'applied' });
    expect(s.apply({ ...o, type: 'agent:edit' })).toEqual({ result: 'duplicate' });
  });

  it('a create of an unknown element type is an unknown type of its plugin', () => {
    const s = z1();
    expect(s.apply(op([{ k: 'create', el: { ...objectEl('q8w7e6r5t4-5'), kind: 'roads:segment' } }]))).toEqual({ result: 'unknown_type', plugin: 'roads', version: 1 });
  });

  it('an operation without changes is applied and its id is known', () => {
    const s = z1();
    expect(s.apply(op([]))).toEqual({ result: 'applied' });
    expect(s.isKnownOperation('q8w7e6r5t4-900')).toBe(true);
  });

  it('lenient values: missing tv is 1, non-boolean hidden is false, non-string old is present and empty', () => {
    const o = readOperation(
      '{"textform":1,"op":{"id":"a","type":"x:y","origin":"system","changes":[{"id":"e","k":"hidden","old":1},{"id":"e","k":"field","key":"k","old":5}]}}',
    );
    expect(o.tv).toBe(1);
    expect(o.changes[0]).toEqual({ k: 'hidden', id: 'e', old: false, new: false });
    expect(o.changes[1]).toEqual({ k: 'field', id: 'e', key: 'k', old: '' });
    expect(writeChange(o.changes[1]!)).toBe('{"id":"e","k":"field","key":"k","old":""}');
    expect(writeOperation(o)).toBe(
      '{"textform":1,"op":{"id":"a","type":"x:y","tv":1,"author":"","authorName":"","origin":"system","changes":[{"id":"e","k":"hidden","old":false,"new":false},{"id":"e","k":"field","key":"k","old":""}]}}',
    );
  });
});

describe('opening a state', () => {
  it('fails on a newer text form, unknown types, and a parent after its child', () => {
    expect(() => new Scene().open(golden.Z1!.replace('"textform":1', '"textform":2'))).toThrow(/newer/);
    expect(() => new Scene().open(golden.Z1!.replace('"core:group":1', '"core:group":1,"roads:segment":1'))).toThrow(/roads:segment/);
    const parsed = golden.Z1!;
    const start = parsed.indexOf('{"id":"k3f9a0x2mq-1"');
    const mid = parsed.indexOf(',{"id":"k3f9a0x2mq-2"');
    const end = parsed.lastIndexOf(']}}');
    const swapped = parsed.slice(0, start) + parsed.slice(mid + 1, end) + ',' + parsed.slice(start, mid) + parsed.slice(end);
    expect(() => new Scene().open(swapped)).toThrow(/does not open/);
  });

  it('an empty state', () => {
    const s = new Scene();
    s.open('{"textform":1,"state":{"kinds":{},"elements":[]}}');
    expect(s.stateText()).toBe('{"textform":1,"state":{"kinds":{},"elements":[]}}');
  });

  it('ids from the state are never handed out again', () => {
    const s = new Scene(new IdAllocator('k3f9a0x2mq'));
    s.open(golden.Z8!);
    expect(s.ids.next()).toBe('k3f9a0x2mq-5');
  });
});
