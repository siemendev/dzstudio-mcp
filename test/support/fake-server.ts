import { UnreachableError, type CallOptions, type Json, type Transport } from '../../src/protocol/transport.js';

/**
 * An in-memory dzcollab 1 server for unit tests: enough of the protocol to drive a client (sessions, snapshots,
 * operations with parts and chains, long poll, locks, notices, saving), plus fault injection and request counters.
 */

interface Entry {
  seq: number;
  participantId: string;
  opId: string;
  parts: string[][];
  chain?: { index: number; count: number };
}

interface Participant {
  participantId: string;
  userId: string;
  name: string;
  kind: 'studio' | 'agent';
  colour: number;
  role: string;
  canInvite: boolean;
  canSave: boolean;
  canManage: boolean;
  nextClientSeq: number;
  lockSeq: number;
  elements: Set<string>;
  presence: Json;
  notices: { version: number; n: Json }[];
  noticeVer: number;
  staged: Map<number, { parts: (string[] | undefined)[]; opId: string; chain?: { index: number; count: number } }>;
  chain: { opId: string; count: number; links: { clientSeq: number; parts: string[][] }[] } | undefined;
  opIds: Map<string, number>;
  active: boolean;
  removedBy?: string;
  visible: boolean;
}

interface Session {
  id: string;
  kind: 'local' | 'hosted';
  projectName: string;
  map: string;
  hostedRef?: Json;
  log: Entry[];
  snapshots: Map<number, string[][]>;
  participants: Participant[];
  ver: { participants: number; locks: number; saving: number };
  saving: Json;
  ended?: Json;
  checkpointFrom?: string;
  waiters: (() => void)[];
}

type Fault = 'before' | 'after';

export class FakeServer implements Transport {
  capabilities = ['hosted', 'auth.code', 'agents'];
  sessions = new Map<string, Session>();
  counts = new Map<string, number>();
  requests: { endpoint: string; body: Json }[] = [];
  codeLogins = new Map<string, { state: string; name?: string }>();
  invalidTokens = new Set<string>();
  projects: Json[] = [];
  private faults: { endpoint: string; mode: Fault }[] = [];
  private nextId = 1;
  private retry = new Map<string, Json>();

  /** The next request to `endpoint` fails: before the server sees it, or after it was processed. */
  fail(endpoint: string, mode: Fault): void {
    this.faults.push({ endpoint, mode });
  }

  count(endpoint: string): number {
    return this.counts.get(endpoint) ?? 0;
  }

  async call(endpoint: string, body: Json | undefined, opts: CallOptions = {}): Promise<Json> {
    const req = body ?? {};
    const fi = this.faults.findIndex((f) => f.endpoint === endpoint);
    const fault = fi >= 0 ? this.faults.splice(fi, 1)[0] : undefined;
    if (fault?.mode === 'before') throw new UnreachableError('Server not reachable (injected)');
    this.counts.set(endpoint, this.count(endpoint) + 1);
    this.requests.push({ endpoint, body: req });
    const res = await this.handle(endpoint, req, opts.signal);
    if (fault?.mode === 'after') throw new UnreachableError('Server not reachable (injected after processing)');
    return JSON.parse(JSON.stringify(res));
  }

  private err(code: string, extra: Json = {}): Json {
    return { ok: false, error: { code, ...extra } };
  }

  private user(req: Json): { userId: string; name: string } | Json {
    const t = req.token;
    if (typeof t !== 'string' || !t.startsWith('t-')) return this.err('auth_required');
    if (this.invalidTokens.has(t)) return this.err('token_invalid');
    const name = t.slice(2).replace(/^agent-/, '');
    return { userId: 'u-' + name.toLowerCase(), name };
  }

  private session(req: Json): Session | Json {
    const s = this.sessions.get(req.sessionId);
    if (!s) return this.err('session_unknown');
    if (s.ended) return this.err('session_ended', s.ended);
    return s;
  }

  private member(s: Session, req: Json): Participant | Json {
    const p = s.participants.find((x) => x.participantId === req.participantId);
    if (!p) return this.err('not_participant', { reason: 'timeout' });
    if (!p.active)
      return p.removedBy
        ? this.err('not_participant', { reason: 'removed', by: p.removedBy })
        : this.err('not_participant', { reason: 'timeout' });
    return p;
  }

  notify(s: Session): void {
    for (const w of s.waiters.splice(0)) w();
  }

