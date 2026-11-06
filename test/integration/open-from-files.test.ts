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
import { WorldDataSource } from '../../src/world/source.js';
import { WorldTools } from '../../src/world/tools.js';
import { referenceServerAvailable, startReferenceServer, type ReferenceServer } from '../support/reference-server.js';
import { FIXTURE } from '../support/world-fixture.js';

/**
 * A hosted project lies on the reference server's disk and nobody has it open: the agent loads its files, builds the
 * state as dzStudio does and starts the session alone. A person who joins afterwards gets exactly that state.
 */

const golden: Record<string, string> = JSON.parse(readFileSync(new URL('../fixtures/golden.json', import.meta.url), 'utf8'));

// The files of the golden example G1, as dzStudio saves them: the store's manifest and the Object Spawner file.
const MANIFEST =
  '{\n    "format": "dzstudio-project",\n    "version": 1,\n    "project": {\n        "groups": [\n            {\n' +
  '                "file": "objekte.json",\n                "name": "Objekte",\n                "color": "#60A5FA",\n' +
  '                "hidden": false,\n                "locked": false,\n                "objectCount": 1,\n' +
  '                "objects": [],\n                "plugins": {}\n            }\n        ],\n        "loot": {\n' +
  '            "enabled": false,\n            "hidden": false,\n            "locked": false,\n            "projectId": null,\n' +
  '            "writtenTypes": []\n        },\n        "plugins": {}\n    }\n}\n';
const OBJEKTE =
  '{\n    "Objects": [\n        {\n            "name": "StaticFlagPole",\n            "pos": [1234.5679, 150.125, 9876.543],\n' +
  '            "ypr": [46.2, 0.0, 0.0],\n            "scale": 1.0,\n            "enableCEPersistency": 0,\n' +
  '            "customString": "Flag_DayZ"\n        }\n    ]\n}\n';

