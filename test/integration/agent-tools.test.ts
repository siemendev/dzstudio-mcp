import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../../src/config/config.js';
import { Agent } from '../../src/mcp/agent.js';
import { createServer } from '../../src/mcp/server.js';
import { CollabClient, requestId } from '../../src/protocol/client.js';
import { HttpTransport, type Json } from '../../src/protocol/transport.js';
import { chunk } from '../../src/scene/index.js';
import { WorldDataSource } from '../../src/world/source.js';
import { WorldTools } from '../../src/world/tools.js';
import { referenceServerAvailable, startReferenceServer, type ReferenceServer } from '../support/reference-server.js';
import { FIXTURE } from '../support/world-fixture.js';

/**
 * The whole agent flow through the MCP tools, driven by an MCP client, against the reference collaboration server:
 * a person (a plain protocol client) hosts a session of a project on the server, the agent signs in with a code,
 * joins it, works and asks for review; the person sees every step. Skipped without Go and without a server binary.
 */

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));

/** A person in dzStudio, reduced to the protocol: polls, and keeps what it saw. */
class Human {
  cursor = 0;
  ops: string[] = [];
  participants: Json[] = [];
  presence: Json[] = [];

  constructor(
    readonly client: CollabClient,
    readonly token: string,
    readonly sessionId: string,
    readonly participantId: string,
  ) {}

  async poll(): Promise<void> {
    const res = await this.client.request('poll', {
      token: this.token,
      sessionId: this.sessionId,
      participantId: this.participantId,
      after: this.cursor,
      waitMs: 0,
      versions: {},
      presence: { idleSeconds: 0, position: [150, 100, 200] },
    });
    for (const op of res.ops ?? []) {
      this.ops.push(op.pieces.join(''));
      this.cursor = Math.max(this.cursor, op.seq);
    }
    if (res.participants?.list) this.participants = res.participants.list;
    this.presence = res.presence ?? this.presence;
  }

