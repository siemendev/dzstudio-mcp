import { randomToken } from '../scene/ids.js';
import { ensureOk, PROTOCOL, type Json, type Transport } from './transport.js';

export const CLIENT_NAME = 'dzstudio-mcp';
export const CLIENT_VERSION = '0.1.0';

export interface ClientInfo {
  name: string;
  version: string;
  kind: 'agent';
  /** Short name of this agent; servers that do not know the field ignore it. */
  agentName?: string;
}

export function agentClient(agentName?: string): ClientInfo {
  const c: ClientInfo = { name: CLIENT_NAME, version: CLIENT_VERSION, kind: 'agent' };
  if (agentName) c.agentName = agentName;
  return c;
}

/** 16 characters from 0–9 a–z, the same on every repetition of one request. */
export function requestId(): string {
  return randomToken(16);
}

export interface ServerInfo {
  name: string;
  capabilities: string[];
  auth: Json[];
  limits: Json;
  notice?: string;
  raw: Json;
}

export type CodeLoginState =
  | { state: 'waiting' }
  | { state: 'confirmed'; token: string; name: string; expiresInSeconds?: number }
  | { state: 'expired' }
  | { state: 'denied' };

/** Requests of dzcollab 1 that are not bound to a joined session. */
export class CollabClient {
  constructor(readonly transport: Transport) {}

  /** POST with `protocol` and, if given, `token`; throws CollabError on `ok: false`. */
  async request(endpoint: string, body: Json, token?: string, timeoutMs?: number, signal?: AbortSignal): Promise<Json> {
    const full: Json = { protocol: PROTOCOL, ...body };
    if (token !== undefined) full.token = token;
    return ensureOk(await this.transport.call(endpoint, full, { timeoutMs, signal }));
  }

  async info(): Promise<ServerInfo> {
    const res = ensureOk(await this.transport.call('info', undefined, { method: 'GET' }));
    const majors = Array.isArray(res.protocols) ? res.protocols : [];
    if (!majors.some((p: Json) => p?.major === 1)) throw new Error('Server does not speak dzcollab 1');
    const info: ServerInfo = {
      name: String(res.server?.name ?? ''),
      capabilities: Array.isArray(res.capabilities) ? res.capabilities.filter((c: unknown) => typeof c === 'string') : [],
      auth: Array.isArray(res.auth) ? res.auth : [],
      limits: res.limits ?? {},
      raw: res,
    };
    if (typeof res.notice === 'string') info.notice = res.notice;
    return info;
  }

  async codeStart(client: ClientInfo): Promise<{ loginCode: string; url: string; expiresInSeconds: number; intervalSeconds: number }> {
    const res = await this.request('auth/code/start', { client });
    return {
      loginCode: res.loginCode,
      url: res.url,
      expiresInSeconds: Number(res.expiresInSeconds ?? 600),
      intervalSeconds: Math.max(2, Number(res.intervalSeconds ?? 2)),
    };
  }

  async codePoll(loginCode: string): Promise<CodeLoginState> {
    const res = await this.request('auth/code/poll', { loginCode });
    if (res.state === 'confirmed') {
      const out: CodeLoginState = { state: 'confirmed', token: res.token, name: String(res.name ?? '') };
      if (typeof res.tokenExpiresInSeconds === 'number') out.expiresInSeconds = res.tokenExpiresInSeconds;
      return out;
    }
    if (res.state === 'expired' || res.state === 'denied') return { state: res.state };
    return { state: 'waiting' };
  }

  async nameLogin(name: string, client: ClientInfo): Promise<{ token: string; name: string }> {
    const res = await this.request('auth/name', { requestId: requestId(), name, client });
    return { token: res.token, name: String(res.name ?? name) };
  }

  async sessionsList(token: string, hostedRef?: Json): Promise<Json[]> {
    const res = await this.request('sessions/list', hostedRef ? { hostedRef } : {}, token);
    return Array.isArray(res.sessions) ? res.sessions : [];
  }

  /** All pages of project/list. */
  async projectList(token: string): Promise<{ projects: Json[]; stores: Json[] }> {
    const projects: Json[] = [];
    const seen = new Set<string>();
    let stores: Json[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const res = await this.request('project/list', after ? { after } : {}, token);
      stores = Array.isArray(res.stores) ? res.stores : stores;
      for (const p of res.projects ?? []) {
        const key = JSON.stringify(p.hostedRef);
        if (!seen.has(key)) {
          seen.add(key);
          projects.push(p);
        }
      }
      if (typeof res.next !== 'string') break;
      after = res.next;
    }
    return { projects, stores };
  }

  async projectRevision(token: string, hostedRef: Json): Promise<Json> {
    return this.request('project/revision', { hostedRef }, token);
  }

  async inviteRedeem(token: string, code: string): Promise<Json> {
    return this.request('invite/redeem', { requestId: requestId(), code }, token);
  }
}
