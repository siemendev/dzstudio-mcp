import type { ConfigStore, Credential, ServerEntry } from '../config/config.js';
import { agentClient, CollabClient, type ServerInfo } from '../protocol/client.js';
import {
  CollabSession,
  displayName,
  STATUS_MAX_BYTES,
  type Phase,
  type SessionEvent,
  type StepResult,
  type Timing,
} from '../protocol/session.js';
import { CollabError, HttpTransport, UnreachableError, type Json, type Transport } from '../protocol/transport.js';
import { BuildError, normalizeAngle, OpBuilder, type Vec3 } from '../scene/edits.js';
import { readFloat32, readVec3, writeFloat32, writeVec3 } from '../scene/float32.js';
import { PROJECT_ID } from '../scene/ids.js';
import type { Scene } from '../scene/scene.js';
import type { Element, Operation } from '../scene/textform.js';

export const MAX_HELD = 20_000;
export const PAGE_SIZE = 500;
export const IDLE_LEAVE_MS = 30 * 60_000;
const GROUP_COLOURS = ['#60A5FA', '#F87171', '#34D399', '#FBBF24', '#A78BFA', '#F472B6', '#22D3EE', '#FB923C'];

/** A failure the agent should read: the message is the tool result. */
export class ToolError extends Error {}

export interface ToolResult {
  text: string;
  data?: unknown;
}

export interface AgentOptions {
  store: ConfigStore;
  transport?: (url: string) => Transport;
  timing?: Partial<Timing>;
  idleLeaveMs?: number;
  /** How long `login` waits for the confirmation on its second call. */
  loginWaitMs?: number;
}

interface SessionRecord {
  handle: string;
  server: string;
  sessionId: string;
  projectName: string;
  map: string;
  collab: CollabSession | undefined;
  idleLeft: boolean;
  lastWorkMs: number;
}

interface PendingLogin {
  loginCode: string;
  url: string;
  expiresAt: number;
  intervalMs: number;
}

export interface GroupSpec {
  ref: string;
  name: string;
  color?: string;
}

export interface ObjectSpec {
  class: string;
  group: string;
  position: Vec3;
  orientation?: Vec3;
  scale?: number;
}

export interface ObjectChange {
  id: string;
  position?: Vec3;
  orientation?: Vec3;
  scale?: number;
  group?: string;
  hidden?: boolean;
  locked?: boolean;
  name?: string;
  color?: string;
  persist?: boolean;
  customString?: string;
}

export interface ObjectQuery {
  ids?: string[];
  group?: string;
  class?: string;
  near?: { x: number; z: number; radius: number };
  rect?: { minX: number; minZ: number; maxX: number; maxZ: number };
  page?: number;
}

export interface ProjectObject {
  id: string;
  class: string;
  position: Vec3;
  orientation: Vec3;
  scale: number;
}

export interface SessionWorld {
  /** Stable key of the session: server and session id. */
  key: string;
  handle: string;
  map: string;
  objects: ProjectObject[];
}

const PHASE_TEXT: Record<Phase, string> = { waiting: 'waiting for work', working: 'working', review: 'waiting for review' };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function validateStatus(status: string): void {
  if (/[\r\n]/.test(status) || /[\u0000-\u001f\u007f]/.test(status)) throw new ToolError('Status must be one line');
  if (Buffer.byteLength(status, 'utf8') > STATUS_MAX_BYTES) throw new ToolError('Status too long (at most 200 bytes)');
}

/** A float32 as the JSON number of its shortest text, so 1234.5679 does not show as 1234.56787109375. */
function f32(x: number): number {
  return Number(writeFloat32(x));
}

function vec(text: string | undefined): Vec3 | string | undefined {
  if (text === undefined) return undefined;
  try {
    return readVec3(text).map(f32) as Vec3;
  } catch {
    return text;
  }
}

function num(text: string | undefined): number | string | undefined {
  if (text === undefined) return undefined;
  try {
    return f32(readFloat32(text));
  } catch {
    return text;
  }
}

/**
 * Everything the tools do, without the MCP wiring: servers and logins, the sessions the agent is in, and the edits
 * it makes in them.
 */
export class Agent {
  readonly sessions = new Map<string, SessionRecord>();
  current: string | undefined;
  private nextHandle = 1;
  private logins = new Map<string, PendingLogin>();
  private infos = new Map<string, { info: ServerInfo; at: number }>();
  private agentEvents: string[] = [];
  private idleTimer: NodeJS.Timeout;

  constructor(readonly opts: AgentOptions) {
    this.idleTimer = setInterval(() => void this.leaveIdle(), 60_000);
    this.idleTimer.unref();
  }

  private get store(): ConfigStore {
    return this.opts.store;
  }

  private client(server: ServerEntry): CollabClient {
    return new CollabClient(this.opts.transport ? this.opts.transport(server.url) : new HttpTransport(server.url));
  }