  private async handle(endpoint: string, req: Json, signal?: AbortSignal): Promise<Json> {
    if (endpoint === 'info') {
      return {
        ok: true,
        server: { name: 'Fake' },
        protocols: [{ major: 1, minor: 0 }],
        capabilities: this.capabilities,
        auth: [{ method: 'code' }],
        limits: { maxRequestBytes: 8388608, maxOpBytes: 3670016, maxChainOps: 16 },
      };
    }
    if (endpoint === 'auth/code/start') {
      const code = `ABCD${String(this.nextId++).padStart(4, '0')}`;
      this.codeLogins.set(code, { state: 'waiting' });
      return { ok: true, loginCode: code, url: `https://fake/login?code=${code}`, expiresInSeconds: 600, intervalSeconds: 2 };
    }
    if (endpoint === 'auth/code/poll') {
      const c = this.codeLogins.get(req.loginCode);
      if (!c) return this.err('bad_request');
      if (c.state === 'confirmed') return { ok: true, state: 'confirmed', token: `t-agent-${c.name}`, name: c.name };
      return { ok: true, state: c.state };
    }
    const u = this.user(req);
    if ('ok' in u) return u;
    if (req.requestId && this.retry.has(`${u.userId}/${req.requestId}`)) return this.retry.get(`${u.userId}/${req.requestId}`)!;
    const res = await this.handleUser(endpoint, req, u as { userId: string; name: string }, signal);
    if (req.requestId && res.ok) this.retry.set(`${(u as Json).userId}/${req.requestId}`, res);
    return res;
  }

  /** Creates a session as a studio (the test's human host) with a snapshot already uploaded. */
  createSession(opts: { kind?: 'local' | 'hosted'; state: string; host?: string; hostedRef?: Json }): {
    sessionId: string;
    participantId: string;
  } {
    const id = `s${this.nextId++}`;
    const s: Session = {
      id,
      kind: opts.kind ?? 'local',
      projectName: 'Basis',
      map: 'chernarus',
      hostedRef: opts.hostedRef,
      log: [],
      snapshots: new Map([[0, [[opts.state]]]]),
      participants: [],
      ver: { participants: 1, locks: 1, saving: 1 },
      saving: { state: 'saved', savedSeq: 0, unsavedCount: 0 },
      waiters: [],
    };
    this.sessions.set(id, s);
    const host = opts.host ?? 'Anna';
    const p = this.addParticipant(s, { userId: 'u-' + host.toLowerCase(), name: host }, 'studio');
    p.role = s.kind === 'local' ? 'host' : 'participant';
    p.canManage = true;
    p.canInvite = true;
    p.canSave = s.kind === 'hosted';
    p.visible = true;
    return { sessionId: id, participantId: p.participantId };
  }

  private addParticipant(s: Session, u: { userId: string; name: string }, kind: 'studio' | 'agent'): Participant {
    const used = new Set(s.participants.filter((p) => p.active).map((p) => p.colour));
    let colour = 1;
    while (used.has(colour)) colour++;
    const p: Participant = {
      participantId: `p${this.nextId++}`,
      userId: u.userId,
      name: u.name,
      kind,
      colour,
      role: s.kind === 'local' ? 'guest' : 'participant',
      canInvite: false,
      canSave: false,
      canManage: false,
      nextClientSeq: 1,
      lockSeq: 0,
      elements: new Set(),
      presence: {},
      notices: [],
      noticeVer: 0,
      staged: new Map(),
      chain: undefined,
      opIds: new Map(),
      active: true,
      visible: false,
    };
    s.participants.push(p);
    return p;
  }

  /** Appends an operation as another participant (a human editing in the game). */
  appendAs(sessionId: string, participantId: string, opId: string, text: string): number {
    const s = this.sessions.get(sessionId)!;
    const seq = s.log.length + 1;
    s.log.push({ seq, participantId, opId, parts: [[text]] });
    this.notify(s);
    return seq;
  }

  lockAs(sessionId: string, participantId: string, elements: string[]): void {
    const s = this.sessions.get(sessionId)!;
    const p = s.participants.find((x) => x.participantId === participantId)!;
    for (const o of s.participants) {
      if (o === p) continue;
      const taken = elements.filter((e) => o.elements.has(e));
      if (taken.length) {
        for (const e of taken) o.elements.delete(e);
        this.notice(o, { kind: 'locks_taken', by: p.name, count: taken.length });
      }
    }
    p.elements = new Set(elements);
    s.ver.locks++;
    this.notify(s);
  }

