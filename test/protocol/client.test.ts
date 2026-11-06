import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentClient, CollabClient } from '../../src/protocol/client.js';
import { CollabError, HttpTransport, parseResponse, UnreachableError } from '../../src/protocol/transport.js';
import { FakeServer } from '../support/fake-server.js';

describe('transport', () => {
  it('needs the header line and one JSON object', () => {
    expect(parseResponse('dzcollab 1\n{"ok":true,"x":1}')).toEqual({ ok: true, x: 1 });
    expect(() => parseResponse('<html>proxy error</html>')).toThrow(UnreachableError);
    expect(() => parseResponse('dzcollab 1\n{"ok":tr')).toThrow(UnreachableError);
    expect(() => parseResponse('dzcollab 1\n[1]')).toThrow(UnreachableError);
  });

  describe('over HTTP', () => {
    let server: Server;
    let base = '';
    const seen: { url: string; method: string; body: string }[] = [];
    beforeAll(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen.push({ url: req.url!, method: req.method!, body });
          if (req.url!.endsWith('/broken')) res.end('<html>502</html>');
          else if (req.url!.endsWith('/info'))
            res.end(
              'dzcollab 1\n{"ok":true,"server":{"name":"T"},"protocols":[{"major":1,"minor":0}],"capabilities":["agents"],"auth":[{"method":"code"}],"limits":{}}',
            );
          else res.end('dzcollab 1\n{"ok":false,"error":{"code":"not_allowed","message":"no"}}');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/dzcollab`;
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('GETs info and POSTs requests with protocol and token in the body', async () => {
      const c = new CollabClient(new HttpTransport(base));
      const info = await c.info();
      expect(info).toMatchObject({ name: 'T', capabilities: ['agents'] });
      await expect(c.request('session/leave', { sessionId: 's' }, 'tok')).rejects.toMatchObject({ code: 'not_allowed' });
      const post = seen.find((s) => s.url === '/dzcollab/session/leave')!;
      expect(post.method).toBe('POST');
      expect(JSON.parse(post.body)).toEqual({ protocol: '1.0', sessionId: 's', token: 'tok' });
      expect(seen.find((s) => s.url === '/dzcollab/info')!.method).toBe('GET');
    });

    it('a proxy page is "Server not reachable"', async () => {
      const t = new HttpTransport(base + '/');
      await expect(t.call('broken', {})).rejects.toThrow(/Server not reachable/);
    });

    it('a closed port is "Server not reachable"', async () => {
      const t = new HttpTransport('http://127.0.0.1:1/');
      await expect(t.call('info', undefined, { method: 'GET', timeoutMs: 2000 })).rejects.toBeInstanceOf(UnreachableError);
    });
  });
});

describe('client', () => {
  it('code login: start, waiting, confirmed', async () => {
    const fake = new FakeServer();
    const c = new CollabClient(fake);
    const start = await c.codeStart(agentClient('Scout'));
    expect(start).toMatchObject({ loginCode: 'ABCD0001', intervalSeconds: 2 });
    expect(fake.requests[0]!.body.client).toEqual({ name: 'dzstudio-mcp', version: '0.1.0', kind: 'agent', agentName: 'Scout' });
    expect(await c.codePoll(start.loginCode)).toEqual({ state: 'waiting' });
    fake.codeLogins.set(start.loginCode, { state: 'confirmed', name: 'Patrick' });
    expect(await c.codePoll(start.loginCode)).toEqual({ state: 'confirmed', token: 't-agent-Patrick', name: 'Patrick' });
    fake.codeLogins.set(start.loginCode, { state: 'denied' });
    expect(await c.codePoll(start.loginCode)).toEqual({ state: 'denied' });
  });

  it('errors carry their code', async () => {
    const fake = new FakeServer();
    const c = new CollabClient(fake);
    const e = await c.sessionsList('nope').catch((x) => x);
    expect(e).toBeInstanceOf(CollabError);
    expect(e.code).toBe('auth_required');
  });

  it('lists sessions and projects', async () => {
    const fake = new FakeServer();
    fake.projects = [{ hostedRef: { provider: 'fake', key: 'a' }, projectName: 'A', map: 'chernarus', canSave: true }];
    fake.createSession({ state: '{"textform":1,"state":{"kinds":{},"elements":[]}}' });
    const c = new CollabClient(fake);
    expect((await c.sessionsList('t-Patrick')).length).toBe(1);
    expect((await c.projectList('t-Patrick')).projects).toEqual(fake.projects);
  });
});
