import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { agentClient, CollabClient } from '../../src/protocol/client.js';
import { CollabSession, type SessionOptions } from '../../src/protocol/session.js';
import { OpBuilder, readOperation, writeOperation } from '../../src/scene/index.js';
import { FakeServer } from '../support/fake-server.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const BY = { author: 'z9y8x7w6v5u4t3s2', authorName: 'Patrick' };
const GROUP = 'k3f9a0x2mq-1';
const FLAG = 'k3f9a0x2mq-2';

const open: CollabSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.stop();
});

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function setup(opts: Partial<SessionOptions> = {}) {
  const server = new FakeServer();
  const host = server.createSession({ state: golden.Z1! });
  const client = new CollabClient(server);
  const s = await CollabSession.join(
    {
      client,
      token: () => 't-agent-Patrick',
      clientInfo: agentClient('Scout'),
      timing: { pollWaitMs: 200, retryDelayMs: 10, confirmTimeoutMs: 2000, resumeAfterMs: 100 },
      ...opts,
    },
    host.sessionId,
  );
  open.push(s);
  return { server, host, s };
}

function placeCrate(s: CollabSession, name = 'WoodenCrate') {
  const b = new OpBuilder(s.scene, 'placement:edit', BY);
  const id = b.createObject({ group: GROUP, name, pos: [1, 2, 3] });
  return { id, op: b.finish() };
}

