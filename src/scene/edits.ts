import { writeFloat32, writeVec3 } from './float32.js';
import { PROJECT_ID } from './ids.js';
import type { Failure, Scene } from './scene.js';
import { inverseChange, type Change, type Element, type Operation } from './textform.js';

export interface Author {
  /** Id of the installation: 16 characters from 0–9 and a–z. */
  author: string;
  /** Display name. */
  authorName: string;
}

export class BuildError extends Error {
  constructor(
    message: string,
    readonly failure?: Failure,
  ) {
    super(message);
  }
}

export type Vec3 = [number, number, number];

export interface NewObject {
  group: string;
  name: string;
  pos: Vec3;
  ypr?: Vec3;
  scale?: number;
  persist?: boolean;
  customString?: string;
}

export interface NewGroup {
  name: string;
  color: string;
  file: string;
  format?: string;
}

/** An angle in degrees brought into −180 to 180; values already inside stay as they are. */
export function normalizeAngle(a: number): number {
  if (a >= -180 && a <= 180) return a;
  const r = (((a + 180) % 360) + 360) % 360;
  return r - 180;
}

/**
 * Builds one operation from a sequence of edits. Every change is staged on the scene as it is added, so that later
 * changes see the earlier ones (create a group, then objects in it). `finish` takes the staged changes back and
 * returns the operation; the scene is unchanged afterwards.
 */
export class OpBuilder {
  readonly changes: Change[] = [];
  private done = false;

  constructor(
    readonly scene: Scene,
    readonly type: string,
    readonly by: Author,
  ) {}

  private push(c: Change): void {
    if (this.done) throw new Error('builder already finished');
    const failure = this.scene.stage(c);
    if (failure) throw new BuildError(`change ${c.k} on ${'el' in c ? c.el.id : c.id} does not fit (${failure})`, failure);
    this.changes.push(c);
  }

  private need(id: string): Element {
    const el = this.scene.get(id);
    if (!el) throw new BuildError(`no element ${id}`, 'missing');
    return el;
  }

  createGroup(g: NewGroup): string {
    const id = this.scene.ids.next();
    this.push({
      k: 'create',
      el: {
        id,
        kind: 'core:group',
        parent: PROJECT_ID,
        after: this.scene.lastChild(PROJECT_ID),
        hidden: false,
        locked: false,
        fields: new Map([
          ['color', g.color],
          ['file', g.file],
          ['format', g.format ?? 'spawner'],
          ['name', g.name],
        ]),
        comp: new Map([['projects:plugins', { v: 1, d: '[]' }]]),
      },
    });
    return id;
  }

  createObject(o: NewObject): string {
    const group = this.need(o.group);
    if (group.kind !== 'core:group') throw new BuildError(`${o.group} is not a group`, 'invalid');
    const id = this.scene.ids.next();
    const ypr = (o.ypr ?? [0, 0, 0]).map(normalizeAngle) as Vec3;
    this.push({
      k: 'create',
      el: {
        id,
        kind: 'core:object',
        parent: o.group,
        after: this.scene.lastChild(o.group),
        hidden: false,
        locked: false,
        fields: new Map([
          ['customString', o.customString ?? ''],
          ['name', o.name],
          ['persist', o.persist ? '1' : '0'],
          ['pos', writeVec3(o.pos)],
          ['scale', writeFloat32(o.scale ?? 1)],
          ['ypr', writeVec3(ypr)],
        ]),
        comp: new Map(),
      },
    });
    return id;
  }

  /** Sets a field; `undefined` removes it. A value equal to the current one adds no change. */
  setField(id: string, key: string, value: string | undefined): void {
    const el = this.need(id);
    const old = el.fields.get(key);
    if (old === value) return;
    const c: Change = { k: 'field', id, key };
    if (old !== undefined) c.old = old;
    if (value !== undefined) c.new = value;
    this.push(c);
  }

  setFlag(id: string, which: 'hidden' | 'locked', value: boolean): void {
    const el = this.need(id);
    if (el[which] === value) return;
    this.push({ k: which, id, old: el[which], new: value });
  }

  /** Sets companion data; `undefined` removes it. */
  setComp(id: string, type: string, value: { v: number; d: string } | undefined): void {
    const el = this.need(id);
    const old = el.comp.get(type);
    if (old?.v === value?.v && old?.d === value?.d) return;
    const c: Change = { k: 'comp', id, type };
    if (old) c.old = old;
    if (value) c.new = { ...value };
    this.push(c);
  }

  /** Moves an element into `to` after `toAfter`, by default to the end. */
  move(id: string, to: string, toAfter?: string): void {
    const el = this.need(id);
    this.need(to);
    let after = toAfter;
    if (after === undefined) {
      after = this.scene.lastChild(to);
      if (after === id) return;
    }
    if (el.parent === to && el.after === after) return;
    this.push({ k: 'move', id, from: el.parent, fromAfter: el.after, to, toAfter: after });
  }

  /** Deletes an element with everything below it: children last to first, each after its own children. */
  deleteTree(id: string): void {
    const kids = this.scene.children(id);
    for (let i = kids.length - 1; i >= 0; i--) this.deleteTree(kids[i]!);
    this.push({ k: 'delete', el: this.need(id) });
  }

  get empty(): boolean {
    return this.changes.length === 0;
  }

  finish(): Operation {
    this.done = true;
    this.scene.unstage();
    return {
      id: this.scene.ids.next(),
      type: this.type,
      tv: 1,
      author: this.by.author,
      authorName: this.by.authorName,
      origin: 'local',
      changes: this.changes,
    };
  }

  /** Abandons the operation; the scene is unchanged. */
  abort(): void {
    this.done = true;
    this.scene.unstage();
  }
}

/** Undo of a step: the inverses of all changes of all its operations, last first. */
export function undoOperation(steps: readonly Operation[], id: string, by: Author): Operation {
  const changes: Change[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const ch = steps[i]!.changes;
    for (let j = ch.length - 1; j >= 0; j--) changes.push(inverseChange(ch[j]!));
  }
  return { id, type: 'core:undo', tv: 1, author: by.author, authorName: by.authorName, origin: 'local', changes };
}
