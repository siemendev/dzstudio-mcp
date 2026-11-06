import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentClient, CollabClient, requestId } from '../../src/protocol/client.js';
import { CollabSession } from '../../src/protocol/session.js';
import { HttpTransport, type Json } from '../../src/protocol/transport.js';
import { chunk, OpBuilder, readOperation, writeOperation } from '../../src/scene/index.js';

/**
 * Runs the client against the reference collaboration server. The server binary comes from DZCOLLAB_SERVER, or is
 * built from DZCOLLAB_SOURCE (default: ../collab-server next to this package) when Go is installed. Without either,
 * the test is skipped.
 */

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const SOURCE = process.env.DZCOLLAB_SOURCE ?? resolve(import.meta.dirname, '../../../collab-server');

function goAvailable(): boolean {
  try {
    execFileSync('go', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const runnable = !!process.env.DZCOLLAB_SERVER || (goAvailable() && existsSync(join(SOURCE, 'cmd/dzcollab')));

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

describe.skipIf(!runnable)('against the reference server', () => {
  let dir = '';
  let proc: ChildProcess | undefined;
  let base = '';
  const raw = (endpoint: string, body: Json): Promise<Json> => new CollabClient(new HttpTransport(base)).request(endpoint, body);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dzstudio-mcp-it-'));
    let binary = process.env.DZCOLLAB_SERVER;
    if (!binary) {
      binary = join(dir, 'dzcollab');
      execFileSync('go', ['build', '-o', binary, './cmd/dzcollab'], { cwd: SOURCE, stdio: 'ignore' });
    }
    const port = await freePort();
    const config = {
      server: { name: 'MCP integration' },
      listen: { host: '127.0.0.1', port, basePath: '/dzcollab/' },
      dataDir: join(dir, 'data'),
      storage: { type: 'memory' },
      auth: {
        secret: 'integration-secret-integration-secret-01',
        name: { enabled: true },
        code: { enabled: true, expiresInSeconds: 600, intervalSeconds: 2 },
      },
      users: [{ id: 'patrick', name: 'Patrick', password: 'patrick-password' }],
      permissions: { hostLocal: ['*'], localAlwaysJoin: { 'name:Anna': ['patrick'] } },
    };
    await writeFile(join(dir, 'config.json'), JSON.stringify(config));
    proc = spawn(binary, [join(dir, 'config.json')], { stdio: 'ignore' });
    base = `http://127.0.0.1:${port}/dzcollab/`;
    for (let i = 0; ; i++) {
      try {
        const r = await fetch(base + 'info');
        if (r.status === 200) break;
      } catch {
        // not up yet
      }
      if (i > 200) throw new Error('reference server did not start');
      await new Promise((r) => setTimeout(r, 50));
    }
  }, 180_000);

  afterAll(async () => {
    proc?.kill('SIGTERM');
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('logs in with a code, joins a session, sends an operation and reads it back', async () => {
    const client = new CollabClient(new HttpTransport(base));
    const info = await client.info();
    expect(info.capabilities).toContain('auth.code');

    const anna = await raw('auth/name', { protocol: '1.0', requestId: requestId(), name: 'Anna' });
    const annaKey = 'a1b2c3d4e5';
    const created = await raw('session/create', {
      token: anna.token,
      requestId: requestId(),
      client: { name: 'dzstudio', version: '0.4.0' },
      projectName: 'Basis',
      map: 'chernarus',
      kind: 'local',
      instanceKey: annaKey,
      snapshotBytes: Buffer.byteLength(golden.Z1!),
      snapshotParts: 1,
    });
    const annaIds = { sessionId: created.sessionId, participantId: created.participantId };
    await raw('snapshot/put', { token: anna.token, ...annaIds, seq: 0, part: 0, parts: 1, pieces: chunk(golden.Z1!) });
    await raw('poll', { token: anna.token, ...annaIds, after: 0, waitMs: 0, versions: {}, presence: { idleSeconds: 0, position: [0.0, 0.0, 0.0] } });

    const start = await client.codeStart(agentClient('Scout'));
    const form = new URLSearchParams({ code: start.loginCode, user: 'patrick', password: 'patrick-password', action: 'confirm' });
    const page = await fetch(start.url, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(page.status).toBe(200);
    const login = await client.codePoll(start.loginCode);
    expect(login.state).toBe('confirmed');
    const token = login.state === 'confirmed' ? login.token : '';

    const listed = await client.sessionsList(token);
    expect(listed.map((s) => s.sessionId)).toContain(created.sessionId);

    const s = await CollabSession.join(
      { client, token: () => token, clientInfo: agentClient('Scout'), timing: { pollWaitMs: 1000 }, position: () => [1240, 150, 9880] },
      created.sessionId,
    );
    try {
      expect(s.scene.stateText()).toBe(golden.Z1);

      const lock = await s.setLocks(['k3f9a0x2mq-2']);
      expect(lock.granted).toEqual(['k3f9a0x2mq-2']);

      const b = new OpBuilder(s.scene, 'placement:edit', { author: 'z9y8x7w6v5u4t3s2', authorName: 'Patrick' });
      const crate = b.createObject({ group: 'k3f9a0x2mq-1', name: 'WoodenCrate', pos: [1240.5, 150, 9880.25], ypr: [-90, 0, 0] });
      const op = b.finish();
      expect(await s.submit(op)).toEqual({ status: 'applied', seq: 1 });
      expect(s.scene.has(crate)).toBe(true);

      const seen = await raw('poll', { token: anna.token, ...annaIds, after: 0, waitMs: 0, versions: {}, presence: { idleSeconds: 0, position: [0.0, 0.0, 0.0] } });
      expect(seen.ops).toHaveLength(1);
      expect(seen.ops[0].pieces.join('')).toBe(writeOperation(op));
      const agentRow = seen.participants.list.find((p: Json) => p.participantId === s.participantId);
      expect(agentRow.name).toBe('Patrick');
      if (info.capabilities.includes('agents')) {
        expect(agentRow.kind).toBe('agent');
        expect(agentRow.canSave).toBe(false);
      }

      const hide = readOperation(golden.G4!);
      hide.id = 'a1b2c3d4e5-1';
      hide.changes = [{ k: 'hidden', id: crate, old: false, new: true }];
      await raw('ops/send', { token: anna.token, ...annaIds, ops: [{ clientSeq: 1, opId: hide.id, pieces: chunk(writeOperation(hide)) }] });
      const until = Date.now() + 5000;
      while (s.appliedSeq < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      expect(s.scene.get(crate)!.hidden).toBe(true);
    } finally {
      await s.leave();
    }
  });
});
