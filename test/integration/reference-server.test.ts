import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentClient, CollabClient, requestId } from '../../src/protocol/client.js';
import { CollabSession } from '../../src/protocol/session.js';
import { HttpTransport, type Json } from '../../src/protocol/transport.js';
import { chunk, OpBuilder, readOperation, writeOperation } from '../../src/scene/index.js';
import { referenceServerAvailable, startReferenceServer, type ReferenceServer } from '../support/reference-server.js';

/** Runs the client against the reference collaboration server (see test/support/reference-server.ts). */

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));

describe.skipIf(!referenceServerAvailable)('against the reference server', () => {
  let server: ReferenceServer | undefined;
  let base = '';
  const raw = (endpoint: string, body: Json): Promise<Json> => new CollabClient(new HttpTransport(base)).request(endpoint, body);

  beforeAll(async () => {
    server = await startReferenceServer({
      server: { name: 'MCP integration' },
      storage: { type: 'memory' },
      auth: {
        secret: 'integration-secret-integration-secret-01',
        name: { enabled: true },
        code: { enabled: true, expiresInSeconds: 600, intervalSeconds: 2 },
      },
      users: [{ id: 'patrick', name: 'Patrick', password: 'patrick-password' }],
      permissions: { hostLocal: ['*'], localAlwaysJoin: { 'name:Anna': ['patrick'] } },
    });
    base = server.base;
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
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
    await raw('poll', {
      token: anna.token,
      ...annaIds,
      after: 0,
      waitMs: 0,
      versions: {},
      presence: { idleSeconds: 0, position: [0.0, 0.0, 0.0] },
    });

    const start = await client.codeStart(agentClient('Scout'));
    expect(await (await fetch(start.url)).text()).toContain('“Scout”');
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

      const seen = await raw('poll', {
        token: anna.token,
        ...annaIds,
        after: 0,
        waitMs: 0,
        versions: {},
        presence: { idleSeconds: 0, position: [0.0, 0.0, 0.0] },
      });
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