describe('session', () => {
  it('joins as an agent and loads the snapshot', async () => {
    const { server, s } = await setup();
    expect(s.scene.stateText()).toBe(golden.Z1);
    const join = server.requests.find((r) => r.endpoint === 'session/join')!;
    expect(join.body.client).toEqual({ name: 'dzstudio-mcp', version: '0.1.0', kind: 'agent', agentName: 'Scout' });
    expect(join.body.instanceKey).toBe(s.prefix);
    expect(join.body.protocol).toBe('1.0');
  });

  it("applies others' operations from the log in order", async () => {
    const { server, host, s } = await setup();
    server.appendAs(host.sessionId, host.participantId, 'k3f9a0x2mq-5', golden.G2!);
    server.appendAs(host.sessionId, host.participantId, 'k3f9a0x2mq-6', golden.G3!);
    await until(() => s.appliedSeq === 2);
    expect(s.scene.get('k3f9a0x2mq-4')!.fields.get('pos')).toBe('1241.75 150.5 9879.1');
  });

  it('sends its own operation and reports it applied', async () => {
    const { server, s } = await setup();
    const { id, op } = placeCrate(s);
    const r = await s.submit(op);
    expect(r).toEqual({ status: 'applied', seq: 1 });
    expect(s.scene.has(id)).toBe(true);
    const send = server.requests.find((x) => x.endpoint === 'ops/send')!;
    expect(send.body.ops).toEqual([{ clientSeq: 1, opId: op.id, pieces: [writeOperation(op)] }]);
    expect(id.startsWith(s.prefix + '-')).toBe(true);
  });

  it('does not send an operation that would not apply', async () => {
    const { server, s } = await setup();
    const op = readOperation(golden.G3!);
    const r = await s.submit({ ...op, id: `${s.prefix}-99` });
    expect(r).toEqual({ status: 'rejected', message: 'Step no longer possible: Object was deleted' });
    expect(server.count('ops/send')).toBe(0);
  });

  it.each(['before', 'after'] as const)('repeats ops/send unchanged when the response is lost (%s)', async (mode) => {
    const { server, host, s } = await setup();
    server.fail('ops/send', mode);
    const { op } = placeCrate(s);
    expect((await s.submit(op)).status).toBe('applied');
    await until(() => server.count('ops/send') === (mode === 'after' ? 2 : 1));
    const sends = server.requests.filter((x) => x.endpoint === 'ops/send');
    expect(sends.length).toBe(mode === 'after' ? 2 : 1);
    if (mode === 'after') expect(sends[1]!.body).toEqual(sends[0]!.body);
    expect(server.sessions.get(host.sessionId)!.log.length).toBe(1);
  });

  it('counts clientSeq on per operation', async () => {
    const { server, s } = await setup();
    await s.submit(placeCrate(s, 'A').op);
    await s.submit(placeCrate(s, 'B').op);
    const seqs = server.requests.filter((x) => x.endpoint === 'ops/send').map((x) => x.body.ops[0].clientSeq);
    expect(seqs).toEqual([1, 2]);
  });

  it("drops its step when someone else's operation got there first", async () => {
    const { server, host, s } = await setup();
    const b = new OpBuilder(s.scene, 'properties:edit', BY);
    b.setField(FLAG, 'customString', 'mine');
    const op = b.finish();
    server.beforeOpsSend = () => {
      const theirs = readOperation(golden.G4!);
      theirs.changes = [{ k: 'field', id: FLAG, key: 'customString', old: 'Flag_DayZ', new: 'theirs' }];
      server.appendAs(host.sessionId, host.participantId, 'k3f9a0x2mq-7', writeOperation(theirs));
    };
    const r = await s.submit(op);
    expect(r).toEqual({ status: 'dropped', seq: 2, message: 'Step no longer possible: Object was changed' });
    expect(s.scene.get(FLAG)!.fields.get('customString')).toBe('theirs');
    expect(s.drainEvents().some((e) => e.kind === 'step_dropped')).toBe(true);
  });

  it('sends a large operation in parts and a very large one as a chain, and applies it', async () => {
    const { server, host, s } = await setup();
    for (const size of [1_500_000, 5_000_000]) {
      const b = new OpBuilder(s.scene, 'placement:edit', BY);
      const id = b.createObject({ group: GROUP, name: 'Big', pos: [0, 0, 0], customString: 'ä'.repeat(size / 2) });
      const op = b.finish();
      expect(await s.submit(op)).toMatchObject({ status: 'applied' });
      expect(s.scene.get(id)!.fields.get('customString')!.length).toBe(size / 2);
    }
    const log = server.sessions.get(host.sessionId)!.log;
    expect(log[0]!.parts.length).toBe(2);
    expect(log[0]!.chain).toBeUndefined();
    const chain = log.slice(1);
    expect(chain.length).toBe(2);
    expect(chain.map((e) => e.chain)).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }]);
    for (const e of log) for (const p of e.parts.flat()) expect(Buffer.byteLength(p)).toBeLessThanOrEqual(1000);
    const items = server.requests.filter((x) => x.endpoint === 'ops/send').flatMap((x) => x.body.ops);
    expect(new Set(items.map((i: { clientSeq: number }) => i.clientSeq))).toEqual(new Set([1, 2, 3]));
    expect(s.appliedSeq).toBe(3);
  });

  it('sets locks and loses the ones someone else takes over', async () => {
    const { server, host, s } = await setup();
    const r = await s.setLocks([FLAG]);
    expect(r).toEqual({ granted: [FLAG], denied: [] });
    const lock = server.requests.find((x) => x.endpoint === 'locks/set')!;
    expect(lock.body).toMatchObject({ lockSeq: 1, elements: [FLAG] });
    server.lockAs(host.sessionId, host.participantId, [FLAG]);
    await until(() => !s.selection.has(FLAG));
    expect(s.drainEvents().map((e) => e.text)).toContain('Anna took over 1 object');
  });

  it('reports denied locks with their holder', async () => {
    const { server, host, s } = await setup();
    server.lockAs(host.sessionId, host.participantId, [FLAG]);
    const r = await s.setLocks([FLAG, 'k3f9a0x2mq-1']);
    expect(r.denied).toEqual([{ element: FLAG, holder: host.participantId }]);
    expect([...s.selection]).toEqual(['k3f9a0x2mq-1']);
  });

  it('reports phase and status in presence', async () => {
    const { server, s } = await setup();
    s.setPhase('working', 'building a wall');
    await until(() => server.requests.some((x) => x.endpoint === 'poll' && x.body.presence.phase === 'working'));
    const poll = server.requests.filter((x) => x.endpoint === 'poll').at(-1)!;
    expect(poll.body.presence).toMatchObject({ phase: 'working', status: 'building a wall' });
    expect(poll.body.presence.position).toBeUndefined();
  });

  it('reports the position from the callback', async () => {
    const { server } = await setup({ position: () => [10, 20, 30] });
    await until(() => server.requests.some((x) => x.endpoint === 'poll' && x.body.presence.position));
  });

  it('ends when removed, with who removed it', async () => {
    const { server, host, s } = await setup();
    server.remove(host.sessionId, s.participantId, 'Anna');
    await until(() => s.state === 'removed');
    expect(s.stateText).toBe('Anna removed you from the session');
    expect((await s.submit(placeCrate(s).op)).status).toBe('rejected');
  });

  it('ends on discard with the name of who discarded', async () => {
    const { server, host, s } = await setup();
    server.endSession(host.sessionId, { reason: 'discarded', by: 'Ben' });
    await until(() => s.state === 'ended');
    expect(s.stateText).toBe('Session ended: Ben discarded the unsaved changes');
  });

  it('reports a save', async () => {
    const server = new FakeServer();
    const host = server.createSession({ kind: 'hosted', state: golden.Z1!, hostedRef: { provider: 'fake', key: 'a' } });
    const s = await CollabSession.join(
      { client: new CollabClient(server), token: () => 't-agent-Patrick', clientInfo: agentClient(), timing: { pollWaitMs: 100, retryDelayMs: 10 } },
      host.sessionId,
    );
    open.push(s);
    await s.submit(placeCrate(s).op);
    server.save(host.sessionId, 'Anna');
    await until(() => s.drainEvents().some((e) => e.text === 'Saved by Anna'));
  });

  it('uploads a checkpoint of its state when asked', async () => {
    const { server, host, s } = await setup();
    await s.submit(placeCrate(s).op);
    server.askCheckpoint(host.sessionId, s.participantId);
    await until(() => server.sessions.get(host.sessionId)!.snapshots.has(1));
    expect(server.sessions.get(host.sessionId)!.snapshots.get(1)!.flat().join('')).toBe(s.scene.stateText());
  });

  it('leaves the session on an operation type it does not know', async () => {
    const { server, host, s } = await setup();
    server.appendAs(host.sessionId, host.participantId, 'q8w7e6r5t4-3', golden.R3!.replace('k3f9a0x2mq-4', FLAG));
    await until(() => s.state === 'lost');
    expect(s.drainEvents().map((e) => e.text)).toContain('This session needs a newer dzStudio MCP (operation type of plugin agent, version 1)');
    await until(() => server.count('session/leave') === 1);
  });

  it('returns with resume after a long interruption', async () => {
    const { server, host, s } = await setup();
    for (let i = 0; i < 25; i++) server.fail('poll', 'before');
    await until(() => server.requests.some((x) => x.endpoint === 'session/join' && x.body.resume));
    const resume = server.requests.find((x) => x.endpoint === 'session/join' && x.body.resume)!;
    expect(resume.body.resume).toEqual({ participantId: s.participantId, after: 0 });
    expect(resume.body.instanceKey).toBe(s.prefix);
    server.appendAs(host.sessionId, host.participantId, 'k3f9a0x2mq-5', golden.G2!);
    await until(() => s.appliedSeq === 1);
    expect(s.active).toBe(true);
  });

  it('leaves with session/leave', async () => {
    const { server, s } = await setup();
    await s.leave();
    expect(server.count('session/leave')).toBe(1);
    expect(s.active).toBe(false);
  });
});
