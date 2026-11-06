import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IdAllocator, OpBuilder, readOperation, Scene, undoOperation, writeOperation, type Operation } from '../../src/scene/index.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const g = (name: string): string => golden[name]!;
const PATRICK = { author: 'p7x2m9q4c1v8b5n3', authorName: 'Patrick' };
const OPS = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8'];

function sceneAfter(names: string[]): Scene {
  const s = new Scene(new IdAllocator('k3f9a0x2mq'));
  for (const n of names) expect(s.applyText(g(n)), n).toEqual({ result: 'applied' });
  return s;
}

describe('golden examples', () => {
  it.each(OPS)('%s reads and writes back byte for byte', (name) => {
    expect(writeOperation(readOperation(g(name)))).toBe(g(name));
  });

  it('G1 opens the project and writes Z1', () => {
    expect(sceneAfter(['G1']).stateText()).toBe(g('Z1'));
  });

  it('G1 to G8 apply one after another and write Z8', () => {
    expect(sceneAfter(OPS).stateText()).toBe(g('Z8'));
  });

  it('builds G2 to G8 itself, byte for byte', () => {
    const s = sceneAfter(['G1']);
    const step = (type: string, fn: (b: OpBuilder) => void): Operation => {
      const b = new OpBuilder(s, type, PATRICK);
      fn(b);
      const op = b.finish();
      expect(s.apply(op)).toEqual({ result: 'applied' });
      return op;
    };
    const group = 'k3f9a0x2mq-1';
    const flag = 'k3f9a0x2mq-2';
    let crate = '';
    const g2 = step('placement:edit', (b) => {
      crate = b.createObject({ group, name: 'WoodenCrate', pos: [1240.5, 150, 9880.25], ypr: [-90, 0, 0] });
    });
    expect(writeOperation(g2)).toBe(g('G2'));
    const g3 = step('properties:edit', (b) => b.setField(crate, 'pos', '1241.75 150.5 9879.1'));
    expect(writeOperation(g3)).toBe(g('G3'));
    expect(writeOperation(step('projects:edit', (b) => b.setFlag(flag, 'hidden', true)))).toBe(g('G4'));
    expect(writeOperation(step('loot:edit', (b) => b.setComp(flag, 'loot:setting', { v: 1, d: 'own' })))).toBe(g('G5'));
    const g6 = undoOperation([g3], s.ids.next(), PATRICK);
    expect(s.apply(g6)).toEqual({ result: 'applied' });
    expect(writeOperation(g6)).toBe(g('G6'));
    expect(writeOperation(step('projects:edit', (b) => b.move(crate, group, '')))).toBe(g('G7'));
    expect(writeOperation(step('placement:edit', (b) => b.deleteTree(flag)))).toBe(g('G8'));
    expect(s.stateText()).toBe(g('Z8'));
  });

  it('R1: G6 again is a duplicate and changes nothing', () => {
    const s = sceneAfter(OPS);
    expect(s.applyText(g('G6'))).toEqual({ result: 'duplicate' });
    expect(s.stateText()).toBe(g('Z8'));
  });

  it('R2: a failing second change rolls back the first; the id stays unknown', () => {
    const s = sceneAfter(OPS);
    expect(s.applyText(g('R2'))).toEqual({ result: 'precondition', failure: 'changed', index: 1, message: 'Object was changed' });
    expect(s.stateText()).toBe(g('Z8'));
    expect(s.isKnownOperation('k3f9a0x2mq-12')).toBe(false);
    expect(s.applyText(g('R2')).result).toBe('precondition');
  });

  it('R3: unknown operation type', () => {
    const s = sceneAfter(OPS);
    expect(s.applyText(g('R3'))).toEqual({ result: 'unknown_type', plugin: 'agent', version: 1 });
    expect(s.stateText()).toBe(g('Z8'));
  });

  it('R4: known type in a newer version', () => {
    const s = sceneAfter(OPS);
    expect(s.applyText(g('R4'))).toEqual({ result: 'unknown_type', plugin: 'placement', version: 2 });
    expect(s.stateText()).toBe(g('Z8'));
  });

  it('R5: G1 with textform 2 is invalid', () => {
    const s = new Scene();
    const r = s.applyText(g('G1').replace('{"textform":1,', '{"textform":2,'));
    expect(r.result).toBe('invalid');
    expect(s.size).toBe(0);
  });

  it('A1: create after a missing element lands at the end of the group', () => {
    const s = sceneAfter(OPS);
    expect(s.applyText(g('A1'))).toEqual({ result: 'applied' });
    expect(s.stateText()).toBe(g('ZA1'));
  });

  it('round trip: open Z1, Z8 and the A1 state and write the same bytes', () => {
    for (const name of ['Z1', 'Z8', 'ZA1']) {
      const s = new Scene();
      s.open(g(name));
      expect(s.stateText()).toBe(g(name));
    }
  });

  it('a scene opened from Z8 accepts the rest of the log like one that applied it', () => {
    const s = new Scene();
    s.open(g('Z8'));
    expect(s.applyText(g('A1'))).toEqual({ result: 'applied' });
    expect(s.stateText()).toBe(g('ZA1'));
  });
});
