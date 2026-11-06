import { chunk } from '../scene/chunks.js';
import { IdAllocator, randomPrefix } from '../scene/ids.js';
import { Scene, type ApplyResult } from '../scene/scene.js';
import { writeOperation, type Operation } from '../scene/textform.js';
import { CollabClient, requestId, type ClientInfo } from './client.js';
import { CollabError, UnreachableError, type Json } from './transport.js';

export const MAX_OP_BYTES = 3_670_016;
export const MAX_CHAIN_OPS = 16;
export const PART_BYTES = 1_048_576;
export const MAX_REQUEST_ITEMS = 200;
export const STATUS_MAX_BYTES = 200;

export type Phase = 'waiting' | 'working' | 'review';
export type SessionState = 'joining' | 'active' | 'ended' | 'removed' | 'lost' | 'left';

export interface SessionEvent {
  kind:
    | 'joined'
    | 'left'
    | 'removed'
    | 'participant_removed'
    | 'ended'
    | 'saved'
    | 'step_applied'
    | 'step_dropped'
    | 'locks_taken'
    | 'locks_released'
    | 'interrupted'
    | 'reconnected'
    | 'lost'
    | 'unknown_type';
  text: string;
  data?: Json;
}

export interface Timing {
  pollWaitMs: number;
  retryDelayMs: number;
  /** After this long without a successful request, return with `resume`. */
  resumeAfterMs: number;
  /** A step is reported as "not confirmed yet" after this long. */
  confirmTimeoutMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_TIMING: Timing = {
  pollWaitMs: 5000,
  retryDelayMs: 1000,
  resumeAfterMs: 30_000,
  confirmTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
};

export interface SessionOptions {
  client: CollabClient;
  token: () => string;
  clientInfo: ClientInfo;
  timing?: Partial<Timing>;
  /** Where the agent works, for presence; undefined while it has none. */
  position?: () => [number, number, number] | undefined;
}

export interface HostedProject {
  projectName: string;
  map: string;
  hostedRef: Json;
  hostedRevision: string;
}

/** `session/create` found a running session of the project; join that one instead. */
export class AlreadyRunning extends Error {
  constructor(readonly sessionId: string) {
    super(`A session of this project is running already: ${sessionId}`);
  }
}

export type StepResult =
  | { status: 'applied'; seq: number }
  | { status: 'dropped'; seq: number; message: string }
  | { status: 'unconfirmed' }
  | { status: 'rejected'; message: string };

interface Pending {
  op: Operation;
  settle: (r: StepResult) => void;
  done: Promise<StepResult>;
  seq?: number;
}

interface SendItem {
  clientSeq: number;
  opId: string;
  part?: number;
  parts?: number;
  chain?: { index: number; count: number };
  pieces: string[];
}

function pieceBytes(p: string): number {
  return Buffer.byteLength(JSON.stringify(p), 'utf8');
}

function groupBytes(pieces: readonly string[], max: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let bytes = 0;
  for (const p of pieces) {
    const n = pieceBytes(p);
    if (bytes + n > max && cur.length) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(p);
    bytes += n;
  }
  if (cur.length || !out.length) out.push(cur);
  return out;
}

/** Text of an ended session, as the editor words it. */
export function endedText(error: Json): string {
  switch (error.reason) {
    case 'host_ended':
    case 'host_left':
      return 'The host ended the session';
    case 'host_gone':
      return 'The host can no longer be reached';
    case 'discarded':
      return `${error.by ?? 'Someone'} discarded the unsaved changes`;
    default:
      return 'The server ended the session';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * One participation in a session: the poll that applies the log to the scene and reports presence, and the send
 * channel for locks and operations (one request at a time, retried unchanged).
 */
export class CollabSession {
  readonly timing: Timing;
  readonly scene: Scene;
  state: SessionState = 'joining';
  stateText = '';

  participantId = '';
  kind: 'local' | 'hosted' = 'local';
  role = '';
  colour = 0;
  rights = { canInvite: false, canSave: false, canManage: false };
  capabilities: string[] = [];

  /** Highest sequence number applied (never inside a chain). */
  appliedSeq = 0;
  /** Cursor for poll: also counts links of a chain received so far. */
  private pollCursor = 0;
  private chainBuf = new Map<string, string[][]>();
  private versions = { participants: 0, locks: 0, live: 0, notices: 0, saving: 0 };

  participants: Json[] = [];
  presence: Json[] = [];
  lockHolders: Json[] = [];
  saving: Json | undefined;

  phase: Phase = 'waiting';
  status = '';
  /** Elements this participant wants locked (its selection). */
  selection = new Set<string>();
  /** Elements the server has granted. */
  held = new Set<string>();
  /** Sequence number of the last own operation that was applied. */
  lastOwnSeq = 0;
  /** Ids this participant created or changed last, for the presence position. */
  lastTouched: string[] = [];

  private events: SessionEvent[] = [];
  private eventWaiters: (() => void)[] = [];
  private pending = new Map<string, Pending>();
  private nextClientSeq = 1;
  private lockSeq = 0;
  private lastInputMs = Date.now();
  private sendChain: Promise<unknown> = Promise.resolve();
  private polling = false;
  private pollAbort?: AbortController;
  private interruptedSince?: number;
  private checkpointBusy = false;
  private pollLoopDone?: Promise<void>;

  private constructor(
    readonly opts: SessionOptions,
    public sessionId: string,
    readonly prefix: string,
  ) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.scene = new Scene(new IdAllocator(prefix));
  }

  get client(): CollabClient {
    return this.opts.client;
  }

  // ------------------------------------------------------------ joining

  /** Joins a session: loads the snapshot into the scene, then starts polling. */
  static async join(opts: SessionOptions, sessionId: string): Promise<CollabSession> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const s = new CollabSession(opts, sessionId, randomPrefix());
      try {
        await s.doJoin();
        return s;
      } catch (e) {
        if (e instanceof CollabError && e.code === 'instance_key_taken') continue;
        throw e;
      }
    }
    throw new Error('Could not find a free session prefix');
  }

