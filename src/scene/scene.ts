import { IdAllocator, PROJECT_ID } from './ids.js';
import {
  readOperation,
  readStateText,
  TextFormError,
  writeState,
  type Change,
  type Comp,
  type Element,
  type Operation,
} from './textform.js';
import { ELEMENT_TYPES, OPERATION_TYPES, pluginOf } from './types.js';

export type Failure = 'exists' | 'missing' | 'changed' | 'invalid';

export type ApplyResult =
  | { result: 'applied' }
  | { result: 'invalid'; reason: string }
  | { result: 'duplicate' }
  | { result: 'unknown_type'; plugin: string; version: number }
  | { result: 'precondition'; failure: Failure; index: number; message: string };

interface Node {
  id: string;
  kind: string;
  parent: string;
  hidden: boolean;
  locked: boolean;
  fields: Map<string, string>;
  comp: Map<string, Comp>;
  prev: string;
  next: string;
  first: string;
  last: string;
  count: number;
}

/** Exact reversal of one mutation, for rolling back an operation that fails part-way. */
type Undo =
  | { k: 'unlink-create'; id: string }
  | { k: 'relink'; node: Node; parent: string; prev: string }
  | { k: 'move-back'; id: string; parent: string; prev: string }
  | { k: 'field'; id: string; key: string; old?: string }
  | { k: 'flag'; id: string; which: 'hidden' | 'locked'; old: boolean }
  | { k: 'comp'; id: string; type: string; old?: Comp };

class PreconditionFailed extends Error {
  constructor(
    readonly failure: Failure,
    readonly addressed: string,
  ) {
    super(failure);
  }
}

function fieldsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function compsEqual(a: Map<string, Comp>, b: Map<string, Comp>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.v !== v.v || o.d !== v.d) return false;
  }
  return true;
}

function sameComp(a: Comp | undefined, b: Comp | undefined): boolean {
  if (!a || !b) return a === b;
  return a.v === b.v && a.d === b.d;
}

/** Message of "step no longer possible" for a failed precondition. */
export function stepMessage(failure: Failure, addressedKind: string | undefined): string {
  if (failure === 'missing' && addressedKind === 'core:group') return 'Group was deleted';
  if (failure === 'missing') return 'Object was deleted';
  if (failure === 'changed') return 'Object was changed';
  return 'Change no longer fits';
}

/**
 * The project state outside the game: a tree of elements that applies operations exactly like dzStudio's core,
 * with the same stages, preconditions and rollback, and writes the state text form byte for byte.
 */
export class Scene {
  private nodes = new Map<string, Node>();
  private knownOps = new Set<string>();
  /** Last kind seen for every id, to tell a deleted group from a deleted object in messages. */
  private kindsSeen = new Map<string, string>();

  constructor(readonly ids: IdAllocator = new IdAllocator()) {}

  // ------------------------------------------------------------ reading

  get size(): number {
    return this.nodes.size;
  }

  has(id: string): boolean {
    return this.nodes.has(id);
  }

  isKnownOperation(id: string): boolean {
    return this.knownOps.has(id);
  }

  get(id: string): Element | undefined {
    const n = this.nodes.get(id);
    return n ? this.toElement(n) : undefined;
  }

  children(id: string): string[] {
    const out: string[] = [];
    const n = this.nodes.get(id);
    if (!n) return out;
    for (let c = n.first; c !== ''; c = this.nodes.get(c)!.next) out.push(c);
    return out;
  }

  lastChild(id: string): string {
    return this.nodes.get(id)?.last ?? '';
  }

  childCount(id: string): number {
    return this.nodes.get(id)?.count ?? 0;
  }

