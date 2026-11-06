import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, defaultConfigDir, parseServerList } from '../../src/config/config.js';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dzstudio-mcp-config-'));

describe('config', () => {
  it('creates defaults once: agent name, a stable installation id, no servers', () => {
    const dir = tmp();
    const a = new ConfigStore(dir, {}).load();
    expect(a.agentName).toBe('Agent');
    expect(a.installationId).toMatch(/^[0-9a-z]{16}$/);
    expect(a.servers).toEqual([]);
    expect(new ConfigStore(dir, {}).load().installationId).toBe(a.installationId);
  });

  it('adds servers by name, keeps them, rejects duplicates and bad addresses', () => {
    const dir = tmp();
    const s = new ConfigStore(dir, {});
    expect(s.addServer('local', 'http://127.0.0.1:47080/dzcollab')).toEqual({ name: 'local', url: 'http://127.0.0.1:47080/dzcollab/' });
    expect(() => s.addServer('local', 'http://x/')).toThrow(/already exists/);
    expect(() => s.addServer('x', 'ftp://x/')).toThrow(/http or https/);
    expect(() => s.addServer('', 'http://x/')).toThrow();
    const again = new ConfigStore(dir, {});
    expect(again.server().name).toBe('local');
    expect(again.server('local').url).toBe('http://127.0.0.1:47080/dzcollab/');
    expect(() => again.server('nope')).toThrow(/No server named nope/);
  });

  it('takes servers and the agent name from the environment once', () => {
    const dir = tmp();
    const env = {
      DZSTUDIO_MCP_SERVERS: 'local=http://127.0.0.1:47080/dzcollab/, dzbot=https://collab.example.org/dzcollab/',
      DZSTUDIO_MCP_AGENT_NAME: 'Scout',
    };
    const c = new ConfigStore(dir, env).load();
    expect(c.servers.map((s) => s.name)).toEqual(['local', 'dzbot']);
    expect(c.agentName).toBe('Scout');
    expect(new ConfigStore(dir, env).load().servers.length).toBe(2);
  });

  it('keeps tokens in a file only the user can read', () => {
    const dir = tmp();
    const s = new ConfigStore(dir, {});
    s.load();
    s.setCredential('dzbot', { token: 'secret', name: 'Patrick' });
    expect(new ConfigStore(dir, {}).credential('dzbot')).toEqual({ token: 'secret', name: 'Patrick' });
    if (process.platform !== 'win32') expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('secret');
    s.setCredential('dzbot', { token: 'old', name: 'Patrick', expiresAt: Date.now() - 1 });
    expect(s.credential('dzbot')).toBeUndefined();
    s.setCredential('dzbot', undefined);
    expect(new ConfigStore(dir, {}).credential('dzbot')).toBeUndefined();
  });

  it('takes world data settings from config.json, overridden by the environment', () => {
    const dir = tmp();
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ worldData: { base: 'https://mirror.example.org/wd/', pointer: 'https://mirror.example.org/p' } }),
    );
    expect(new ConfigStore(dir, {}).worldData()).toEqual({
      base: 'https://mirror.example.org/wd/',
      pointer: 'https://mirror.example.org/p',
      cacheDir: join(dir, 'cache'),
    });
    expect(new ConfigStore(dir, { DZSTUDIO_MCP_WORLD_DATA: '/srv/world-data' }).worldData()).toEqual({
      base: 'file:///srv/world-data',
      cacheDir: join(dir, 'cache'),
    });
    expect(new ConfigStore(tmp(), {}).worldData().base).toBeUndefined();
    expect(new ConfigStore(tmp(), {}).worldData().cacheLimit).toBeUndefined();
    const limited = tmp();
    writeFileSync(join(limited, 'config.json'), JSON.stringify({ worldData: { cacheLimitMb: 512 } }));
    expect(new ConfigStore(limited, {}).worldData().cacheLimit).toBe(512 * 1024 * 1024);
    expect(new ConfigStore(limited, { DZSTUDIO_MCP_CACHE_LIMIT_MB: '100' }).worldData().cacheLimit).toBe(100 * 1024 * 1024);
  });

  it('finds the config directory', () => {
    expect(defaultConfigDir({ DZSTUDIO_MCP_CONFIG_DIR: '/x' })).toBe('/x');
    if (process.platform !== 'win32') expect(defaultConfigDir({ XDG_CONFIG_HOME: '/c' })).toBe('/c/dzstudio-mcp');
    expect(() => parseServerList('noequals')).toThrow();
  });
});