describe.skipIf(!referenceServerAvailable)('opening a hosted project without a running session', () => {
  let server: ReferenceServer | undefined;
  let agent: Agent;
  let mcp: Client;
  let client: CollabClient;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    const text = res.content.map((c) => c.text).join('\n');
    const json = text.indexOf('\n{');
    const end = text.indexOf('\n\nEvents:');
    const data = json >= 0 ? JSON.parse(text.slice(json + 1, end >= 0 ? end : undefined)) : undefined;
    return { text: json >= 0 ? text.slice(0, json) : end >= 0 ? text.slice(0, end) : text, isError: !!res.isError, data };
  };

  beforeAll(async () => {
    server = await startReferenceServer(
      {
        server: { name: 'MCP open from files' },
        storage: { type: 'memory' },
        auth: {
          secret: 'integration-secret-integration-secret-03',
          name: { enabled: true },
          code: { enabled: true, expiresInSeconds: 600, intervalSeconds: 2 },
        },
        users: [{ id: 'patrick', name: 'Patrick', password: 'patrick-password' }],
        permissions: {
          hostLocal: ['*'],
          hosted: [{ provider: 'fs', key: '*', join: ['*'], save: ['patrick', 'name:Anna'], manage: ['name:Anna'] }],
        },
        hosted: { enabled: true, stores: [{ provider: 'fs', root: 'projects', map: 'testmap' }] },
        agents: { enabled: true },
      },
      async (dir) => {
        const project = (key: string, name: string, files: Record<string, string>): void => {
          mkdirSync(join(dir, 'projects', key), { recursive: true });
          mkdirSync(join(dir, 'projects', '.meta'), { recursive: true });
          for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, 'projects', key, f), text);
          writeFileSync(join(dir, 'projects', '.meta', `${key}.json`), JSON.stringify({ projectName: name, map: 'testmap' }));
        };
        project('basis', 'Basis', { manifest: MANIFEST, 'objekte.json': OBJEKTE, 'mapgroupproto.xml': '<prototype/>' });
        project('baeume', 'Bäume', { 'baeume.json': '{"Objects":[{"name":"DZ\\\\plants\\\\tree\\\\t_betulapendula_3f.p3d"}]}' });
      },
    );
    const configDir = mkdtempSync(join(tmpdir(), 'dzstudio-mcp-open-'));
    const store = new ConfigStore(configDir, { DZSTUDIO_MCP_AGENT_NAME: 'Scout', DZSTUDIO_MCP_WORLD_DATA: FIXTURE });
    agent = new Agent({ store, timing: { pollWaitMs: 500 }, loginWaitMs: 10_000 });
    const world = new WorldTools(agent, new WorldDataSource(store.worldData()));
    // The fixture's class data know WoodenCrate only; the game knows the flag pole of G1 as well.
    agent.classes = async () => ({ knows: (n: string) => ['staticflagpole', 'woodencrate'].includes(n.toLowerCase()) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    mcp = new Client({ name: 'open', version: '1' });
    await Promise.all([createServer(agent, world).connect(a), mcp.connect(b)]);
    client = new CollabClient(new HttpTransport(server.base));

    await call('add_server', { name: 'ref', url: server.base });
    const start = await call('login');
    const form = new URLSearchParams({ code: start.data.code, user: 'patrick', password: 'patrick-password', action: 'confirm' });
    await fetch(start.data.url, { method: 'POST', body: form, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await call('login')).text).toBe('Signed in as Patrick');
  }, 180_000);

  afterAll(async () => {
    await agent?.shutdown();
    await mcp?.close();
    await server?.stop();
  });

  it('loads the files, starts the session with the state dzStudio builds, and a person joining gets it', async () => {
    const listed = await call('list_projects');
    expect(listed.data.projects).toContainEqual({ key: 'basis', name: 'Basis', map: 'testmap', sessionRunning: false, canSave: true });

    const opened = await call('open_project', { project: 'Basis' });
    expect(opened.isError).toBe(false);
    expect(opened.text).toBe('Opened Basis from its files (1 group, 1 object) and started a session as s1; it is the current session');
    expect(opened.data).toMatchObject({ project: 'Basis', map: 'testmap', kind: 'hosted', phase: 'waiting for work' });

    const anna = await client.request('auth/name', {
      requestId: requestId(),
      name: 'Anna',
      client: { name: 'dzstudio', version: '0.4.0' },
    });
    const running = (await client.request('sessions/list', { hostedRef: { provider: 'fs', key: 'basis' } }, anna.token)).sessions as Json[];
    expect(running).toHaveLength(1);
    const joined = await client.request(
      'session/join',
      {
        requestId: requestId(),
        client: { name: 'dzstudio', version: '0.4.0' },
        sessionId: running[0]!.sessionId,
        instanceKey: 'a1b2c3d4e5',
      },
      anna.token,
    );
    expect(joined).toMatchObject({ mode: 'snapshot', snapshot: { seq: 0 } });
    const snap = await client.request(
      'snapshot/get',
      { sessionId: running[0]!.sessionId, participantId: joined.participantId, seq: 0, part: 0 },
      anna.token,
    );
    const text = (snap.pieces as string[]).join('');
    const prefix = /"id":"([0-9a-z]{10})-1"/.exec(text)![1]!;
    expect(text.replaceAll(prefix, 'k3f9a0x2mq')).toBe(golden.Z1);

    const made = await call('create_objects', { objects: [{ class: 'WoodenCrate', group: 'Objekte', position: [1240.5, 150, 9880.25] }] });
    expect(made.text).toMatch(/^Done in one step/);
    expect(made.data.objects[0]).toBe(`${prefix}-4`);

    const again = await call('open_project', { project: 'basis' });
    expect(again.text).toBe('Already in this session as s1');
  }, 60_000);

  it('refuses a project only the game can open, and starts no session', async () => {
    const refused = await call('open_project', { project: 'Bäume' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Cannot open Bäume from its files: It places a model by its path');
    const anna = await client.request('auth/name', {
      requestId: requestId(),
      name: 'Anna',
      client: { name: 'dzstudio', version: '0.4.0' },
    });
    const running = await client.request('sessions/list', { hostedRef: { provider: 'fs', key: 'baeume' } }, anna.token);
    expect(running.sessions).toEqual([]);
  }, 30_000);
});
