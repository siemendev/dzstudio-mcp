import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/config/config.js';
import { Agent } from '../../src/mcp/agent.js';
import { createServer } from '../../src/mcp/server.js';
import { IdAllocator, OpBuilder, readOperation, Scene, writeOperation } from '../../src/scene/index.js';
import { FakeServer } from '../support/fake-server.js';

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));
const FLAG = 'k3f9a0x2mq-2';
const GROUP = 'k3f9a0x2mq-1';

interface Harness {
  fake: FakeServer;
  agent: Agent;
  call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean; data: any }>;
  texts: string[];
  store: ConfigStore;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function harness(opts: { signedIn?: boolean; idleLeaveMs?: number } = {}): Promise<Harness> {
  const fake = new FakeServer();
  const store = new ConfigStore(mkdtempSync(join(tmpdir(), 'dzstudio-mcp-tools-')), {});
  store.addServer('fake', 'http://fake.invalid/dzcollab/');
  if (opts.signedIn !== false) store.setCredential('fake', { token: 't-agent-Patrick', name: 'Patrick' });
  const agent = new Agent({
    store,
    transport: () => fake,
    timing: { pollWaitMs: 100, retryDelayMs: 10, confirmTimeoutMs: 2000 },
    loginWaitMs: 3000,
    ...(opts.idleLeaveMs !== undefined ? { idleLeaveMs: opts.idleLeaveMs } : {}),
  });
  const mcp = createServer(agent);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  const texts: string[] = [];
  cleanup.push(async () => {
    await agent.shutdown();
    await client.close();
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    texts.push(text);
    const json = text.indexOf('\n{');
    let data: any;
    if (json >= 0) {
      const end = text.indexOf('\n\nEvents:');
      try {
        data = JSON.parse(text.slice(json + 1, end >= 0 ? end : undefined));
      } catch {
        data = undefined;
      }
    }
    return { text, isError: !!res.isError, data };
  };
  return { fake, agent, call, texts, store };
}

async function joined(h: Harness, kind: 'local' | 'hosted' = 'local') {
  const host = h.fake.createSession({
    kind,
    state: golden.Z1!,
    hostedRef: kind === 'hosted' ? { provider: 'fake', key: 'basis' } : undefined,
  });
  const r = await h.call('join_session', { session_id: host.sessionId });
  expect(r.isError).toBe(false);
  return host;
}

const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('tools', () => {
  it('lists every tool of the minimum set and the world tools', async () => {
    const h = await harness();
    const client = new Client({ name: 't', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([createServer(h.agent).connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    await client.close();
    expect(tools).toEqual(
      [
        'add_server',
        'check_overlap',
        'class_info',
        'create_objects',
        'delete_objects',
        'ground_at',
        'join_session',
        'leave_session',
        'list_projects',
        'list_servers',
        'list_sessions',
        'login',
        'modify_objects',
        'object_ground',
        'open_project',
        'query_objects',
        'read_scene',
        'release',
        'request_review',
        'session_events',
        'session_info',
        'set_status',
        'switch_session',
        'world_info',
        'world_objects',
      ].sort(),
    );
    expect(tools).not.toContain('create_project');
  });

  it('logs in with a code in two calls and keeps the token out of every result', async () => {
    const h = await harness({ signedIn: false });
    const servers = await h.call('list_servers');
    expect(servers.data.servers[0]).toMatchObject({ name: 'fake', signedIn: false, agents: true });
    expect((await h.call('list_projects')).text).toBe('Not signed in to fake — call login');
    const first = await h.call('login');
    expect(first.text).toContain('https://fake/login?code=ABCD0001');
    expect(first.data.code).toBe('ABCD-0001');
    setTimeout(() => h.fake.codeLogins.set('ABCD0001', { state: 'confirmed', name: 'Patrick' }), 100);
    const second = await h.call('login');
    expect(second.text).toBe('Signed in as Patrick');
    expect(h.store.credential('fake')?.name).toBe('Patrick');
    await joined(h);
    await h.call('read_scene');
    for (const t of h.texts) expect(t).not.toContain('t-agent-');
  });

  it('reports a denied login', async () => {
    const h = await harness({ signedIn: false });
    await h.call('login');
    h.fake.codeLogins.set('ABCD0001', { state: 'denied' });
    expect(await h.call('login')).toMatchObject({ isError: true, text: 'Sign-in denied' });
  });

  it('a rejected token asks for login again', async () => {
    const h = await harness();
    h.fake.invalidTokens.add('t-agent-Patrick');
    expect((await h.call('list_projects')).text).toBe('Not signed in to fake — call login');
    expect(h.store.credential('fake')).toBeUndefined();
  });

  it('does not join a server without agents', async () => {
    const h = await harness();
    h.fake.capabilities = ['hosted'];
    const host = h.fake.createSession({ state: golden.Z1! });
    expect(await h.call('join_session', { session_id: host.sessionId })).toMatchObject({ isError: true, text: 'Server knows no agents' });
    expect(h.fake.count('session/join')).toBe(0);
  });

  it('joins, reads the scene and finds objects', async () => {
    const h = await harness();
    await joined(h);
    const scene = await h.call('read_scene');
    expect(scene.data.groups).toEqual([
      {
        id: GROUP,
        name: 'Objekte',
        color: '#60A5FA',
        objects: 1,
        hidden: false,
        locked: false,
        bounds: { minX: 1234.5679, minZ: 9876.543, maxX: 1234.5679, maxZ: 9876.543 },
      },
    ]);
    const near = await h.call('query_objects', { near: { x: 1234, z: 9876, radius: 5 } });
    expect(near.data.objects).toEqual([
      {
        id: FLAG,
        class: 'StaticFlagPole',
        group: GROUP,
        position: [1234.5679, 150.125, 9876.543],
        orientation: [46.2, 0, 0],
        scale: 1,
        hidden: false,
        locked: false,
        customString: 'Flag_DayZ',
      },
    ]);
    expect((await h.call('query_objects', { near: { x: 0, z: 0, radius: 5 } })).data.total).toBe(0);
    expect((await h.call('query_objects', { class: 'staticflagpole' })).data.total).toBe(1);
    const sessions = await h.call('list_sessions');
    expect(sessions.data.sessions[0]).toMatchObject({ session: 's1', current: true, phase: 'waiting for work' });
  });

  it('creates a group with objects as one step, locking the new objects first', async () => {
    const h = await harness();
    const host = await joined(h);
    const r = await h.call('create_objects', {
      groups: [{ ref: 'camp', name: 'Military camp' }],
      objects: [
        { class: 'Land_Mil_Tent_Big1_1', group: 'camp', position: [6512, 210.4, 9300], orientation: [370, 0, 0] },
        { class: 'Barrel_Blue', group: 'Objekte', position: [6515.25, 210, 9301] },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/^Done in one step .*: 1 group, 2 objects/);
    const log = h.fake.sessions.get(host.sessionId)!.log;
    expect(log.length).toBe(1);
    const op = readOperation(log[0]!.parts.flat().join(''));
    expect(op.type).toBe('projects:edit');
    expect(op.authorName).toBe('Patrick');
    expect(op.changes.map((c) => c.k)).toEqual(['create', 'create', 'create']);
    const tent = op.changes[1]!;
    expect(tent.k === 'create' && Object.fromEntries(tent.el.fields)).toEqual({
      customString: '',
      name: 'Land_Mil_Tent_Big1_1',
      persist: '0',
      pos: '6512.0 210.4 9300.0',
      scale: '1.0',
      ypr: '10.0 0.0 0.0',
    });
    const group = op.changes[0]!;
    expect(group.k === 'create' && Object.fromEntries(group.el.fields)).toMatchObject({
      name: 'Military camp',
      file: 'military-camp.json',
      format: 'spawner',
    });
    const order = h.fake.requests.map((x) => x.endpoint).filter((e) => e === 'locks/set' || e === 'ops/send');
    expect(order).toEqual(['locks/set', 'ops/send']);
    const lock = h.fake.requests.find((x) => x.endpoint === 'locks/set')!;
    expect(lock.body.elements).toEqual(r.data.objects);
  });

  it('changes nothing when someone else edits an object', async () => {
    const h = await harness();
    const host = await joined(h);
    h.fake.lockAs(host.sessionId, host.participantId, [FLAG]);
    await new Promise((r) => setTimeout(r, 150));
    const r = await h.call('modify_objects', { changes: [{ id: FLAG, position: [1, 2, 3] }] });
    expect(r).toMatchObject({ isError: true, text: '1 object is being edited by Anna' });
    expect(h.fake.count('ops/send')).toBe(0);
  });

  it('modifies, moves and deletes its own objects', async () => {
    const h = await harness();
    const host = await joined(h);
    const created = await h.call('create_objects', {
      groups: [{ ref: 'g', name: 'Fences' }],
      objects: [{ class: 'Fence', group: 'g', position: [1, 2, 3] }],
    });
    const obj = created.data.objects[0];
    const groupId = created.data.groups.g;
    const mod = await h.call('modify_objects', {
      changes: [
        { id: obj, position: [4, 5, 6], scale: 1.5 },
        { id: groupId, name: 'Fences north' },
      ],
    });
    expect(mod.isError).toBe(false);
    const moved = await h.call('modify_objects', { changes: [{ id: obj, group: GROUP }] });
    expect(moved.isError).toBe(false);
    const q = await h.call('query_objects', { ids: [obj] });
    expect(q.data.objects[0]).toMatchObject({ group: GROUP, position: [4, 5, 6], scale: 1.5, heldBy: 'you' });
    const del = await h.call('delete_objects', { ids: [groupId, obj] });
    expect(del.text).toMatch(/1 group, 1 object deleted/);
    const state = h.agent.sessions.get('s1')!.collab!.scene;
    expect(state.has(obj)).toBe(false);
    expect(state.has(groupId)).toBe(false);
    expect(h.fake.sessions.get(host.sessionId)!.log.length).toBe(4);
  });

  it('reports a step that someone else made impossible', async () => {
    const h = await harness();
    const host = await joined(h);
    const other = new Scene(new IdAllocator('m1x0c7r2ab'));
    other.open(golden.Z1!);
    const b = new OpBuilder(other, 'placement:edit', { author: 'a1a1a1a1a1a1a1a1', authorName: 'Anna' });
    b.deleteTree(FLAG);
    const del = b.finish();
    h.fake.beforeOpsSend = () => h.fake.appendAs(host.sessionId, host.participantId, del.id, writeOperation(del));
    const r = await h.call('modify_objects', { changes: [{ id: FLAG, position: [1, 1, 1] }] });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain('Step no longer possible: Object was deleted');
  });

  it('validates the status and shows phase and status in presence', async () => {
    const h = await harness();
    await joined(h);
    expect(await h.call('set_status', { phase: 'working', status: 'x'.repeat(201) })).toMatchObject({
      isError: true,
      text: 'Status too long (at most 200 bytes)',
    });
    expect(await h.call('set_status', { phase: 'working', status: 'a\nb' })).toMatchObject({
      isError: true,
      text: 'Status must be one line',
    });
    const ok = await h.call('set_status', { phase: 'working', status: 'ä'.repeat(100) });
    expect(ok.isError).toBe(false);
    await until(() =>
      h.fake.requests.some(
        (x) => x.endpoint === 'poll' && x.body.presence.phase === 'working' && x.body.presence.status === 'ä'.repeat(100),
      ),
    );
  });

  it('request_review releases everything; a save past its last step puts it back to waiting', async () => {
    const h = await harness();
    const host = await joined(h, 'hosted');
    await h.call('create_objects', { objects: [{ class: 'Barrel_Blue', group: GROUP, position: [1, 2, 3] }] });
    const r = await h.call('request_review', { status: 'placed one barrel' });
    expect(r.text).toMatch(/^Waiting for review — placed one barrel/);
    const lastLock = h.fake.requests.filter((x) => x.endpoint === 'locks/set').at(-1)!;
    expect(lastLock.body.elements).toEqual([]);
    h.fake.save(host.sessionId, 'Anna');
    const ev = await h.call('session_events', { wait_seconds: 2 });
    expect(ev.text).toContain('[s1] Saved by Anna');
    expect((await h.call('list_sessions')).data.sessions[0].phase).toBe('waiting for work');
  });

  it('reports removal and forgets the session', async () => {
    const h = await harness();
    const host = await joined(h);
    const pid = h.agent.sessions.get('s1')!.collab!.participantId;
    h.fake.remove(host.sessionId, pid, 'Anna');
    const ev = await h.call('session_events', { wait_seconds: 2 });
    expect(ev.text).toContain('[s1] Anna removed you from the session');
    expect(await h.call('read_scene')).toMatchObject({ isError: true, text: 'Not in a session' });
  });

  it('works in two sessions and switches between them', async () => {
    const h = await harness();
    const a = await joined(h);
    const b = await joined(h);
    expect(h.agent.current).toBe('s2');
    await h.call('create_objects', { objects: [{ class: 'B', group: GROUP, position: [0, 0, 0] }] });
    expect(h.fake.sessions.get(b.sessionId)!.log.length).toBe(1);
    expect(h.fake.sessions.get(a.sessionId)!.log.length).toBe(0);
    await h.call('switch_session', { session: 's1' });
    await h.call('set_status', { phase: 'working', status: 'only in A' });
    await until(() =>
      h.fake.requests.some((x) => x.endpoint === 'poll' && x.body.sessionId === a.sessionId && x.body.presence.status === 'only in A'),
    );
    const inB = h.fake.requests.filter((x) => x.endpoint === 'poll' && x.body.sessionId === b.sessionId);
    expect(inB.every((x) => x.body.presence.status !== 'only in A')).toBe(true);
  });

  it('leaves when idle and joins again on the next task', async () => {
    const h = await harness({ idleLeaveMs: 0 });
    await joined(h);
    await h.agent.checkIdle();
    expect(h.fake.count('session/leave')).toBe(1);
    const r = await h.call('create_objects', { objects: [{ class: 'B', group: GROUP, position: [0, 0, 0] }] });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Joined again after leaving while idle');
    expect(h.fake.count('session/join')).toBe(2);
  });

  it('opens a project by name through its running session', async () => {
    const h = await harness();
    const host = h.fake.createSession({ kind: 'hosted', state: golden.Z1!, hostedRef: { provider: 'fake', key: 'basis' } });
    h.fake.projects = [
      {
        hostedRef: { provider: 'fake', key: 'basis' },
        projectName: 'Basis Nord',
        map: 'chernarus',
        canSave: true,
        sessionId: host.sessionId,
      },
    ];
    const r = await h.call('open_project', { project: 'basis nord' });
    expect(r.isError).toBe(false);
    h.fake.projects = [{ hostedRef: { provider: 'fake', key: 'other' }, projectName: 'Other', map: 'livonia', canSave: true }];
    expect((await h.call('open_project', { project: 'Other' })).text).toBe(
      'No session is running for Other. A person has to open it in dzStudio first.',
    );
  });

  it('joins with an invitation code', async () => {
    const h = await harness();
    h.fake.createSession({ state: golden.Z1! });
    expect((await h.call('join_session', { code: 'GOOD-CODE' })).isError).toBe(false);
    expect((await h.call('join_session', { code: 'BAD' })).text).toBe('This code is not valid (any more) — ask for a new one');
  });

  it('session_info names agents and humans', async () => {
    const h = await harness();
    const host = await joined(h);
    h.fake.lockAs(host.sessionId, host.participantId, [FLAG]);
    await until(() => (h.agent.sessions.get('s1')!.collab!.participants.length ?? 0) === 2);
    await new Promise((r) => setTimeout(r, 150));
    const info = await h.call('session_info');
    expect(info.data.participants).toEqual([
      expect.objectContaining({ name: 'Anna', kind: 'human', you: false, held: 1 }),
      expect.objectContaining({ name: "Patrick's agent", kind: 'agent', you: true, phase: 'waiting for work' }),
    ]);
    expect(info.data.rights).toEqual({ canSave: false, canManage: false, canInvite: false });
  });

  it('leaves a session', async () => {
    const h = await harness();
    await joined(h);
    expect((await h.call('leave_session')).text).toBe('Left s1');
    expect(h.fake.count('session/leave')).toBe(1);
    expect((await h.call('list_sessions')).text).toMatch(/^Not in any session/);
  });
});
