import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The reference collaboration server for integration tests. The binary comes from DZCOLLAB_SERVER, or is built from
 * DZCOLLAB_SOURCE (default: ../collab-server next to this package) when Go is installed. It listens on a free port in
 * 127.0.0.1:47000–47999.
 */

export const SOURCE = process.env.DZCOLLAB_SOURCE ?? resolve(import.meta.dirname, '../../../collab-server');

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const referenceServerAvailable = !!process.env.DZCOLLAB_SERVER || (goAvailable() && existsSync(join(SOURCE, 'cmd/dzcollab')));

async function portFree(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

async function freePort(): Promise<number> {
  for (let i = 0; i < 200; i++) {
    const port = 47000 + Math.floor(Math.random() * 1000);
    if (await portFree(port)) return port;
  }
  throw new Error('no free port in 47000–47999');
}

export interface ReferenceServer {
  base: string;
  dir: string;
  stop(): Promise<void>;
}

/** Builds (if needed) and starts the server with `config` (listen, dataDir are filled in); `prepare` may add files. */
export async function startReferenceServer(
  config: Record<string, unknown>,
  prepare?: (dir: string) => Promise<void>,
): Promise<ReferenceServer> {
  const dir = await mkdtemp(join(tmpdir(), 'dzstudio-mcp-it-'));
  let binary = process.env.DZCOLLAB_SERVER;
  if (!binary) {
    binary = join(dir, 'dzcollab');
    execFileSync('go', ['build', '-o', binary, './cmd/dzcollab'], { cwd: SOURCE, stdio: 'ignore' });
  }
  if (prepare) await prepare(dir);
  const port = await freePort();
  const full = { ...config, listen: { host: '127.0.0.1', port, basePath: '/dzcollab/' }, dataDir: join(dir, 'data') };
  await writeFile(join(dir, 'config.json'), JSON.stringify(full));
  const proc: ChildProcess = spawn(binary, [join(dir, 'config.json')], { stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}/dzcollab/`;
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(base + 'info');
      if (r.status === 200) break;
    } catch {
      // not up yet
    }
    if (i > 200) {
      proc.kill('SIGTERM');
      throw new Error('reference server did not start');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    base,
    dir,
    async stop() {
      proc.kill('SIGTERM');
      await rm(dir, { recursive: true, force: true });
    },
  };
}