  /**
   * Creates a session of a hosted project the store has, with the state `build` puts into the (empty) scene as
   * snapshot 0, then starts polling. Throws AlreadyRunning when a session of the project is running already.
   */
  static async createHosted(opts: SessionOptions, params: HostedProject, build: (scene: Scene) => void): Promise<CollabSession> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const s = new CollabSession(opts, '', randomPrefix());
      build(s.scene);
      try {
        await s.doCreate(params);
        return s;
      } catch (e) {
        if (e instanceof CollabError && e.code === 'instance_key_taken') continue;
        if (e instanceof CollabError && e.code === 'already_running' && typeof e.error.sessionId === 'string')
          throw new AlreadyRunning(e.error.sessionId);
        throw e;
      }
    }
    throw new Error('Could not find a free session prefix');
  }

  private async doCreate(params: HostedProject): Promise<void> {
    const text = this.scene.stateText();
    const parts = groupBytes(chunk(text), PART_BYTES);
    const body: Json = {
      requestId: requestId(),
      client: this.opts.clientInfo,
      projectName: params.projectName,
      map: params.map,
      kind: 'hosted',
      hostedRef: params.hostedRef,
      hostedRevision: params.hostedRevision,
      instanceKey: this.prefix,
      snapshotBytes: Buffer.byteLength(text, 'utf8'),
      snapshotParts: parts.length,
    };
    const res = await this.withRetry(() => this.client.request('session/create', body, this.opts.token(), this.timing.requestTimeoutMs));
    this.sessionId = res.sessionId;
    this.participantId = res.participantId;
    this.kind = 'hosted';
    this.role = res.role;
    this.colour = res.colour;
    this.rights = { canInvite: !!res.canInvite, canSave: !!res.canSave, canManage: !!res.canManage };
    this.capabilities = Array.isArray(res.capabilities) ? res.capabilities : [];
    try {
      for (let part = 0; part < parts.length; part++) {
        await this.withRetry(() =>
          this.client.request(
            'snapshot/put',
            { ...this.ids(), seq: 0, part, parts: parts.length, pieces: parts[part] },
            this.opts.token(),
            this.timing.requestTimeoutMs,
          ),
        );
      }
    } catch (e) {
      await this.client.request('session/leave', this.ids(), this.opts.token()).catch(() => undefined);
      throw e;
    }
    this.state = 'active';
    this.startPolling();
  }

  private async doJoin(): Promise<void> {
    const rid = requestId();
    let res: Json | undefined;
    for (let i = 0; ; i++) {
      try {
        res = await this.client.request(
          'session/join',
          { requestId: rid, client: this.opts.clientInfo, sessionId: this.sessionId, instanceKey: this.prefix },
          this.opts.token(),
          this.timing.requestTimeoutMs,
        );
        break;
      } catch (e) {
        if (e instanceof CollabError && e.code === 'snapshot_not_ready' && i < 30) {
          await sleep(1000);
          continue;
        }
        if (e instanceof UnreachableError && i < 3) {
          await sleep(this.timing.retryDelayMs);
          continue;
        }
        throw e;
      }
    }
    this.participantId = res.participantId;
    this.kind = res.kind;
    this.role = res.role;
    this.colour = res.colour;
    this.rights = { canInvite: !!res.canInvite, canSave: !!res.canSave, canManage: !!res.canManage };
    this.capabilities = Array.isArray(res.capabilities) ? res.capabilities : [];
    try {
      const snap = res.snapshot as Json;
      const text = await this.downloadSnapshot(snap.seq, snap.parts);
      this.scene.open(text);
      this.appliedSeq = this.pollCursor = snap.seq;
    } catch (e) {
      await this.client.request('session/leave', this.ids(), this.opts.token()).catch(() => undefined);
      throw e;
    }
    this.state = 'active';
    this.startPolling();
  }

  private async downloadSnapshot(seq: number, parts: number): Promise<string> {
    const all: string[] = [];
    for (let part = 0; part < parts; part++) {
      const res = await this.withRetry(() =>
        this.client.request('snapshot/get', { ...this.ids(), seq, part }, this.opts.token(), this.timing.requestTimeoutMs),
      );
      all.push(...(res.pieces as string[]));
    }
    return all.join('');
  }

  private ids(): Json {
    return { sessionId: this.sessionId, participantId: this.participantId };
  }

  private async withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof UnreachableError) || i >= tries) throw e;
        await sleep(this.timing.retryDelayMs);
      }
    }
  }

  // ------------------------------------------------------------ events

  private emit(e: SessionEvent): void {
    this.events.push(e);
    for (const w of this.eventWaiters.splice(0)) w();
  }

  drainEvents(): SessionEvent[] {
    return this.events.splice(0);
  }

  /** Waits until there is at least one event or the time is up. */
  async waitForEvents(ms: number): Promise<void> {
    if (this.events.length) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done(): void {
        clearTimeout(t);
        resolve();
      }
      this.eventWaiters.push(done);
    });
  }

  get active(): boolean {
    return this.state === 'active';
  }

  /** How long the connection has been interrupted, 0 if it is not. */
  get interruptedMs(): number {
    return this.interruptedSince === undefined ? 0 : Date.now() - this.interruptedSince;
  }

  private finish(state: SessionState, text: string, kind: SessionEvent['kind']): void {
    if (!this.active && this.state !== 'joining') return;
    this.state = state;
    this.stateText = text;
    this.polling = false;
    this.pollAbort?.abort();
    for (const p of this.pending.values()) p.settle({ status: 'rejected', message: text });
    this.pending.clear();
    this.emit({ kind, text });
  }

  // ------------------------------------------------------------ the scene with own unconfirmed steps

  /** Runs `fn` on the scene with the own operations not yet applied by the log on top. */
  view<T>(fn: (scene: Scene) => T): T {
    const ops = [...this.pending.values()].map((p) => p.op);
    return this.scene.tentative(ops, () => fn(this.scene));
  }

  get unconfirmed(): number {
    return this.pending.size;
  }

  // ------------------------------------------------------------ presence

  setPhase(phase: Phase, status?: string): void {
    this.phase = phase;
    if (status !== undefined) this.status = status;
  }

  private presenceBody(): Json {
    const p: Json = {
      idleSeconds: Math.max(0, Math.floor((Date.now() - this.lastInputMs) / 1000)),
      phase: this.phase,
      status: this.status,
    };
    const pos = this.opts.position?.();
    if (pos) p.position = pos;
    return p;
  }

  // ------------------------------------------------------------ poll

  private startPolling(): void {
    this.polling = true;
    this.pollLoopDone = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let waitMs = 0;
    while (this.polling) {
      try {
        this.pollAbort = new AbortController();
        const res = await this.client.request(
          'poll',
          { ...this.ids(), after: this.pollCursor, waitMs, versions: this.versions, presence: this.presenceBody() },
          this.opts.token(),
          waitMs + this.timing.requestTimeoutMs,
          this.pollAbort.signal,
        );
        if (!this.polling) break;
        this.endInterruption();
        this.handlePoll(res);
        waitMs = res.more ? 0 : this.timing.pollWaitMs;
      } catch (e) {
        if (!this.polling) break;
        if (e instanceof CollabError) {
          if (this.handleSessionError(e)) break;
        } else if (e instanceof UnreachableError) {
          await this.interrupted();
        } else {
          this.finish('lost', `Connection lost: ${(e as Error).message}`, 'lost');
          break;
        }
        waitMs = 0;
        await sleep(this.timing.retryDelayMs);
      }
    }
  }

  /** Returns true if the participation is over. */
  private handleSessionError(e: CollabError): boolean {
    switch (e.code) {
      case 'session_ended':
        this.finish('ended', `Session ended: ${endedText(e.error)}`, 'ended');
        return true;
      case 'session_unknown':
      case 'not_allowed':
        this.finish('ended', 'Session ended: The server ended the session', 'ended');
        return true;
      case 'not_participant':
        if (e.error.reason === 'removed') this.finish('removed', `${e.error.by ?? 'Someone'} removed you from the session`, 'removed');
        else this.finish('lost', 'Away too long — join the session again', 'lost');
        return true;
      case 'cursor_too_old':
        this.finish('lost', 'Away too long — join the session again', 'lost');
        return true;
      case 'token_invalid':
      case 'token_expired':
      case 'auth_required':
        this.finish('lost', 'Not signed in any more — call login', 'lost');
        return true;
      default:
        return false;
    }
  }

  private endInterruption(): void {
    if (this.interruptedSince !== undefined) {
      this.interruptedSince = undefined;
      this.emit({ kind: 'reconnected', text: 'Connection is back' });
    }
  }

  private async interrupted(): Promise<void> {
    const now = Date.now();
    if (this.interruptedSince === undefined) {
      this.interruptedSince = now;
      this.emit({ kind: 'interrupted', text: 'Connection interrupted' });
      return;
    }
    if (now - this.interruptedSince >= this.timing.resumeAfterMs) await this.resume();
  }

  /** Returns after an interruption with `resume`; on anything but `mode: "resume"` the participation is lost. */
  async resume(): Promise<void> {
    try {
      const res = await this.client.request(
        'session/join',
        {
          requestId: requestId(),
          client: this.opts.clientInfo,
          sessionId: this.sessionId,
          instanceKey: this.prefix,
          resume: { participantId: this.participantId, after: this.appliedSeq },
        },
        this.opts.token(),
        this.timing.requestTimeoutMs,
      );
      if (res.mode !== 'resume') {
        this.finish('lost', 'Away too long — join the session again', 'lost');
        return;
      }
      this.role = res.role;
      this.colour = res.colour;
      this.rights = { canInvite: !!res.canInvite, canSave: !!res.canSave, canManage: !!res.canManage };
      this.pollCursor = this.appliedSeq;
      this.chainBuf.clear();
      this.versions = { participants: 0, locks: 0, live: 0, notices: 0, saving: 0 };
      this.endInterruption();
      if (this.selection.size) void this.setLocks([...this.selection]).catch(() => undefined);
    } catch (e) {
      if (e instanceof CollabError) this.handleSessionError(e);
    }
  }

  private handlePoll(res: Json): void {
    this.applyOps(Array.isArray(res.ops) ? res.ops : []);
    if (res.participants) {
      this.versions.participants = res.participants.version;
      const before = new Map(this.participants.map((p) => [p.participantId, p]));
      const after = (res.participants.list ?? []) as Json[];
      for (const p of after) {
        if (!before.has(p.participantId) && p.participantId !== this.participantId && this.participants.length) {
          this.emit({ kind: 'joined', text: `${displayName(p)} joined`, data: { participantId: p.participantId } });
        }
      }
      const nowIds = new Set(after.map((p) => p.participantId));
      const removedIds = new Set(
        ((res.notices?.list ?? []) as Json[]).filter((n) => n.kind === 'participant_removed').map((n) => n.participantId),
      );
      for (const [id, p] of before) {
        if (!nowIds.has(id) && !removedIds.has(id))
          this.emit({ kind: 'left', text: `${displayName(p)} left`, data: { participantId: id } });
      }
      this.participants = after;
    }
    if (Array.isArray(res.presence)) this.presence = res.presence;
    if (res.saving) {
      this.versions.saving = res.saving.version;
      const prev = this.saving;
      this.saving = res.saving;
      const savedSeq = res.saving.savedSeq;
      if (this.kind === 'hosted' && typeof savedSeq === 'number' && prev && savedSeq > (prev.savedSeq ?? 0) && res.saving.savedBy) {
        this.emit({ kind: 'saved', text: `Saved by ${res.saving.savedBy.name}`, data: { savedSeq, by: res.saving.savedBy.name } });
      }
    }
    if (res.notices) {
      this.versions.notices = res.notices.version;
      for (const n of (res.notices.list ?? []) as Json[]) this.handleNotice(n);
    }
    if (res.locks) {
      this.versions.locks = res.locks.version;
      this.lockHolders = res.locks.holders ?? [];
      const mine = new Set<string>();
      const others = new Set<string>();
      for (const h of this.lockHolders) for (const el of h.elements ?? []) (h.participantId === this.participantId ? mine : others).add(el);
      this.held = mine;
      for (const el of [...this.selection]) if (others.has(el)) this.selection.delete(el);
    }
    if (res.checkpointWanted === true) void this.uploadCheckpoint();
  }

  private handleNotice(n: Json): void {
    switch (n.kind) {
      case 'locks_released':
        this.selection.clear();
        this.held.clear();
        this.emit({ kind: 'locks_released', text: `${n.by} released your selection` });
        break;
      case 'locks_taken': {
        const count = Number(n.count ?? 0);
        this.emit({ kind: 'locks_taken', text: `${n.by} took over ${count} object${count === 1 ? '' : 's'}`, data: { count } });
        break;
      }
      case 'participant_removed':
        if (n.participantId !== this.participantId) this.emit({ kind: 'participant_removed', text: `${n.name} was removed by ${n.by}` });
        break;
    }
  }

  private applyOps(entries: Json[]): void {
    let i = 0;
    while (i < entries.length) {
      const first = entries[i]!;
      const group: Json[] = [];
      while (i < entries.length && entries[i]!.seq === first.seq) group.push(entries[i++]!);
      if (first.seq <= this.pollCursor) continue;
      group.sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
      const pieces = group.flatMap((g) => g.pieces as string[]);
      this.pollCursor = first.seq;
      if (first.chain) {
        const key = `${first.participantId}\u0000${first.opId}`;
        const links = this.chainBuf.get(key) ?? [];
        links[first.chain.index] = pieces;
        this.chainBuf.set(key, links);
        if (first.chain.index !== first.chain.count - 1) continue;
        this.chainBuf.delete(key);
        this.applyOne(first, links.flat().join(''));
      } else {
        this.applyOne(first, pieces.join(''));
      }
      this.appliedSeq = first.seq;
    }
  }

  private applyOne(entry: Json, text: string): void {
    const result: ApplyResult = this.scene.applyText(text);
    const own = entry.participantId === this.participantId ? this.pending.get(entry.opId) : undefined;
    if (own) {
      this.pending.delete(entry.opId);
      if (result.result === 'applied') {
        this.lastOwnSeq = entry.seq;
        own.settle({ status: 'applied', seq: entry.seq });
      } else {
        const message = result.result === 'precondition' ? result.message : result.result;
        own.settle({ status: 'dropped', seq: entry.seq, message: `Step no longer possible: ${message}` });
      }
      return;
    }
    if (result.result === 'unknown_type' && entry.participantId !== this.participantId) {
      this.emit({
        kind: 'unknown_type',
        text: `This session needs a newer dzStudio MCP (operation type of plugin ${result.plugin}, version ${result.version})`,
      });
      void this.leave().catch(() => undefined);
      this.finish('lost', 'This session needs a newer dzStudio MCP', 'lost');
    }
  }

  // ------------------------------------------------------------ send channel

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sendChain.then(fn, fn);
    this.sendChain = run.catch(() => undefined);
    return run;
  }

  /** A request of the send channel: repeated unchanged while the server is unreachable or busy. */
  private async sendRequest(endpoint: string, body: Json): Promise<Json> {
    for (;;) {
      if (!this.active) throw new Error(this.stateText || 'Not in a session');
      try {
        const res = await this.client.request(endpoint, body, this.opts.token(), this.timing.requestTimeoutMs);
        this.endInterruption();
        return res;
      } catch (e) {
        if (e instanceof UnreachableError) {
          await this.interrupted();
          await sleep(this.timing.retryDelayMs);
          continue;
        }
        if (e instanceof CollabError && (e.code === 'busy' || e.code === 'throttled')) {
          await sleep(Number(e.error.retryAfterMs ?? this.timing.retryDelayMs));
          continue;
        }
        if (e instanceof CollabError) this.handleSessionError(e);
        throw e;
      }
    }
  }

  /** Sets the whole lock set. Returns what the server granted and denied. */
  async setLocks(elements: string[]): Promise<{ granted: string[]; denied: { element: string; holder: string | null }[] }> {
    return this.enqueue(async () => {
      const set = [...new Set(elements)];
      const changed = set.length !== this.selection.size || set.some((e) => !this.selection.has(e));
      this.lockSeq++;
      if (changed) this.lastInputMs = Date.now();
      const res = await this.sendRequest('locks/set', { ...this.ids(), lockSeq: this.lockSeq, elements: set });
      const granted = (res.granted ?? []) as string[];
      const denied = (res.denied ?? []) as { element: string; holder: string | null }[];
      this.selection = new Set(granted);
      this.held = new Set(granted);
      return { granted, denied };
    });
  }

  private buildItems(op: Operation): SendItem[] {
    const pieces = chunk(writeOperation(op));
    const total = pieces.reduce((n, p) => n + pieceBytes(p), 0);
    const links = total > MAX_OP_BYTES ? groupBytes(pieces, MAX_OP_BYTES) : [pieces];
    if (links.length > MAX_CHAIN_OPS) {
      const mb = Math.ceil(total / 1_048_576);
      throw new Error(`Too large for a shared session (${mb} MB, at most 56 MB)`);
    }
    const items: SendItem[] = [];
    links.forEach((link, index) => {
      const clientSeq = this.nextClientSeq + index;
      const chain = links.length > 1 ? { index, count: links.length } : undefined;
      const linkBytes = link.reduce((n, p) => n + pieceBytes(p), 0);
      const parts = linkBytes > PART_BYTES ? groupBytes(link, PART_BYTES) : [link];
      parts.forEach((partPieces, part) => {
        const item: SendItem = { clientSeq, opId: op.id, pieces: partPieces };
        if (parts.length > 1) {
          item.part = part;
          item.parts = parts.length;
        }
        if (chain) item.chain = chain;
        items.push(item);
      });
    });
    this.nextClientSeq += links.length;
    return items;
  }

  /**
   * Submits one own operation: checks it on the scene first (an operation that would not apply is not sent), sends
   * it, and waits until the log has applied or dropped it, at most `confirmTimeoutMs`.
   */
  async submit(op: Operation): Promise<StepResult> {
    if (!this.active) return { status: 'rejected', message: this.stateText || 'Not in a session' };
    const check = this.view(() => this.scene.tentative([op], (r) => r[0]!));
    if (check.result !== 'applied') {
      const message =
        check.result === 'precondition' ? `Step no longer possible: ${check.message}` : `Operation not valid: ${check.result}`;
      return { status: 'rejected', message };
    }
    let items: SendItem[];
    try {
      items = this.buildItems(op);
    } catch (e) {
      return { status: 'rejected', message: (e as Error).message };
    }
    let settle!: (r: StepResult) => void;
    const done = new Promise<StepResult>((r) => (settle = r));
    const pending: Pending = { op, settle, done };
    this.pending.set(op.id, pending);
    this.lastInputMs = Date.now();
    const sent = this.enqueue(() => this.sendItems(items)).catch((e: Error) => {
      if (this.pending.get(op.id) === pending) {
        this.pending.delete(op.id);
        settle({ status: 'rejected', message: e.message });
      }
    });
    void sent;
    const timeout = sleep(this.timing.confirmTimeoutMs).then((): StepResult => ({ status: 'unconfirmed' }));
    const result = await Promise.race([done, timeout]);
    if (result.status === 'unconfirmed') {
      void done.then((r) => {
        if (r.status === 'applied')
          this.emit({ kind: 'step_applied', text: `Step ${op.id} was applied`, data: { opId: op.id, seq: r.seq } });
        else if (r.status === 'dropped' || r.status === 'rejected')
          this.emit({ kind: 'step_dropped', text: r.message, data: { opId: op.id } });
      });
    } else if (result.status === 'dropped') {
      this.emit({ kind: 'step_dropped', text: result.message, data: { opId: op.id } });
    }
    return result;
  }

  private async sendItems(items: SendItem[]): Promise<void> {
    let rest = items;
    while (rest.length) {
      const batch: SendItem[] = [];
      let bytes = 0;
      for (const item of rest) {
        const n = item.pieces.reduce((s, p) => s + pieceBytes(p), 0);
        if (batch.length && (batch.length >= MAX_REQUEST_ITEMS || bytes + n > MAX_OP_BYTES)) break;
        batch.push(item);
        bytes += n;
      }
      try {
        await this.sendRequest('ops/send', { ...this.ids(), ops: batch });
        rest = rest.slice(batch.length);
      } catch (e) {
        if (e instanceof CollabError && e.code === 'client_seq_gap') {
          const expected = Number(e.error.expectedClientSeq);
          const from = items.findIndex((it) => it.clientSeq >= expected);
          if (from < 0) return;
          rest = items.slice(from);
          continue;
        }
        throw e;
      }
    }
  }

  // ------------------------------------------------------------ checkpoints

  private async uploadCheckpoint(): Promise<void> {
    if (this.checkpointBusy) return;
    if (this.pending.size || this.chainBuf.size || this.appliedSeq === 0) return;
    const project = this.scene.get('project');
    if (project && (project.fields.get('lootFiles') ?? '') !== '') return;
    this.checkpointBusy = true;
    try {
      const seq = this.appliedSeq;
      const parts = groupBytes(chunk(this.scene.stateText()), PART_BYTES);
      await this.enqueue(async () => {
        for (let part = 0; part < parts.length; part++) {
          await this.sendRequest('snapshot/put', { ...this.ids(), seq, part, parts: parts.length, pieces: parts[part] });
        }
      });
    } catch {
      // the server asks again
    } finally {
      this.checkpointBusy = false;
    }
  }

  // ------------------------------------------------------------ leaving

  /** Waits until all own operations are confirmed, at most `ms`. Returns how many are still open. */
  async flush(ms: number): Promise<number> {
    const deadline = Date.now() + ms;
    while (this.pending.size && Date.now() < deadline && this.active) await sleep(50);
    return this.pending.size;
  }

  async leave(): Promise<void> {
    const wasActive = this.active;
    this.polling = false;
    this.pollAbort?.abort();
    if (wasActive || this.state === 'lost') {
      try {
        await this.client.request('session/leave', this.ids(), this.opts.token(), this.timing.requestTimeoutMs);
      } catch {
        // gone anyway
      }
    }
    if (this.active) {
      this.state = 'left';
      this.stateText = 'Left the session';
    }
    for (const p of this.pending.values()) p.settle({ status: 'rejected', message: 'Left the session' });
    this.pending.clear();
  }

  /** Stops polling without telling the server (the MCP is shutting down; `resume` may bring it back). */
  async stop(): Promise<void> {
    this.polling = false;
    this.pollAbort?.abort();
    await Promise.race([this.pollLoopDone, sleep(50)]);
  }
}

export function displayName(p: Json): string {
  return p.kind === 'agent' ? `${p.name}'s agent` : String(p.name ?? p.participantId);
}