  private credential(server: ServerEntry): Credential {
    const c = this.store.credential(server.name);
    if (!c) throw new ToolError(`Not signed in to ${server.name} — call login`);
    return c;
  }

  private async info(server: ServerEntry, fresh = false): Promise<ServerInfo> {
    const cached = this.infos.get(server.name);
    if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.info;
    try {
      const info = await this.client(server).info();
      this.infos.set(server.name, { info, at: Date.now() });
      return info;
    } catch (e) {
      throw new ToolError(e instanceof UnreachableError ? 'Server not reachable' : (e as Error).message);
    }
  }

  /** Runs a request that needs the login; a rejected token drops the stored one. */
  private async authed<T>(server: ServerEntry, fn: (client: CollabClient, token: string) => Promise<T>): Promise<T> {
    const cred = this.credential(server);
    try {
      return await fn(this.client(server), cred.token);
    } catch (e) {
      if (e instanceof CollabError && ['token_invalid', 'token_expired', 'auth_required'].includes(e.code)) {
        this.store.setCredential(server.name, undefined);
        throw new ToolError(`Not signed in to ${server.name} — call login`);
      }
      if (e instanceof UnreachableError) throw new ToolError('Server not reachable');
      throw e;
    }
  }

  close(): void {
    clearInterval(this.idleTimer);
  }

  async shutdown(): Promise<void> {
    this.close();
    for (const r of this.sessions.values()) await r.collab?.leave();
  }

  // ------------------------------------------------------------ events

  /** Events since the last result, of every session; applies what they mean for the phase. */
  collectEvents(): string[] {
    const out = this.agentEvents.splice(0);
    for (const r of this.sessions.values()) {
      const c = r.collab;
      if (!c) continue;
      for (const e of c.drainEvents()) {
        this.onEvent(r, c, e);
        out.push(`[${r.handle}] ${e.text}`);
      }
    }
    return out;
  }

  private onEvent(r: SessionRecord, c: CollabSession, e: SessionEvent): void {
    if (e.kind === 'saved' && c.phase === 'review' && Number(e.data?.savedSeq) >= c.lastOwnSeq) c.setPhase('waiting', '');
    if (e.kind === 'ended' || e.kind === 'removed') {
      this.sessions.delete(r.handle);
      if (this.current === r.handle) this.current = undefined;
    }
  }

  async waitEvents(handle: string | undefined, ms: number): Promise<string[]> {
    const first = this.collectEvents();
    if (first.length || ms <= 0) return first;
    const records = handle ? [this.record(handle)] : [...this.sessions.values()];
    const live = records.map((r) => r.collab).filter((c): c is CollabSession => !!c);
    if (!live.length) return [];
    await Promise.race(live.map((c) => c.waitForEvents(ms)));
    return this.collectEvents();
  }

  // ------------------------------------------------------------ servers and login

  async listServers(): Promise<ToolResult> {
    const servers = this.store.load().servers;
    const rows = await Promise.all(
      servers.map(async (s) => {
        const cred = this.store.credential(s.name);
        const row: Json = { name: s.name, url: s.url, signedIn: !!cred };
        if (cred) row.signedInAs = cred.name;
        try {
          const info = await this.info(s, true);
          row.agents = info.capabilities.includes('agents');
          row.reachable = true;
        } catch {
          row.reachable = false;
        }
        return row;
      }),
    );
    return { text: rows.length ? `${plural(rows.length, 'server')}` : 'No server configured — call add_server', data: { servers: rows } };
  }

