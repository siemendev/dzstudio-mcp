import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/config/config.js';
import { Agent } from '../../src/mcp/agent.js';
import { createServer } from '../../src/mcp/server.js';
import { FakeServer } from '../support/fake-server.js';

/** The MCP stops (a restart of the client, a crash) while it is in sessions, and starts again with the same config. */

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const GROUP = 'k3f9a0x2mq-1';

interface Run {
  agent: Agent;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; data: any }>;
  stop: () => Promise<void>;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

function setup(): { fake: FakeServer; store: ConfigStore } {
  const fake = new FakeServer();
  const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'dzstudio-mcp-resume-')), {});
  store.addServer('fake', 'http://fake.invalid/dzcollab/');
  store.setCredential('fake', { token: 't-agent-Patrick', name: 'Patrick' });
  return { fake, store };
}

async function start(fake: FakeServer, store: ConfigStore, idleLeaveMs?: number): Promise<Run> {
  const agent = new Agent({
    store,
    transport: () => fake,
    timing: { pollWaitMs: 100, retryDelayMs: 10, confirmTimeoutMs: 2000 },
    ...(idleLeaveMs !== undefined ? { idleLeaveMs } : {}),
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([createServer(agent).connect(a), client.connect(b)]);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await agent.shutdown();
    await client.close();
  };
  cleanup.push(stop);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    const json = text.indexOf('\n{');
    const end = text.indexOf('\n\nEvents:');
    const data = json >= 0 ? JSON.parse(text.slice(json + 1, end >= 0 ? end : undefined)) : undefined;
    return { text, isError: !!res.isError, data };
  };
  return { agent, call, stop };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function agents(fake: FakeServer, sessionId: string) {
  return fake.sessions.get(sessionId)!.participants.filter((p) => p.kind === 'agent');
}

describe('returning to sessions after a restart', () => {
  it('resumes as the same participant from the saved cursor and sees what happened meanwhile', async () => {
    const { fake, store } = setup();
    const host = fake.createSession({ state: golden.Z1! });
    const first = await start(fake, store);
    expect((await first.call('join_session', { session_id: host.sessionId })).isError).toBe(false);
    await first.call('set_status', { phase: 'working', status: 'a crate by the flag' });
    const made = await first.call('create_objects', { objects: [{ class: 'WoodenCrate', group: GROUP, position: [1, 2, 3] }] });
    expect(made.isError).toBe(false);
    const me = agents(fake, host.sessionId)[0]!;
    const prefix = made.data.objects[0].split('-')[0];
    await first.stop();
    expect(fake.count('session/leave')).toBe(0);
    expect(readdirSync(join(store.dir, 'sessions'))).toHaveLength(2);

    // a person keeps working while the MCP is down
    fake.appendAs(host.sessionId, host.participantId, 'k3f9a0x2mq-5', golden.G2!);

    const second = await start(fake, store);
    const listed = await second.call('list_sessions');
    expect(listed.data.sessions).toMatchObject([
      { session: 's1', sessionId: host.sessionId, phase: 'working', status: 'a crate by the flag' },
    ]);
    expect(listed.text).toContain('[s1] Back in Base after a restart');
    const join_ = fake.requests.filter((r) => r.endpoint === 'session/join').at(-1)!.body;
    expect(join_).toMatchObject({ instanceKey: prefix, resume: { participantId: me.participantId, after: 1 } });

    await until(async () => (await second.call('query_objects', { class: 'WoodenCrate' })).data.total === 2);
    const again = await second.call('create_objects', { objects: [{ class: 'WoodenCrate', group: GROUP, position: [4, 5, 6] }] });
    expect(again.isError).toBe(false);
    expect(again.text).toMatch(/^Done in one step/);
    expect(agents(fake, host.sessionId)).toHaveLength(1);
    expect(me.nextClientSeq).toBe(3);
    expect(me.lockSeq).toBeGreaterThan(2);
  });

  it('joins anew when the server took the participant out meanwhile', async () => {
    const { fake, store } = setup();
    const host = fake.createSession({ state: golden.Z1! });
    const first = await start(fake, store);
    await first.call('join_session', { session_id: host.sessionId });
    await first.call('create_objects', { objects: [{ class: 'WoodenCrate', group: GROUP, position: [1, 2, 3] }] });
    await first.stop();
    agents(fake, host.sessionId)[0]!.active = false;

    const second = await start(fake, store);
    const listed = await second.call('list_sessions');
    expect(listed.text).toContain('[s1] Joined Base again after a restart');
    expect(agents(fake, host.sessionId).filter((p) => p.active)).toHaveLength(1);
    expect((await second.call('query_objects', { class: 'WoodenCrate' })).data.total).toBe(1);
  });

  it('leaves the old participation and joins anew when the server would only send a snapshot', async () => {
    const { fake, store } = setup();
    const host = fake.createSession({ state: golden.Z1! });
    const first = await start(fake, store);
    await first.call('join_session', { session_id: host.sessionId });
    await first.stop();
    fake.resumeAsSnapshot = true;

    const second = await start(fake, store);
    expect((await second.call('list_sessions')).text).toContain('again after a restart');
    const [old, now] = agents(fake, host.sessionId);
    expect(old!.active).toBe(false);
    expect(now!.active).toBe(true);
  });

  it('stays out of a session it would have left while idle, but returns to one waiting for review', async () => {
    const { fake, store } = setup();
    const idle = fake.createSession({ state: golden.Z1! });
    const review = fake.createSession({ state: golden.Z1! });
    const first = await start(fake, store);
    await first.call('join_session', { session_id: idle.sessionId });
    await first.call('join_session', { session_id: review.sessionId });
    await first.call('request_review', { session: 's2', status: 'done' });
    await first.stop();

    const second = await start(fake, store, 0);
    const listed = await second.call('list_sessions');
    expect(listed.data.sessions).toMatchObject([{ session: 's2', phase: 'waiting for review', status: 'done' }]);
    expect(agents(fake, idle.sessionId)[0]!.active).toBe(false);
    await until(() =>
      fake.requests.some((r) => r.endpoint === 'poll' && r.body.sessionId === review.sessionId && r.body.presence.phase === 'review'),
    );
  });

  it('forgets a session that ended while the MCP was down, and one it left', async () => {
    const { fake, store } = setup();
    const a = fake.createSession({ state: golden.Z1! });
    const b = fake.createSession({ state: golden.Z1! });
    const first = await start(fake, store);
    await first.call('join_session', { session_id: a.sessionId });
    await first.call('join_session', { session_id: b.sessionId });
    await first.call('leave_session', { session: 's2' });
    await first.stop();
    fake.endSession(a.sessionId, { reason: 'discarded', by: 'Anna' });

    const second = await start(fake, store);
    const listed = await second.call('list_sessions');
    expect(listed.text).toMatch(/Not in any session/);
    expect(listed.text).toContain('Could not return to Base after a restart');
    expect(existsSync(join(store.dir, 'sessions')) ? readdirSync(join(store.dir, 'sessions')) : []).toEqual([]);
  });
});
