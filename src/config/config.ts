import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomToken } from '../scene/ids.js';

/**
 * Configured once: servers by name, the agent's short name and the installation id. Tokens are kept apart in
 * `credentials.json`, readable only by the user. Projects and sessions are never configuration.
 */

export interface ServerEntry {
  name: string;
  url: string;
}

export interface Config {
  agentName: string;
  /** Author id in operations: 16 characters from 0–9 and a–z, never changed. */
  installationId: string;
  servers: ServerEntry[];
  /** Where class and map data come from; default dzbot's published data. */
  worldData?: WorldDataSettings;
}

export interface WorldDataSettings {
  /** `https://…/` base address or `file:///…/` folder with the published layout. */
  base?: string;
  /** Pointer to the current revisions; only for a base address. */
  pointer?: string;
  /** Size limit of the disk cache in MB (default 2048). */
  cacheLimitMb?: number;
}

export interface Credential {
  token: string;
  /** Display name the server reported at login. */
  name: string;
  /** Milliseconds since the epoch, if the server named a lifetime. */
  expiresAt?: number;
}

export const DEFAULT_AGENT_NAME = 'Agent';
const NAME_FORM = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DZSTUDIO_MCP_CONFIG_DIR) return env.DZSTUDIO_MCP_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'dzstudio-mcp');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dzstudio-mcp');
}

/** `DZSTUDIO_MCP_SERVERS="local=http://127.0.0.1:8080/dzcollab/,dzbot=https://…"` */
export function parseServerList(text: string): ServerEntry[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      if (i <= 0) throw new Error(`server entry needs name=url: ${s}`);
      return { name: s.slice(0, i).trim(), url: s.slice(i + 1).trim() };
    });
}

export function validateServerName(name: string): void {
  if (!NAME_FORM.test(name)) throw new Error('A server name has 1 to 64 characters: letters, digits, space, dot, _ and -');
}

export function validateServerUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The base address must be http or https');
  return u.href.endsWith('/') ? u.href : u.href + '/';
}

export class ConfigStore {
  readonly dir: string;
  private config?: Config;
  private credentials?: Record<string, Credential>;

  constructor(
    dir?: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.dir = dir ?? defaultConfigDir(env);
  }

  private path(name: string): string {
    return join(this.dir, name);
  }

  private ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private readJson<T>(name: string): T | undefined {
    const p = this.path(name);
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  }

  private writeJson(name: string, value: unknown, mode: number): void {
    this.ensureDir();
    const p = this.path(name);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, p);
  }

  load(): Config {
    if (this.config) return this.config;
    const stored = this.readJson<Partial<Config>>('config.json') ?? {};
    let dirty = !existsSync(this.path('config.json'));
    const config: Config = {
      agentName: stored.agentName || DEFAULT_AGENT_NAME,
      installationId: /^[0-9a-z]{16}$/.test(stored.installationId ?? '') ? stored.installationId! : randomToken(16),
      servers: Array.isArray(stored.servers)
        ? stored.servers.filter((s) => s && typeof s.name === 'string' && typeof s.url === 'string')
        : [],
    };
    if (stored.worldData && typeof stored.worldData === 'object') config.worldData = stored.worldData;
    if (config.installationId !== stored.installationId) dirty = true;
    if (this.env.DZSTUDIO_MCP_AGENT_NAME && config.agentName !== this.env.DZSTUDIO_MCP_AGENT_NAME) {
      config.agentName = this.env.DZSTUDIO_MCP_AGENT_NAME;
      dirty = true;
    }
    if (this.env.DZSTUDIO_MCP_SERVERS) {
      for (const s of parseServerList(this.env.DZSTUDIO_MCP_SERVERS)) {
        if (!config.servers.some((x) => x.name === s.name)) {
          validateServerName(s.name);
          config.servers.push({ name: s.name, url: validateServerUrl(s.url) });
          dirty = true;
        }
      }
    }
    this.config = config;
    if (dirty) this.save();
    return config;
  }

  /** World data settings: `DZSTUDIO_MCP_WORLD_DATA` (and `…_POINTER`) win over config.json, without being stored. */
  worldData(): WorldDataSettings & { cacheDir: string; cacheLimit?: number } {
    const out: WorldDataSettings & { cacheDir: string; cacheLimit?: number } = {
      ...this.load().worldData,
      cacheDir: join(this.dir, 'cache'),
    };
    const base = this.env.DZSTUDIO_MCP_WORLD_DATA;
    if (base) {
      out.base = /^[a-z]+:\/\//.test(base) ? base : pathToFileURL(resolve(base)).href;
      delete out.pointer;
    }
    if (this.env.DZSTUDIO_MCP_WORLD_DATA_POINTER) out.pointer = this.env.DZSTUDIO_MCP_WORLD_DATA_POINTER;
    const mb = Number(this.env.DZSTUDIO_MCP_CACHE_LIMIT_MB ?? out.cacheLimitMb);
    if (Number.isFinite(mb) && mb > 0) out.cacheLimit = Math.round(mb * 1024 * 1024);
    return out;
  }

  save(): void {
    if (this.config) this.writeJson('config.json', this.config, 0o600);
  }

  server(name?: string): ServerEntry {
    const servers = this.load().servers;
    if (!servers.length) throw new Error('No server configured — call add_server');
    if (name === undefined) return servers[0]!;
    const s = servers.find((x) => x.name === name);
    if (!s) throw new Error(`No server named ${name} — call list_servers`);
    return s;
  }

  addServer(name: string, url: string): ServerEntry {
    validateServerName(name);
    const entry = { name, url: validateServerUrl(url) };
    const config = this.load();
    if (config.servers.some((s) => s.name === name)) throw new Error(`A server named ${name} already exists`);
    config.servers.push(entry);
    this.save();
    return entry;
  }

  private creds(): Record<string, Credential> {
    this.credentials ??= this.readJson<Record<string, Credential>>('credentials.json') ?? {};
    return this.credentials;
  }

  credential(server: string): Credential | undefined {
    const c = this.creds()[server];
    if (!c) return undefined;
    if (c.expiresAt !== undefined && c.expiresAt <= Date.now()) return undefined;
    return c;
  }

  setCredential(server: string, c: Credential | undefined): void {
    const all = this.creds();
    if (c) all[server] = c;
    else delete all[server];
    this.writeJson('credentials.json', all, 0o600);
  }
}