  endSession(sessionId: string, ended: Json): void {
    const s = this.sessions.get(sessionId)!;
    s.ended = ended;
    this.notify(s);
  }

  remove(sessionId: string, target: string, by: string): void {
    const s = this.sessions.get(sessionId)!;
    const p = s.participants.find((x) => x.participantId === target)!;
    p.active = false;
    p.removedBy = by;
    p.elements.clear();
    s.ver.participants++;
    s.ver.locks++;
    for (const o of s.participants) if (o.active) this.notice(o, { kind: 'participant_removed', participantId: target, name: p.name, by });
    this.notify(s);
  }

  save(sessionId: string, by: string): void {
    const s = this.sessions.get(sessionId)!;
    s.saving = {
      state: 'saved',
      savedSeq: s.log.length,
      unsavedCount: 0,
      savedBy: { userId: 'u-' + by.toLowerCase(), name: by },
      savedSecondsAgo: 0,
    };
    s.ver.saving++;
    this.notify(s);
  }

  askCheckpoint(sessionId: string, participantId: string): void {
    const s = this.sessions.get(sessionId)!;
    s.checkpointFrom = participantId;
    const p = s.participants.find((x) => x.participantId === participantId)! as Json;
    p.cpSent = false;
    this.notify(s);
  }

  private notice(p: Participant, n: Json): void {
    p.noticeVer++;
    p.notices.push({ version: p.noticeVer, n });
  }

  /** The full text of the operation at a sequence number. */
  opText(sessionId: string, seq: number): string {
    const s = this.sessions.get(sessionId)!;
    return s.log[seq - 1]!.parts.flat().join('');
  }

  private async handleUser(endpoint: string, req: Json, u: { userId: string; name: string }, signal?: AbortSignal): Promise<Json> {
    switch (endpoint) {
      case 'sessions/list':
        return {
          ok: true,
          sessions: [...this.sessions.values()]
            .filter((s) => !s.ended && (!req.hostedRef || JSON.stringify(s.hostedRef) === JSON.stringify(req.hostedRef)))
            .map((s) => ({
              sessionId: s.id,
              kind: s.kind,
              projectName: s.projectName,
              map: s.map,
              participants: s.participants.length,
              access: 'direct',
              hostedRef: s.hostedRef,
            })),
        };
      case 'project/list':
        return { ok: true, projects: this.projects, stores: [{ provider: 'fake', canCreate: true }] };
      case 'session/join':
        return this.join(req, u);
      case 'invite/redeem':
        return req.code === 'GOOD-CODE'
          ? { ok: true, sessionId: [...this.sessions.keys()][0], kind: 'local', projectName: 'Basis', map: 'chernarus' }
          : this.err('invite_invalid');
    }
    const s = this.session(req);
    if ('ok' in s) return s;
    const ss = s as Session;
    const m = this.member(ss, req);
    if ('ok' in m) return m;
    const p = m as Participant;
    switch (endpoint) {
      case 'snapshot/get': {
        const snap = ss.snapshots.get(req.seq);
        if (!snap) return this.err('snapshot_unknown');
        return { ok: true, seq: req.seq, part: req.part, parts: snap.length, pieces: snap[req.part] };
      }
      case 'snapshot/put': {
        if (ss.checkpointFrom !== p.participantId) return this.err('not_allowed');
        const parts = ss.snapshots.get(req.seq) ?? new Array(req.parts);
        parts[req.part] = req.pieces;
        ss.snapshots.set(req.seq, parts);
        const complete = parts.filter(Boolean).length === req.parts;
        if (complete) ss.checkpointFrom = undefined;
        return { ok: true, complete };
      }
      case 'ops/send':
        return this.opsSend(ss, p, req);
      case 'poll':
        return this.poll(ss, p, req, signal);
      case 'locks/set': {
        if (req.lockSeq <= p.lockSeq) return { ok: true, lockSeq: p.lockSeq, granted: [...p.elements], denied: [], version: ss.ver.locks };
        p.lockSeq = req.lockSeq;
        const granted: string[] = [];
        const denied: Json[] = [];
        for (const e of req.elements as string[]) {
          const holder = ss.participants.find((o) => o !== p && o.active && o.elements.has(e));
          if (holder) denied.push({ element: e, holder: holder.participantId });
          else granted.push(e);
        }
        p.elements = new Set(granted);
        ss.ver.locks++;
        this.notify(ss);
        return { ok: true, lockSeq: p.lockSeq, granted, denied, version: ss.ver.locks };
      }
      case 'session/leave':
        p.active = false;
        p.elements.clear();
        ss.ver.participants++;
        this.notify(ss);
        return { ok: true };
      case 'project/save':
      case 'session/end':
      case 'participant/remove':
      case 'locks/release':
      case 'invite/create':
        return p.kind === 'agent' ? this.err('not_allowed') : { ok: true };
    }
    return this.err('bad_request', { message: `unknown endpoint ${endpoint}` });
  }