  async addServer(name: string, url: string): Promise<ToolResult> {
    if (this.store.load().servers.some((s) => s.name === name)) throw new ToolError(`A server named ${name} already exists`);
    const entry = { name, url };
    let info: ServerInfo;
    try {
      info = await this.client(entry).info();
    } catch {
      throw new ToolError('Server not reachable');
    }
    let saved: ServerEntry;
    try {
      saved = this.store.addServer(name, url);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    this.infos.set(name, { info, at: Date.now() });
    const agents = info.capabilities.includes('agents');
    return {
      text: `Added ${name} (${info.name})${agents ? '' : ' — this server knows no agents yet; joining its sessions is not possible'}`,
      data: { name, url: saved.url, serverName: info.name, agents, login: info.auth.map((a) => a.method) },
    };
  }

  async login(serverName: string | undefined, displayName?: string): Promise<ToolResult> {
    const server = this.resolveServer(serverName);
    const info = await this.info(server, true);
    const client = this.client(server);
    const methods = info.auth.map((a) => a.method);
    if (!methods.includes('code') || !info.capabilities.includes('auth.code')) {
      if (methods.includes('name') && displayName) {
        const res = await client.nameLogin(displayName, agentClient(this.store.load().agentName));
        this.store.setCredential(server.name, { token: res.token, name: res.name });
        return { text: `Signed in to ${server.name} as ${res.name}` };
      }
      if (methods.includes('name')) throw new ToolError(`${server.name} only offers login by name — call login with a name`);
      throw new ToolError(`${server.name} offers no login this MCP can use (code login is needed)`);
    }
    const pending = this.logins.get(server.name);
    if (!pending || pending.expiresAt <= Date.now()) {
      const start = await client.codeStart(agentClient(this.store.load().agentName));
      this.logins.set(server.name, {
        loginCode: start.loginCode,
        url: start.url,
        expiresAt: Date.now() + start.expiresInSeconds * 1000,
        intervalMs: start.intervalSeconds * 1000,
      });
      const code = start.loginCode.length === 8 ? `${start.loginCode.slice(0, 4)}-${start.loginCode.slice(4)}` : start.loginCode;
      return {
        text: `Ask the user to open ${start.url} and confirm the code ${code}. Then call login again to finish.`,
        data: { code, url: start.url, expiresInSeconds: start.expiresInSeconds },
      };
    }
    const deadline = Math.min(pending.expiresAt, Date.now() + (this.opts.loginWaitMs ?? 60_000));
    for (;;) {
      const st = await client.codePoll(pending.loginCode);
      if (st.state === 'confirmed') {
        this.logins.delete(server.name);
        const cred: Credential = { token: st.token, name: st.name };
        if (st.expiresInSeconds !== undefined) cred.expiresAt = Date.now() + st.expiresInSeconds * 1000;
        this.store.setCredential(server.name, cred);
        return { text: `Signed in as ${st.name}` };
      }
      if (st.state === 'expired') {
        this.logins.delete(server.name);
        throw new ToolError('Code expired');
      }
      if (st.state === 'denied') {
        this.logins.delete(server.name);
        throw new ToolError('Sign-in denied');
      }
      if (Date.now() + pending.intervalMs > deadline) break;
      await new Promise((r) => setTimeout(r, pending.intervalMs));
    }
    return { text: `Still waiting for the confirmation at ${pending.url} — call login again after the user confirmed` };
  }

  private resolveServer(name: string | undefined): ServerEntry {
    try {
      return this.store.server(name);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
  }

  // ------------------------------------------------------------ projects and sessions

  async listProjects(serverName: string | undefined): Promise<ToolResult> {
    const server = this.resolveServer(serverName);
    const info = await this.info(server);
    return this.authed(server, async (client, token) => {
      const sessions = await client.sessionsList(token);
      const projects = info.capabilities.includes('hosted') ? (await client.projectList(token)).projects : [];
      return {
        text: `${plural(projects.length, 'project')}, ${plural(sessions.length, 'session')} to join on ${server.name}`,
        data: {
          projects: projects.map((p) => ({
            key: p.hostedRef?.key,
            name: p.projectName,
            map: p.map,
            sessionRunning: typeof p.sessionId === 'string',
            canSave: !!p.canSave,
          })),
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            kind: s.kind,
            project: s.projectName,
            map: s.map,
            host: s.host?.name,
            participants: s.participants,
            access: s.access,
          })),
        },
      };
    });
  }

  async openProject(serverName: string | undefined, project: string): Promise<ToolResult> {
    const server = this.resolveServer(serverName);
    const info = await this.info(server);
    if (!info.capabilities.includes('hosted')) throw new ToolError(`${server.name} has no projects on the server`);
    const sessionId = await this.authed(server, async (client, token) => {
      const { projects } = await client.projectList(token);
      const want = project.toLowerCase();
      const p = projects.find((x) => x.hostedRef?.key === project) ?? projects.find((x) => String(x.projectName).toLowerCase() === want);
      if (!p) throw new ToolError(`No project ${project} on ${server.name}`);
      if (typeof p.sessionId === 'string') return p.sessionId;
      const running = await client.sessionsList(token, p.hostedRef);
      if (running[0]) return running[0].sessionId as string;
      throw new ToolError(`No session is running for ${p.projectName}. A person has to open it in dzStudio first.`);
    });
    return this.joinSession(server.name, sessionId);
  }

  async joinSession(serverName: string | undefined, sessionId?: string, code?: string): Promise<ToolResult> {
    const server = this.resolveServer(serverName);
    const info = await this.info(server, true);
    if (!info.capabilities.includes('agents')) throw new ToolError('Server knows no agents');
    const cred = this.credential(server);
    let target = sessionId;
    if (code) {
      const res = await this.authed(server, (client, token) => client.inviteRedeem(token, code)).catch((e) => {
        if (e instanceof CollabError)
          throw new ToolError(
            e.code === 'invite_invalid' || e.code === 'invite_used'
              ? 'This code is not valid (any more) — ask for a new one'
              : `Cannot join: ${e.message}`,
          );
        throw e;
      });
      target = res.sessionId;
    }
    if (!target) throw new ToolError('Name a session id or an invitation code');
    for (const r of this.sessions.values()) {
      if (r.server === server.name && r.sessionId === target && r.collab?.active) {
        this.current = r.handle;
        return { text: `Already in this session as ${r.handle}`, data: this.sessionRow(r) };
      }
    }
    const listed = await this.authed(server, (client, token) => client.sessionsList(token)).catch(() => [] as Json[]);
    const meta = listed.find((s) => s.sessionId === target);
    const handle = `s${this.nextHandle++}`;
    const rec: SessionRecord = {
      handle,
      server: server.name,
      sessionId: target,
      projectName: meta?.projectName ?? '',
      map: meta?.map ?? '',
      collab: undefined,
      idleLeft: false,
      lastWorkMs: Date.now(),
    };
    rec.collab = await this.connect(server, rec, cred);
    this.sessions.set(handle, rec);
    this.current = handle;
    return { text: `Joined ${rec.projectName || target} as ${handle}; it is the current session`, data: this.sessionRow(rec) };
  }

  private async connect(server: ServerEntry, rec: SessionRecord, cred: Credential): Promise<CollabSession> {
    try {
      const opts = {
        client: this.client(server),
        token: () => this.store.credential(server.name)?.token ?? cred.token,
        clientInfo: agentClient(this.store.load().agentName),
        position: () => this.position(rec),
        ...(this.opts.timing ? { timing: this.opts.timing } : {}),
      };
      return await CollabSession.join(opts, rec.sessionId);
    } catch (e) {
      if (e instanceof CollabError) {
        if (['token_invalid', 'token_expired', 'auth_required'].includes(e.code)) {
          this.store.setCredential(server.name, undefined);
          throw new ToolError(`Not signed in to ${server.name} — call login`);
        }
        if (e.code === 'session_unknown' || e.code === 'session_ended') throw new ToolError('This session is already over');
        if (e.code === 'session_full') throw new ToolError('Session is full');
        throw new ToolError(`Cannot join: ${e.error.message ?? e.code}`);
      }
      if (e instanceof UnreachableError) throw new ToolError('Server not reachable');
      throw e;
    }
  }

  private position(rec: SessionRecord): [number, number, number] | undefined {
    const c = rec.collab;
    if (!c) return undefined;
    const ids = c.held.size ? [...c.held] : c.lastTouched;
    return c.view((scene) => {
      let min: Vec3 | undefined;
      let max: Vec3 | undefined;
      for (const id of ids) {
        const p = vec(scene.get(id)?.fields.get('pos'));
        if (!Array.isArray(p)) continue;
        min = min ? [Math.min(min[0], p[0]), Math.min(min[1], p[1]), Math.min(min[2], p[2])] : [...p];
        max = max ? [Math.max(max[0], p[0]), Math.max(max[1], p[1]), Math.max(max[2], p[2])] : [...p];
      }
      if (!min || !max) return undefined;
      return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2].map((v) => Math.fround(v)) as Vec3;
    });
  }

  private record(handle: string | undefined): SessionRecord {
    const h = handle ?? this.current;
    if (!h) throw new ToolError('Not in a session');
    const r = this.sessions.get(h) ?? [...this.sessions.values()].find((x) => x.sessionId === h);
    if (!r) throw new ToolError(`Not in a session ${h}`);
    return r;
  }

  /** The session for a tool that works in it; rejoins one the agent left while idle. */
  private async live(handle: string | undefined, work = true): Promise<{ r: SessionRecord; c: CollabSession }> {
    const r = this.record(handle);
    if (r.idleLeft) {
      const server = this.resolveServer(r.server);
      r.collab = await this.connect(server, r, this.credential(server));
      r.idleLeft = false;
      this.agentEvents.push(`[${r.handle}] Joined again after leaving while idle`);
    }
    const c = r.collab;
    if (!c || !c.active) {
      const text = c?.stateText || 'Not in a session';
      this.sessions.delete(r.handle);
      if (this.current === r.handle) this.current = undefined;
      throw new ToolError(text);
    }
    if (work) r.lastWorkMs = Date.now();
    return { r, c };
  }

  private async leaveIdle(): Promise<void> {
    const limit = this.opts.idleLeaveMs ?? IDLE_LEAVE_MS;
    for (const r of this.sessions.values()) {
      const c = r.collab;
      if (!c || r.idleLeft || !c.active || c.phase !== 'waiting') continue;
      if (Date.now() - r.lastWorkMs < limit) continue;
      await c.leave();
      r.idleLeft = true;
      this.agentEvents.push(`[${r.handle}] Left after ${Math.round(limit / 60_000)} minutes without work; joins again on the next task`);
    }
  }

  /** Exposed for tests: run the idle check now. */
  checkIdle(): Promise<void> {
    return this.leaveIdle();
  }

  private sessionRow(r: SessionRecord): Json {
    const c = r.collab;
    return {
      session: r.handle,
      sessionId: r.sessionId,
      server: r.server,
      project: r.projectName,
      map: r.map,
      kind: c?.kind,
      phase: c ? PHASE_TEXT[c.phase] : undefined,
      status: c?.status,
      current: this.current === r.handle,
      state: r.idleLeft ? 'left while idle' : c?.state,
    };
  }

  listSessions(): ToolResult {
    const rows = [...this.sessions.values()].map((r) => this.sessionRow(r));
    return { text: rows.length ? plural(rows.length, 'session') : 'Not in any session', data: { sessions: rows } };
  }

  switchSession(handle: string): ToolResult {
    const r = this.record(handle);
    this.current = r.handle;
    return { text: `Current session: ${r.handle}`, data: this.sessionRow(r) };
  }

  async leaveSession(handle: string | undefined, confirm: boolean): Promise<ToolResult> {
    const r = this.record(handle);
    const c = r.collab;
    if (c && c.active) {
      const open = await c.flush(10_000);
      if (open && !confirm)
        throw new ToolError(`${plural(open, 'change')} did not reach the server — call leave_session with confirm to leave anyway`);
      await c.leave();
    }
    this.sessions.delete(r.handle);
    if (this.current === r.handle) this.current = undefined;
    return { text: `Left ${r.handle}` };
  }

  async sessionInfo(handle: string | undefined): Promise<ToolResult> {
    const { r, c } = await this.live(handle, false);
    const pres = new Map(c.presence.map((p) => [p.participantId, p]));
    const held = new Map(c.lockHolders.map((h) => [h.participantId, (h.elements ?? []).length]));
    const participants = c.participants.map((p) => {
      const pr = pres.get(p.participantId) ?? {};
      const row: Json = {
        name: displayName(p),
        kind: p.kind === 'agent' ? 'agent' : 'human',
        you: p.participantId === c.participantId,
        colour: p.colour,
        role: p.role,
        state: pr.state,
        held: held.get(p.participantId) ?? 0,
      };
      if (pr.position) row.location = pr.position;
      if (p.kind === 'agent') {
        row.phase = PHASE_TEXT[(pr.phase as Phase) ?? 'waiting'] ?? pr.phase;
        if (pr.status) row.status = pr.status;
      }
      return row;
    });
    const s = c.saving;
    const saving: Json = {};
    if (s) {
      saving.state = s.state;
      if (s.unsavedCount !== undefined) saving.unsavedChanges = s.unsavedCount;
      if (s.savedBy) saving.lastSavedBy = s.savedBy.name;
      if (s.savedSecondsAgo !== undefined) saving.savedSecondsAgo = s.savedSecondsAgo;
    }
    return {
      text: `${r.projectName || r.sessionId}: ${plural(participants.length, 'participant')}, you are ${PHASE_TEXT[c.phase]}`,
      data: {
        ...this.sessionRow(r),
        participants,
        rights: { canSave: c.rights.canSave, canManage: c.rights.canManage, canInvite: c.rights.canInvite },
        selection: c.selection.size,
        saving,
      },
    };
  }

  // ------------------------------------------------------------ reading the scene

  async readScene(handle: string | undefined): Promise<ToolResult> {
    const { r, c } = await this.live(handle, false);
    return c.view((scene) => {
      const project = scene.get(PROJECT_ID);
      const groups = scene
        .children(PROJECT_ID)
        .map((id) => scene.get(id)!)
        .filter((g) => g.kind === 'core:group')
        .map((g) => {
          let min: [number, number] | undefined;
          let max: [number, number] | undefined;
          const kids = scene.children(g.id);
          for (const k of kids) {
            const p = vec(scene.get(k)?.fields.get('pos'));
            if (!Array.isArray(p)) continue;
            min = min ? [Math.min(min[0], p[0]), Math.min(min[1], p[2])] : [p[0], p[2]];
            max = max ? [Math.max(max[0], p[0]), Math.max(max[1], p[2])] : [p[0], p[2]];
          }
          const row: Json = {
            id: g.id,
            name: g.fields.get('name') ?? '',
            color: g.fields.get('color'),
            objects: kids.length,
            hidden: g.hidden,
            locked: g.locked,
          };
          if (g.fields.get('unreadable') === '1') row.unreadable = true;
          if (min && max) row.bounds = { minX: f32(min[0]), minZ: f32(min[1]), maxX: f32(max[0]), maxZ: f32(max[1]) };
          return row;
        });
      const objects = groups.reduce((n, g) => n + (g.objects as number), 0);
      return {
        text: `${r.projectName || 'Project'} on ${r.map || 'unknown map'}: ${plural(groups.length, 'group')}, ${plural(objects, 'object')}`,
        data: { project: r.projectName, map: r.map, loot: project?.fields.get('lootEnabled') === 'true', groups, objects },
      };
    });
  }

  private holderNames(c: CollabSession): Map<string, string> {
    const byPid = new Map(c.participants.map((p) => [p.participantId, displayName(p)]));
    const out = new Map<string, string>();
    for (const h of c.lockHolders) {
      if (h.participantId === c.participantId) continue;
      for (const el of h.elements ?? []) out.set(el, byPid.get(h.participantId) ?? h.participantId);
    }
    return out;
  }

  private objectRow(scene: Scene, el: Element, holders: Map<string, string>, mine: Set<string>): Json {
    const row: Json = {
      id: el.id,
      class: el.fields.get('name') ?? '',
      group: el.parent,
      position: vec(el.fields.get('pos')),
      orientation: vec(el.fields.get('ypr')),
      scale: num(el.fields.get('scale')),
      hidden: el.hidden,
      locked: el.locked,
    };
    if (el.fields.get('persist') === '1') row.persist = true;
    const cs = el.fields.get('customString');
    if (cs) row.customString = cs;
    if (mine.has(el.id)) row.heldBy = 'you';
    else if (holders.has(el.id)) row.heldBy = holders.get(el.id);
    return row;
  }

  async queryObjects(handle: string | undefined, q: ObjectQuery): Promise<ToolResult> {
    const { c } = await this.live(handle, false);
    const holders = this.holderNames(c);
    return c.view((scene) => {
      const out: Json[] = [];
      const wantClass = q.class?.toLowerCase();
      const candidates = q.ids?.length
        ? q.ids.map((id) => scene.get(id)).filter((e): e is Element => !!e && e.kind === 'core:object')
        : [...scene.walk()].filter((e) => e.kind === 'core:object');
      const group = q.group ? this.findGroup(scene, q.group) : undefined;
      for (const el of candidates) {
        if (group && el.parent !== group) continue;
        if (wantClass && (el.fields.get('name') ?? '').toLowerCase() !== wantClass) continue;
        if (q.near || q.rect) {
          const p = vec(el.fields.get('pos'));
          if (!Array.isArray(p)) continue;
          if (q.near && Math.hypot(p[0] - q.near.x, p[2] - q.near.z) > q.near.radius) continue;
          if (q.rect && (p[0] < q.rect.minX || p[0] > q.rect.maxX || p[2] < q.rect.minZ || p[2] > q.rect.maxZ)) continue;
        }
        out.push(this.objectRow(scene, el, holders, c.selection));
      }
      const page = Math.max(0, Math.floor(q.page ?? 0));
      const slice = out.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
      const data: Json = { total: out.length, page, objects: slice };
      if ((page + 1) * PAGE_SIZE < out.length) data.nextPage = page + 1;
      const missing = q.ids?.filter((id) => !scene.get(id));
      if (missing?.length) data.notFound = missing;
      return {
        text: `${plural(out.length, 'object')}${data.nextPage !== undefined ? `, page ${page + 1} of ${Math.ceil(out.length / PAGE_SIZE)}` : ''}`,
        data,
      };
    });
  }

  /** A group by id or by its (unique) name. */
  private findGroup(scene: Scene, ref: string): string {
    const el = scene.get(ref);
    if (el?.kind === 'core:group') return ref;
    const byName = scene
      .children(PROJECT_ID)
      .map((id) => scene.get(id)!)
      .filter((g) => g.kind === 'core:group' && g.fields.get('name') === ref);
    if (byName.length === 1) return byName[0]!.id;
    if (byName.length > 1) throw new ToolError(`Several groups are called ${ref} — use the group id`);
    throw new ToolError(`No group ${ref}`);
  }

  /** Map key and objects of a session for the world tools; undefined when no session is named and none is current. */
  async sessionWorld(handle: string | undefined): Promise<SessionWorld | undefined> {
    if (handle === undefined && !this.current) return undefined;
    const { r, c } = await this.live(handle, false);
    const objects = c.view((scene) => {
      const out: ProjectObject[] = [];
      for (const el of scene.walk()) {
        if (el.kind !== 'core:object') continue;
        const pos = vec(el.fields.get('pos'));
        if (!Array.isArray(pos)) continue;
        const ypr = vec(el.fields.get('ypr'));
        const scale = num(el.fields.get('scale'));
        out.push({
          id: el.id,
          class: el.fields.get('name') ?? '',
          position: pos,
          orientation: Array.isArray(ypr) ? ypr : [0, 0, 0],
          scale: typeof scale === 'number' && scale > 0 ? scale : 1,
        });
      }
      return out;
    });
    return { key: `${r.server}/${r.sessionId}`, handle: r.handle, map: r.map, objects };
  }

  // ------------------------------------------------------------ changing the scene

  private author(r: SessionRecord): { author: string; authorName: string } {
    const server = this.resolveServer(r.server);
    return { author: this.store.load().installationId, authorName: this.credential(server).name };
  }

  private checkConnection(c: CollabSession): void {
    if (c.interruptedMs >= 3000) throw new ToolError('Connection interrupted — try again when it is back');
  }

  /** Locks the existing objects a step changes and the new ones it creates; changes nothing if one is denied. */
  private async lockFor(c: CollabSession, existing: string[], created: string[]): Promise<void> {
    const before = [...c.selection];
    const want = new Set([...before, ...existing, ...created]);
    if (want.size > MAX_HELD) throw new ToolError('At most 20,000 objects can be edited at once');
    const needed = new Set(existing);
    if (existing.every((id) => c.selection.has(id) && c.held.has(id)) && created.length === 0) return;
    const res = await c.setLocks([...want]);
    const denied = res.denied.filter((d) => needed.has(d.element));
    if (!denied.length) return;
    await c.setLocks(before.filter((id) => !denied.some((d) => d.element === id)));
    const byPid = new Map(c.participants.map((p) => [p.participantId, displayName(p)]));
    const counts = new Map<string, number>();
    for (const d of denied) {
      const who = d.holder ? (byPid.get(d.holder) ?? d.holder) : 'nobody (the session holds the most locks it can)';
      counts.set(who, (counts.get(who) ?? 0) + 1);
    }
    throw new ToolError(
      [...counts].map(([who, n]) => `${plural(n, 'object')} ${n === 1 ? 'is' : 'are'} being edited by ${who}`).join('; '),
    );
  }

  /** Builds one operation on the scene with the own unconfirmed steps on top; the scene is unchanged afterwards. */
  private build(c: CollabSession, b: OpBuilder, fn: (scene: Scene) => void): Operation {
    try {
      return c.view((scene) => {
        try {
          fn(scene);
          return b.finish();
        } catch (e) {
          b.abort();
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof BuildError) throw new ToolError(e.message);
      throw e;
    }
  }

  private stepText(res: StepResult, opId: string): string {
    switch (res.status) {
      case 'applied':
        return `Done in one step (${opId})`;
      case 'unconfirmed':
        return `Sent (${opId}); not confirmed yet — the outcome arrives in session_events`;
      case 'dropped':
      case 'rejected':
        throw new ToolError(res.message);
    }
  }

  async createObjects(handle: string | undefined, groups: GroupSpec[], objects: ObjectSpec[]): Promise<ToolResult> {
    const { r, c } = await this.live(handle);
    this.checkConnection(c);
    if (!groups.length && !objects.length) throw new ToolError('Nothing to create');
    const type = groups.length ? 'projects:edit' : 'placement:edit';
    const b = new OpBuilder(c.scene, type, this.author(r));
    const createdObjects: string[] = [];
    const refs = new Map<string, string>();
    const op = this.build(c, b, (scene) => {
      const fileNames = new Set(
        scene
          .children(PROJECT_ID)
          .map((id) => scene.get(id)!.fields.get('file'))
          .filter((f): f is string => !!f),
      );
      groups.forEach((g, i) => {
        if (refs.has(g.ref)) throw new ToolError(`Group ref ${g.ref} is used twice`);
        const color = (g.color ?? GROUP_COLOURS[(scene.childCount(PROJECT_ID) + i) % GROUP_COLOURS.length]!).toUpperCase();
        if (!/^#[0-9A-F]{6}$/.test(color)) throw new ToolError(`Colour must be #RRGGBB: ${g.color}`);
        const base =
          g.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '') || 'group';
        let file = `${base}.json`;
        for (let n = 2; fileNames.has(file); n++) file = `${base}-${n}.json`;
        fileNames.add(file);
        refs.set(g.ref, b.createGroup({ name: g.name, color, file }));
      });
      for (const o of objects) {
        const group = refs.get(o.group) ?? this.findGroup(scene, o.group);
        const spec: Parameters<OpBuilder['createObject']>[0] = { group, name: o.class, pos: o.position };
        if (o.orientation) spec.ypr = o.orientation;
        if (o.scale !== undefined) spec.scale = o.scale;
        createdObjects.push(b.createObject(spec));
      }
    });
    await this.lockFor(c, [], createdObjects);
    const res = await c.submit(op);
    c.lastTouched = createdObjects;
    const text = this.stepText(res, op.id);
    return {
      text: `${text}: ${plural(groups.length, 'group')}, ${plural(createdObjects.length, 'object')}`,
      data: { step: op.id, groups: Object.fromEntries(refs), objects: createdObjects },
    };
  }

  async modifyObjects(handle: string | undefined, changes: ObjectChange[]): Promise<ToolResult> {
    const { r, c } = await this.live(handle);
    this.checkConnection(c);
    if (!changes.length) throw new ToolError('Nothing to change');
    const structural = changes.some(
      (ch) =>
        ch.group !== undefined || ch.hidden !== undefined || ch.locked !== undefined || ch.name !== undefined || ch.color !== undefined,
    );
    const b = new OpBuilder(c.scene, structural ? 'projects:edit' : 'properties:edit', this.author(r));
    const objects: string[] = [];
    const op = this.build(c, b, (scene) => {
      for (const ch of changes) {
        const el = scene.get(ch.id);
        if (!el) throw new ToolError(`No object or group ${ch.id}`);
        if (el.kind === 'core:group') {
          if (
            ch.position ||
            ch.orientation ||
            ch.scale !== undefined ||
            ch.group ||
            ch.persist !== undefined ||
            ch.customString !== undefined
          ) {
            throw new ToolError(`${ch.id} is a group: only name, color, hidden and locked can change`);
          }
          if (ch.name !== undefined) b.setField(ch.id, 'name', ch.name);
          if (ch.color !== undefined) {
            const color = ch.color.toUpperCase();
            if (!/^#[0-9A-F]{6}$/.test(color)) throw new ToolError(`Colour must be #RRGGBB: ${ch.color}`);
            b.setField(ch.id, 'color', color);
          }
        } else if (el.kind === 'core:object') {
          if (ch.name !== undefined || ch.color !== undefined)
            throw new ToolError(`${ch.id} is an object: name and color belong to groups`);
          objects.push(ch.id);
          if (ch.position) b.setField(ch.id, 'pos', writeVec3(ch.position));
          if (ch.orientation) b.setField(ch.id, 'ypr', writeVec3(ch.orientation.map(normalizeAngle) as Vec3));
          if (ch.scale !== undefined) b.setField(ch.id, 'scale', writeFloat32(ch.scale));
          if (ch.persist !== undefined) b.setField(ch.id, 'persist', ch.persist ? '1' : '0');
          if (ch.customString !== undefined) b.setField(ch.id, 'customString', ch.customString);
          if (ch.group !== undefined) b.move(ch.id, this.findGroup(scene, ch.group));
        } else {
          throw new ToolError(`${ch.id} cannot be changed by an agent`);
        }
        if (ch.hidden !== undefined) b.setFlag(ch.id, 'hidden', ch.hidden);
        if (ch.locked !== undefined) b.setFlag(ch.id, 'locked', ch.locked);
      }
    });
    if (!op.changes.length) return { text: 'Nothing changed: every value is already as asked' };
    await this.lockFor(c, objects, []);
    const res = await c.submit(op);
    c.lastTouched = objects;
    return { text: `${this.stepText(res, op.id)}: ${plural(changes.length, 'element')} changed`, data: { step: op.id } };
  }

  async deleteObjects(handle: string | undefined, ids: string[]): Promise<ToolResult> {
    const { r, c } = await this.live(handle);
    this.checkConnection(c);
    if (!ids.length) throw new ToolError('Nothing to delete');
    const objects: string[] = [];
    let groups = 0;
    const b = new OpBuilder(c.scene, 'placement:edit', this.author(r));
    const op = this.build(c, b, (scene) => {
      const unique = [...new Set(ids)];
      for (const id of unique) {
        const el = scene.get(id);
        if (!el) throw new ToolError(`No object or group ${id}`);
        if (el.kind === 'core:group') {
          groups++;
          objects.push(...scene.children(id));
        } else if (el.kind === 'core:object') objects.push(id);
        else throw new ToolError(`${id} cannot be deleted by an agent`);
      }
      const inDeletedGroup = new Set(unique.filter((id) => scene.get(id)!.kind === 'core:group'));
      for (const id of unique) {
        const el = scene.get(id);
        if (!el || inDeletedGroup.has(el.parent)) continue;
        b.deleteTree(id);
      }
    });
    if (groups) op.type = 'projects:edit';
    await this.lockFor(c, objects, []);
    const res = await c.submit(op);
    const text = this.stepText(res, op.id);
    if (res.status === 'applied') await c.setLocks([...c.selection].filter((id) => !objects.includes(id)));
    return { text: `${text}: ${plural(groups, 'group')}, ${plural(objects.length, 'object')} deleted`, data: { step: op.id } };
  }

  async release(handle: string | undefined, ids?: string[]): Promise<ToolResult> {
    const { c } = await this.live(handle);
    const keep = ids?.length ? [...c.selection].filter((id) => !ids.includes(id)) : [];
    const before = c.selection.size;
    await c.setLocks(keep);
    return { text: `Released ${plural(before - c.selection.size, 'object')}; ${c.selection.size} still held` };
  }

  async setStatus(handle: string | undefined, phase: 'waiting' | 'working', status?: string): Promise<ToolResult> {
    if (status !== undefined) validateStatus(status);
    const { c } = await this.live(handle);
    c.setPhase(phase, status ?? '');
    if (phase === 'waiting' && c.selection.size) await c.setLocks([]);
    return { text: `Phase: ${PHASE_TEXT[phase]}${c.status ? ` — ${c.status}` : ''}` };
  }

  async requestReview(handle: string | undefined, status?: string): Promise<ToolResult> {
    if (status !== undefined) validateStatus(status);
    const { c } = await this.live(handle);
    const open = await c.flush(10_000);
    c.setPhase('review', status ?? '');
    if (c.selection.size) await c.setLocks([]);
    return {
      text: `Waiting for review${c.status ? ` — ${c.status}` : ''}${open ? `; ${plural(open, 'change')} not confirmed yet` : ''}. A person saves or discards.`,
    };
  }
}