  /** All elements depth-first from the project, each followed by its children in order. */
  *walk(): Generator<Element> {
    const root = this.nodes.get(PROJECT_ID);
    if (!root) return;
    const stack: string[] = [PROJECT_ID];
    while (stack.length) {
      const id = stack.pop()!;
      const n = this.nodes.get(id)!;
      yield this.toElement(n);
      const kids = this.children(id);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  }

  private toElement(n: Node): Element {
    return {
      id: n.id,
      kind: n.kind,
      parent: n.parent,
      after: n.prev,
      hidden: n.hidden,
      locked: n.locked,
      fields: new Map(n.fields),
      comp: new Map([...n.comp].map(([k, c]) => [k, { ...c }])),
    };
  }

  // ------------------------------------------------------------ text form of the state

  stateText(): string {
    const elements = [...this.walk()];
    const kinds = new Map<string, number>();
    for (const e of elements) kinds.set(e.kind, 1);
    return writeState({ kinds, elements });
  }

  /**
   * Opens a state text form into this (empty) scene as one `core:load` with origin `system`. Throws TextFormError
   * for an invalid or newer text form, an unknown element type, or an element whose parent does not come before it.
   */
  open(text: string): void {
    if (this.nodes.size) throw new Error('open needs an empty scene');
    const st = readStateText(text);
    const unknown = new Set<string>();
    for (const k of st.kinds.keys()) if (!ELEMENT_TYPES.has(k)) unknown.add(k);
    for (const e of st.elements) if (!ELEMENT_TYPES.has(e.kind)) unknown.add(e.kind);
    if (unknown.size) throw new TextFormError(`unknown element types: ${[...unknown].join(', ')}`);
    const op: Operation = {
      id: '',
      type: 'core:load',
      tv: 1,
      author: '',
      authorName: '',
      origin: 'system',
      changes: st.elements.map((el) => ({ k: 'create', el })),
    };
    const undo: Undo[] = [];
    try {
      op.changes.forEach((c) => this.applyChange(c, undo));
    } catch (e) {
      this.rollback(undo);
      if (e instanceof PreconditionFailed) throw new TextFormError(`state does not open: ${e.failure} at ${e.addressed}`);
      throw e;
    }
    for (const e of st.elements) this.ids.observe(e.id);
  }

  // ------------------------------------------------------------ applying

  /** Applies the text form of an operation through all stages. */
  applyText(text: string): ApplyResult {
    let op: Operation;
    try {
      op = readOperation(text);
    } catch (e) {
      if (e instanceof TextFormError) return { result: 'invalid', reason: e.message };
      throw e;
    }
    return this.apply(op);
  }

  /** Stages 3 to 6 for an operation already read. */
  apply(op: Operation): ApplyResult {
    const pre = this.check(op);
    if (pre) return pre;
    const undo: Undo[] = [];
    for (let i = 0; i < op.changes.length; i++) {
      try {
        this.applyChange(op.changes[i]!, undo);
      } catch (e) {
        if (!(e instanceof PreconditionFailed)) throw e;
        this.rollback(undo);
        return {
          result: 'precondition',
          failure: e.failure,
          index: i,
          message: stepMessage(e.failure, this.kindsSeen.get(e.addressed)),
        };
      }
    }
    this.knownOps.add(op.id);
    this.ids.observe(op.id);
    return { result: 'applied' };
  }

  /**
   * Applies an operation only to look at the result, then takes it back. Used to check own operations before
   * sending and to read the state with unconfirmed own operations on top.
   */
  tentative<T>(ops: readonly Operation[], fn: (results: ApplyResult[]) => T): T {
    const undos: Undo[][] = [];
    const results: ApplyResult[] = [];
    const added: string[] = [];
    try {
      for (const op of ops) {
        const pre = this.check(op);
        if (pre) {
          results.push(pre);
          continue;
        }
        const undo: Undo[] = [];
        let failed: ApplyResult | undefined;
        for (let i = 0; i < op.changes.length && !failed; i++) {
          try {
            this.applyChange(op.changes[i]!, undo);
          } catch (e) {
            if (!(e instanceof PreconditionFailed)) throw e;
            this.rollback(undo);
            failed = { result: 'precondition', failure: e.failure, index: i, message: stepMessage(e.failure, this.kindsSeen.get(e.addressed)) };
          }
        }
        if (failed) results.push(failed);
        else {
          undos.push(undo);
          if (!this.knownOps.has(op.id)) {
            this.knownOps.add(op.id);
            added.push(op.id);
          }
          results.push({ result: 'applied' });
        }
      }
      return fn(results);
    } finally {
      for (let i = undos.length - 1; i >= 0; i--) this.rollback(undos[i]!);
      for (const id of added) this.knownOps.delete(id);
    }
  }

  private staged: Undo[] = [];

  /**
   * Applies one change on trial, so that the next change of an operation being built sees its effect. Returns the
   * failed precondition, if any (then nothing changed). `unstage` takes everything staged back.
   */
  stage(c: Change): Failure | undefined {
    try {
      this.applyChange(c, this.staged);
      return undefined;
    } catch (e) {
      if (e instanceof PreconditionFailed) return e.failure;
      throw e;
    }
  }

  unstage(): void {
    this.rollback(this.staged);
    this.staged = [];
  }

  private check(op: Operation): ApplyResult | undefined {
    if (this.knownOps.has(op.id)) return { result: 'duplicate' };
    const registered = OPERATION_TYPES.get(op.type);
    if (registered === undefined || op.tv > registered) return { result: 'unknown_type', plugin: pluginOf(op.type), version: op.tv };
    for (const c of op.changes) {
      if ((c.k === 'create' || c.k === 'delete') && !ELEMENT_TYPES.has(c.el.kind)) {
        return { result: 'unknown_type', plugin: pluginOf(c.el.kind), version: 1 };
      }
    }
    return undefined;
  }

  private rollback(undo: Undo[]): void {
    for (let i = undo.length - 1; i >= 0; i--) {
      const u = undo[i]!;
      switch (u.k) {
        case 'unlink-create':
          this.unlink(this.nodes.get(u.id)!);
          this.nodes.delete(u.id);
          break;
        case 'relink':
          this.nodes.set(u.node.id, u.node);
          if (u.parent !== '') this.linkAfter(u.node, u.parent, u.prev, true);
          break;
        case 'move-back': {
          const n = this.nodes.get(u.id)!;
          this.unlink(n);
          this.linkAfter(n, u.parent, u.prev, true);
          break;
        }
        case 'field': {
          const n = this.nodes.get(u.id)!;
          if (u.old === undefined) n.fields.delete(u.key);
          else n.fields.set(u.key, u.old);
          break;
        }
        case 'flag':
          this.nodes.get(u.id)![u.which] = u.old;
          break;
        case 'comp': {
          const n = this.nodes.get(u.id)!;
          if (u.old === undefined) n.comp.delete(u.type);
          else n.comp.set(u.type, u.old);
          break;
        }
      }
    }
  }

  private isBelow(id: string, ancestor: string): boolean {
    for (let cur = id; cur !== ''; cur = this.nodes.get(cur)?.parent ?? '') {
      if (cur === ancestor) return true;
    }
    return false;
  }

  private allowsParent(kind: string, parentKind: string): boolean {
    return ELEMENT_TYPES.get(kind)?.parents.includes(parentKind) ?? false;
  }

  private applyChange(c: Change, undo: Undo[]): void {
    switch (c.k) {
      case 'create': {
        const el = c.el;
        if (el.id === '' || this.nodes.has(el.id)) throw new PreconditionFailed('exists', el.id);
        if (el.parent === '') {
          if (el.id !== PROJECT_ID || el.kind !== 'core:project' || this.nodes.size !== 0) throw new PreconditionFailed('invalid', el.id);
        } else {
          const parent = this.nodes.get(el.parent);
          if (!parent) throw new PreconditionFailed('missing', el.parent);
          if (!this.allowsParent(el.kind, parent.kind)) throw new PreconditionFailed('invalid', el.id);
        }
        const n: Node = {
          id: el.id,
          kind: el.kind,
          parent: el.parent,
          hidden: el.hidden,
          locked: el.locked,
          fields: new Map(el.fields),
          comp: new Map([...el.comp].map(([k, v]) => [k, { ...v }])),
          prev: '',
          next: '',
          first: '',
          last: '',
          count: 0,
        };
        this.nodes.set(n.id, n);
        if (n.parent !== '') this.linkAfter(n, n.parent, el.after, false);
        this.kindsSeen.set(n.id, n.kind);
        this.ids.observe(n.id);
        undo.push({ k: 'unlink-create', id: n.id });
        return;
      }
      case 'delete': {
        const el = c.el;
        const n = this.nodes.get(el.id);
        if (!n) throw new PreconditionFailed('missing', el.id);
        if (
          n.count !== 0 ||
          n.parent !== el.parent ||
          n.prev !== el.after ||
          n.kind !== el.kind ||
          n.hidden !== el.hidden ||
          n.locked !== el.locked ||
          !fieldsEqual(n.fields, el.fields) ||
          !compsEqual(n.comp, el.comp)
        ) {
          throw new PreconditionFailed('changed', el.id);
        }
        const parent = n.parent;
        const prev = n.prev;
        if (parent !== '') this.unlink(n);
        this.nodes.delete(n.id);
        undo.push({ k: 'relink', node: n, parent, prev });
        return;
      }
      case 'field': {
        const n = this.nodes.get(c.id);
        if (!n) throw new PreconditionFailed('missing', c.id);
        const had = n.fields.has(c.key);
        if (had !== (c.old !== undefined) || (had && n.fields.get(c.key) !== c.old)) throw new PreconditionFailed('changed', c.id);
        undo.push({ k: 'field', id: c.id, key: c.key, old: n.fields.get(c.key) });
        if (c.new === undefined) n.fields.delete(c.key);
        else n.fields.set(c.key, c.new);
        return;
      }
      case 'hidden':
      case 'locked': {
        const n = this.nodes.get(c.id);
        if (!n) throw new PreconditionFailed('missing', c.id);
        if (n[c.k] !== c.old) throw new PreconditionFailed('changed', c.id);
        undo.push({ k: 'flag', id: c.id, which: c.k, old: n[c.k] });
        n[c.k] = c.new;
        return;
      }
      case 'move': {
        const n = this.nodes.get(c.id);
        if (!n) throw new PreconditionFailed('missing', c.id);
        if (n.parent !== c.from || n.prev !== c.fromAfter) throw new PreconditionFailed('changed', c.id);
        const to = this.nodes.get(c.to);
        if (!to) throw new PreconditionFailed('missing', c.to);
        if (!this.allowsParent(n.kind, to.kind) || this.isBelow(c.to, c.id)) throw new PreconditionFailed('invalid', c.id);
        const parent = n.parent;
        const prev = n.prev;
        this.unlink(n);
        this.linkAfter(n, c.to, c.toAfter === c.id ? to.last : c.toAfter, false);
        undo.push({ k: 'move-back', id: c.id, parent, prev });
        return;
      }
      case 'comp': {
        const n = this.nodes.get(c.id);
        if (!n) throw new PreconditionFailed('missing', c.id);
        const cur = n.comp.get(c.type);
        if (!sameComp(cur, c.old)) throw new PreconditionFailed('changed', c.id);
        undo.push({ k: 'comp', id: c.id, type: c.type, old: cur });
        if (c.new) n.comp.set(c.type, { ...c.new });
        else n.comp.delete(c.type);
        return;
      }
    }
  }

  private unlink(n: Node): void {
    const parent = this.nodes.get(n.parent);
    if (!parent) return;
    if (n.prev !== '') this.nodes.get(n.prev)!.next = n.next;
    else parent.first = n.next;
    if (n.next !== '') this.nodes.get(n.next)!.prev = n.prev;
    else parent.last = n.prev;
    parent.count--;
    n.prev = '';
    n.next = '';
  }

  /**
   * Inserts as a child of `parentId` after `after`: `""` first; a child of the parent directly behind it; anything
   * else at the end. `exact` is for rollback, where `after` is always a child.
   */
  private linkAfter(n: Node, parentId: string, after: string, exact: boolean): void {
    const parent = this.nodes.get(parentId)!;
    n.parent = parentId;
    let prev: string;
    if (after === '') prev = '';
    else {
      const a = this.nodes.get(after);
      prev = a && a.parent === parentId && a.id !== n.id ? after : parent.last;
      if (exact && prev !== after) throw new Error('rollback lost its position');
    }
    const next = prev === '' ? parent.first : this.nodes.get(prev)!.next;
    n.prev = prev;
    n.next = next;
    if (prev === '') parent.first = n.id;
    else this.nodes.get(prev)!.next = n.id;
    if (next === '') parent.last = n.id;
    else this.nodes.get(next)!.prev = n.id;
    parent.count++;
  }
}