  private join(req: Json, u: { userId: string; name: string }): Json {
    const s = this.sessions.get(req.sessionId);
    if (!s) return this.err('session_unknown');
    if (s.ended) return this.err('session_ended', s.ended);
    const kind = req.client?.kind === 'agent' && this.capabilities.includes('agents') ? 'agent' : 'studio';
    if (req.resume) {
      const p = s.participants.find((x) => x.participantId === req.resume.participantId);
      if (!p || !p.active)
        return this.err('not_participant', p?.removedBy ? { reason: 'removed', by: p.removedBy } : { reason: 'timeout' });
      return {
        ok: true,
        participantId: p.participantId,
        colour: p.colour,
        kind: s.kind,
        role: p.role,
        canInvite: p.canInvite,
        canSave: p.canSave,
        canManage: p.canManage,
        mode: 'resume',
        seq: s.log.length,
        capabilities: [],
      };
    }
    if (s.participants.some((x) => x.active && req.instanceKey && (x as Json).instanceKey === req.instanceKey))
      return this.err('instance_key_taken');
    const p = this.addParticipant(s, u, kind);
    (p as Json).instanceKey = req.instanceKey;
    const snapSeq = Math.max(...s.snapshots.keys());
    return {
      ok: true,
      participantId: p.participantId,
      colour: p.colour,
      kind: s.kind,
      role: p.role,
      canInvite: false,
      canSave: false,
      canManage: false,
      mode: 'snapshot',
      snapshot: { seq: snapSeq, parts: s.snapshots.get(snapSeq)!.length, bytes: 0 },
      seq: s.log.length,
      capabilities: this.capabilities.filter((c) => c === 'hosted' && s.kind === 'hosted'),
    };
  }

  private append(s: Session, p: Participant, opId: string, parts: string[][], chain?: { index: number; count: number }): number {
    const seq = s.log.length + 1;
    const e: Entry = { seq, participantId: p.participantId, opId, parts };
    if (chain) e.chain = chain;
    s.log.push(e);
    return seq;
  }

  /** Runs before the next ops/send is processed (to let someone else's operation land first). */
  beforeOpsSend?: () => void;

  private opsSend(s: Session, p: Participant, req: Json): Json {
    const hook = this.beforeOpsSend;
    this.beforeOpsSend = undefined;
    hook?.();
    const results: Json[] = [];
    for (const item of req.ops as Json[]) {
      if (item.clientSeq < p.nextClientSeq) {
        const seq = p.opIds.get(`${item.opId}/${item.chain?.index ?? 0}`);
        if (seq !== undefined && !results.some((r) => r.clientSeq === item.clientSeq)) results.push({ clientSeq: item.clientSeq, seq });
        continue;
      }
      if (item.clientSeq > p.nextClientSeq) {
        this.notify(s);
        return this.err('client_seq_gap', { expectedClientSeq: p.nextClientSeq });
      }
      const parts = item.parts ?? 1;
      const st = p.staged.get(item.clientSeq) ?? { parts: new Array(parts), opId: item.opId, chain: item.chain };
      st.parts[item.part ?? 0] = item.pieces;
      p.staged.set(item.clientSeq, st);
      if (st.parts.filter(Boolean).length < parts) continue;
      p.staged.delete(item.clientSeq);
      p.nextClientSeq++;
      const complete = st.parts as string[][];
      if (item.chain) {
        if (item.chain.index === 0) p.chain = { opId: item.opId, count: item.chain.count, links: [] };
        p.chain!.links.push({ clientSeq: item.clientSeq, parts: complete });
        if (item.chain.index === item.chain.count - 1) {
          p.chain!.links.forEach((l, index) => {
            const seq = this.append(s, p, item.opId, l.parts, { index, count: item.chain.count });
            p.opIds.set(`${item.opId}/${index}`, seq);
            results.push({ clientSeq: l.clientSeq, seq });
          });
          p.chain = undefined;
        }
        continue;
      }
      const seq = this.append(s, p, item.opId, complete);
      p.opIds.set(`${item.opId}/0`, seq);
      results.push({ clientSeq: item.clientSeq, seq });
    }
    this.notify(s);
    return { ok: true, results, nextClientSeq: p.nextClientSeq };
  }