  async until(what: string, cond: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
      await this.poll();
      if (cond()) return;
      if (Date.now() > end) throw new Error(`the person never saw: ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  agentPresence(): Json | undefined {
    const agent = this.participants.find((p) => p.kind === 'agent');
    return agent && this.presence.find((p) => p.participantId === agent.participantId);
  }
}

describe.skipIf(!referenceServerAvailable)('agent flow through the MCP tools against the reference server', () => {
  let server: ReferenceServer | undefined;
  let agent: Agent;
  let mcp: Client;
  let configDir = '';
  const transcript: string[] = [];

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    transcript.push(`${res.isError ? '✗' : '→'} ${name}: ${text.split('\n')[0]}`);
    const json = text.indexOf('\n{');
    const end = text.indexOf('\n\nEvents:');
    const data = json >= 0 ? JSON.parse(text.slice(json + 1, end >= 0 ? end : undefined)) : undefined;
    const summary = json >= 0 ? text.slice(0, json) : end >= 0 ? text.slice(0, end) : text;
    return { text: summary, isError: !!res.isError, data };
  };

  beforeAll(async () => {
    server = await startReferenceServer(
      {
        server: { name: 'MCP end-to-end' },
        storage: { type: 'memory' },
        auth: {
          secret: 'integration-secret-integration-secret-02',
          name: { enabled: true },
          code: { enabled: true, expiresInSeconds: 600, intervalSeconds: 2 },
        },
        users: [{ id: 'patrick', name: 'Patrick', password: 'patrick-password' }],
        permissions: {
          hostLocal: ['*'],
          hosted: [{ provider: 'fs', key: '*', join: ['*'], save: ['name:Anna'], manage: ['name:Anna'] }],
        },
        hosted: { enabled: true, stores: [{ provider: 'fs', root: 'projects', map: 'testmap' }] },
        agents: { enabled: true },
      },
      async (dir) => {
        mkdirSync(join(dir, 'projects', 'camp'), { recursive: true });
        mkdirSync(join(dir, 'projects', '.meta'), { recursive: true });
        writeFileSync(join(dir, 'projects', 'camp', 'manifest'), '{"v":1}');
        writeFileSync(join(dir, 'projects', '.meta', 'camp.json'), JSON.stringify({ projectName: 'Camp', map: 'testmap' }));
      },
    );
    configDir = mkdtempSync(join(tmpdir(), 'dzstudio-mcp-e2e-'));
    const store = new ConfigStore(configDir, { DZSTUDIO_MCP_AGENT_NAME: 'Scout', DZSTUDIO_MCP_WORLD_DATA: FIXTURE });
    agent = new Agent({ store, timing: { pollWaitMs: 500 }, loginWaitMs: 10_000 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'e2e', version: '1' });
    await Promise.all([createServer(agent, new WorldTools(agent, new WorldDataSource(store.worldData()))).connect(a), mcp.connect(b)]);
  }, 180_000);

  afterAll(async () => {
    await agent?.shutdown();
    await mcp?.close();
    await server?.stop();
    if (transcript.length) console.log(transcript.join('\n'));
  });

  it('signs in, joins a person’s session, works, asks for review, cannot save, leaves', async () => {
    const base = server!.base;
    const added = await call('add_server', { name: 'ref', url: base });
    expect(added.data).toMatchObject({ name: 'ref', agents: true, login: expect.arrayContaining(['code']) });

    const start = await call('login');
    expect(start.text).toMatch(/^Ask the user to open .* and confirm the code [A-Z0-9]{4}-[A-Z0-9]{4}\. Then call login again/);
    const form = new URLSearchParams({ code: start.data.code, user: 'patrick', password: 'patrick-password', action: 'confirm' });
    const page = await fetch(start.data.url, {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(await page.text()).toMatch(/Login confirmed/);
    expect((await call('login')).text).toBe('Signed in as Patrick');

    const client = new CollabClient(new HttpTransport(base));
    const anna = await client.request('auth/name', {
      requestId: requestId(),
      name: 'Anna',
      client: { name: 'dzstudio', version: '0.4.0' },
    });
    const hostedRef = { provider: 'fs', key: 'camp' };
    const { hostedRevision } = await client.request('project/revision', { hostedRef }, anna.token);
    const created = await client.request(
      'session/create',
      {
        requestId: requestId(),
        client: { name: 'dzstudio', version: '0.4.0' },
        projectName: 'Camp',
        map: 'testmap',
        kind: 'hosted',
        hostedRef,
        hostedRevision,
        instanceKey: 'a1b2c3d4e5',
        snapshotBytes: Buffer.byteLength(golden.Z1!),
        snapshotParts: 1,
      },
      anna.token,
    );
    await client.request(
      'snapshot/put',
      { sessionId: created.sessionId, participantId: created.participantId, seq: 0, part: 0, parts: 1, pieces: chunk(golden.Z1!) },
      anna.token,
    );
    const human = new Human(client, anna.token, created.sessionId, created.participantId);
    await human.poll();

    const projects = await call('list_projects');
    expect(projects.data.projects).toEqual([{ key: 'camp', name: 'Camp', map: 'testmap', sessionRunning: true, canSave: false }]);
    const joined = await call('open_project', { project: 'Camp' });
    expect(joined.text).toBe('Joined Camp as s1; it is the current session');
    expect(joined.data).toMatchObject({ map: 'testmap', kind: 'hosted', phase: 'waiting for work' });
    await human.until('the agent joining', () => human.participants.some((p) => p.kind === 'agent'));
    expect(human.participants.find((p) => p.kind === 'agent')).toMatchObject({ name: 'Patrick', agentName: 'Scout', canSave: false });

    expect((await call('set_status', { phase: 'working', status: 'building a small camp' })).text).toBe(
      'Phase: working — building a small camp',
    );
    await human.until('phase working', () => human.agentPresence()?.phase === 'working');
    expect(human.agentPresence()?.status).toBe('building a small camp');

    const ground = await call('object_ground', { placement: { class: 'WoodenCrate', position: [100, 100, 300] } });
    expect(ground.isError).toBe(false);
    expect(ground.data.objects[0]).toMatchObject({ min: 0, max: 0 });

    const made = await call('create_objects', {
      groups: [{ ref: 'g', name: 'Camp' }],
      objects: [
        { class: 'WoodenCrate', group: 'g', position: [100, 100, 300] },
        { class: 'WoodenCrate', group: 'g', position: [104, 100, 300], orientation: [90, 0, 0] },
      ],
    });
    expect(made.text).toMatch(/^Done in one step \(.+\): 1 group, 2 objects$/);
    await human.until('the agent’s step', () => human.ops.length === 1);
    expect(human.ops[0]).toContain('WoodenCrate');
    expect(human.ops[0]).toContain(made.data.objects[0]);

    const review = await call('request_review', { status: 'two crates by the road' });
    expect(review.text).toBe('Waiting for review — two crates by the road. A person saves or discards.');
    await human.until('phase review', () => human.agentPresence()?.phase === 'review');
    expect(human.agentPresence()?.status).toBe('two crates by the road');

    const tools = (await mcp.listTools()).tools.map((t) => t.name);
    expect(tools.filter((t) => /save|discard|end_session|invite|remove/.test(t))).toEqual([]);
    const save = await call('save_project');
    expect(save.isError).toBe(true);
    const token = JSON.parse(readFileSync(join(configDir, 'credentials.json'), 'utf8')).ref.token as string;
    const me = human.participants.find((p) => p.kind === 'agent')!;
    const denied = await client.transport.call('project/save', {
      protocol: '1.0',
      token,
      requestId: requestId(),
      sessionId: created.sessionId,
      participantId: me.participantId,
      seq: human.cursor,
      files: [],
      deleted: [],
    });
    expect(denied).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    transcript.push(`✗ project/save with the agent's token: ${denied.error.code}`);

    const info = await call('session_info');
    expect(info.data.rights).toEqual({ canSave: false, canManage: false, canInvite: false });
    expect(info.data.saving).toMatchObject({ unsavedChanges: 1 });

    expect((await call('leave_session')).text).toBe('Left s1');
    await human.until('the agent leaving', () => !human.participants.some((p) => p.kind === 'agent'));
    const listed = await client.request('sessions/list', { hostedRef }, anna.token);
    expect(listed.sessions[0]).toMatchObject({ unsavedCount: 1, participants: 1 });
  }, 60_000);
});