  private async poll(s: Session, p: Participant, req: Json, signal?: AbortSignal): Promise<Json> {
    p.presence = { ...(req.presence ?? {}) };
    if (!p.visible) {
      p.visible = true;
      s.ver.participants++;
    }
    const v = req.versions ?? {};
    const ready = (): boolean =>
      !!s.ended ||
      !p.active ||
      s.log.length > req.after ||
      s.ver.participants > (v.participants ?? 0) ||
      s.ver.locks > (v.locks ?? 0) ||
      s.ver.saving > (v.saving ?? 0) ||
      p.noticeVer > (v.notices ?? 0) ||
      (s.checkpointFrom === p.participantId && !(p as Json).cpSent);
    const deadline = Date.now() + (req.waitMs ?? 5000);
    while (!ready() && Date.now() < deadline) {
      if (signal?.aborted) throw new UnreachableError('aborted');
      await new Promise<void>((resolve) => {
        const t = setTimeout(done, Math.max(1, deadline - Date.now()));
        const onAbort = (): void => done();
        signal?.addEventListener('abort', onAbort, { once: true });
        function done(): void {
          clearTimeout(t);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }
        s.waiters.push(done);
      });
    }
    if (signal?.aborted) throw new UnreachableError('aborted');
    if (s.ended) return this.err('session_ended', s.ended);
    if (!p.active)
      return p.removedBy
        ? this.err('not_participant', { reason: 'removed', by: p.removedBy })
        : this.err('not_participant', { reason: 'timeout' });
    const out: Json = { ok: true, seq: s.log.length, more: false, ops: [], presence: [] };
    for (const e of s.log.slice(req.after)) {
      e.parts.forEach((pieces, i) => {
        const o: Json = { seq: e.seq, participantId: e.participantId, opId: e.opId, pieces };
        if (e.parts.length > 1) {
          o.part = i;
          o.parts = e.parts.length;
        }
        if (e.chain) o.chain = e.chain;
        out.ops.push(o);
      });
    }
    const visible = s.participants.filter((x) => x.active && x.visible);
    if (s.ver.participants > (v.participants ?? 0)) {
      out.participants = {
        version: s.ver.participants,
        list: visible.map((x) => ({
          participantId: x.participantId,
          userId: x.userId,
          name: x.name,
          colour: x.colour,
          role: x.role,
          canInvite: x.canInvite,
          canSave: x.canSave,
          canManage: x.canManage,
          kind: x.kind,
        })),
      };
    }
    out.presence = visible.map((x) => {
      const pr: Json = { participantId: x.participantId, state: 'active', idleSeconds: x.presence.idleSeconds ?? 0, lastSeenSeconds: 0 };
      if (x.presence.position) pr.position = x.presence.position;
      if (x.kind === 'agent') {
        pr.phase = x.presence.phase ?? 'waiting';
        pr.status = x.presence.status ?? '';
      }
      return pr;
    });
    if (s.ver.saving > (v.saving ?? 0)) out.saving = { version: s.ver.saving, ...s.saving };
    if (s.ver.locks > (v.locks ?? 0)) {
      out.locks = {
        version: s.ver.locks,
        holders: s.participants
          .filter((x) => x.active && x.elements.size)
          .map((x) => ({ participantId: x.participantId, lapsed: false, elements: [...x.elements] })),
      };
    }
    if (p.noticeVer > (v.notices ?? 0))
      out.notices = { version: p.noticeVer, list: p.notices.filter((n) => n.version > (v.notices ?? 0)).map((n) => n.n) };
    if (s.checkpointFrom === p.participantId) {
      out.checkpointWanted = true;
      (p as Json).cpSent = true;
    }
    return out;
  }
}
