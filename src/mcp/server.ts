import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CLIENT_VERSION } from '../protocol/client.js';
import { CollabError } from '../protocol/transport.js';
import { WorldDataSource } from '../world/source.js';
import { MAX_POINTS, WorldTools, type Placement } from '../world/tools.js';
import { Agent, ToolError, type ToolResult } from './agent.js';

const session = z.string().optional().describe('Session handle (s1, s2 …) or session id; default: the current session');
const server = z.string().optional().describe('Server name; default: the first configured server');
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const map = z
  .string()
  .optional()
  .describe('Map key (chernarus, livonia, sakhal, badlands …) or world name; default: the map of the session');
const placement = z
  .object({
    class: z.string(),
    position: vec3,
    orientation: vec3.optional().describe('[yaw, pitch, roll] in degrees'),
    scale: z.number().positive().optional(),
  })
  .optional()
  .describe('A hypothetical object: class, position [x, y, z], orientation, scale');

/** Formats a result for the model: a summary line, the data as JSON, and the events since the last result. */
export function format(result: ToolResult, events: string[]): CallToolResult {
  let text = result.text;
  if (result.data !== undefined) text += '\n' + JSON.stringify(result.data, null, 1);
  if (events.length) text += '\n\nEvents:\n' + events.map((e) => `- ${e}`).join('\n');
  return { content: [{ type: 'text', text }] };
}

export function createServer(agent: Agent, world?: WorldTools): McpServer {
  const w = world ?? new WorldTools(agent, new WorldDataSource(agent.opts.store.worldData()));
  const mcp = new McpServer({ name: 'dzstudio-mcp', version: CLIENT_VERSION });

  const run =
    <A>(fn: (args: A) => Promise<ToolResult> | ToolResult) =>
    async (args: A): Promise<CallToolResult> => {
      try {
        await agent.ready;
        const result = await fn(args);
        return format(result, agent.collectEvents());
      } catch (e) {
        const message =
          e instanceof ToolError
            ? e.message
            : e instanceof CollabError && e.code === 'not_allowed'
              ? `Not allowed: ${e.error.message ?? 'the server does not let an agent do this'}`
              : `Error: ${(e as Error).message}`;
        const out = format({ text: message }, agent.collectEvents());
        return { ...out, isError: true };
      }
    };

  mcp.registerTool(
    'list_servers',
    {
      description: 'The configured dzStudio collaboration servers: name, address, signed in, and whether they admit agents.',
      inputSchema: {},
    },
    run(() => agent.listServers()),
  );

  mcp.registerTool(
    'add_server',
    {
      description: 'Add a collaboration server under a name of your choice, e.g. "dzbot" or "local". It is kept across restarts.',
      inputSchema: { name: z.string(), url: z.string().describe('Base address, e.g. https://collab.example.org/dzcollab/') },
    },
    run((a: { name: string; url: string }) => agent.addServer(a.name, a.url)),
  );

  mcp.registerTool(
    'login',
    {
      description:
        'Sign in to a server with a code the user confirms in the browser. The first call returns the address and code to give to the user; ' +
        'call it again after they confirmed. The login is kept across restarts. For servers in a local network that only accept a name, pass name.',
      inputSchema: { server, name: z.string().optional().describe('Display name, only for servers that log in by name') },
    },
    run((a: { server?: string; name?: string }) => agent.login(a.server, a.name)),
  );

  mcp.registerTool(
    'list_projects',
    {
      description:
        'Projects on a server the user may open (name, map, whether a session runs, whether they may save), and the sessions the agent may join.',
      inputSchema: { server },
    },
    run((a: { server?: string }) => agent.listProjects(a.server)),
  );

  mcp.registerTool(
    'open_project',
    {
      description:
        'Open a project on the server: join its running session, or, when none is running, load its files and start one ' +
        '(only with the right to save it). Agents never create projects or save.',
      inputSchema: { server, project: z.string().describe('Project key or name') },
    },
    run((a: { server?: string; project: string }) => agent.openProject(a.server, a.project)),
  );

  mcp.registerTool(
    'join_session',
    {
      description: 'Join a session by its id (from list_projects) or with an invitation code. The joined session becomes the current one.',
      inputSchema: { server, session_id: z.string().optional(), code: z.string().optional().describe('Invitation code like ABCD-EFGH') },
    },
    run((a: { server?: string; session_id?: string; code?: string }) => agent.joinSession(a.server, a.session_id, a.code)),
  );

  mcp.registerTool(
    'leave_session',
    {
      description:
        'Leave a session once every change has reached the server (waits up to 10 s). With confirm, leave even if changes are still unsent.',
      inputSchema: { session, confirm: z.boolean().optional() },
    },
    run((a: { session?: string; confirm?: boolean }) => agent.leaveSession(a.session, !!a.confirm)),
  );

  mcp.registerTool(
    'list_sessions',
    { description: 'The sessions the agent is in, with server, project, phase, status and which one is current.', inputSchema: {} },
    run(() => agent.listSessions()),
  );

  mcp.registerTool(
    'switch_session',
    { description: 'Make another session the current one.', inputSchema: { session: z.string() } },
    run((a: { session: string }) => agent.switchSession(a.session)),
  );

  mcp.registerTool(
    'session_info',
    {
      description: 'Participants (humans and agents, phase and status, location, held objects), own rights, and the save state.',
      inputSchema: { session },
    },
    run((a: { session?: string }) => agent.sessionInfo(a.session)),
  );

  mcp.registerTool(
    'session_events',
    {
      description:
        'What happened since the last result: joins, leaves, saves, discards, removal, own steps dropped, locks taken or released, connection. Waits up to wait_seconds (at most 30) for an event.',
      inputSchema: { session, wait_seconds: z.number().min(0).max(30).optional() },
    },
    async (a: { session?: string; wait_seconds?: number }): Promise<CallToolResult> => {
      try {
        await agent.ready;
        const events = await agent.waitEvents(a.session, Math.round((a.wait_seconds ?? 0) * 1000));
        return format({ text: events.length ? `${events.length} event${events.length === 1 ? '' : 's'}` : 'No new events' }, events);
      } catch (e) {
        return { ...format({ text: (e as Error).message }, []), isError: true };
      }
    },
  );

  mcp.registerTool(
    'read_scene',
    {
      description:
        'Overview of the project: map, groups with name, object count, hidden, locked and the X/Z bounds of their objects; loot on or off.',
      inputSchema: { session },
    },
    run((a: { session?: string }) => agent.readScene(a.session)),
  );

  mcp.registerTool(
    'query_objects',
    {
      description:
        'Objects by ids, group (id or name), class, a circle (X, Z, radius in m) or a rectangle (X, Z), with id, class, group, position [x,y,z], orientation [yaw,pitch,roll], scale, hidden, locked and who holds it. Pages of 500.',
      inputSchema: {
        session,
        ids: z.array(z.string()).optional(),
        group: z.string().optional(),
        class: z.string().optional(),
        near: z.object({ x: z.number(), z: z.number(), radius: z.number().positive() }).optional(),
        rect: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }).optional(),
        page: z.number().int().min(0).optional(),
      },
    },
    run(
      (a: {
        session?: string;
        ids?: string[];
        group?: string;
        class?: string;
        near?: { x: number; z: number; radius: number };
        rect?: { minX: number; minZ: number; maxX: number; maxZ: number };
        page?: number;
      }) => {
        const q: Parameters<Agent['queryObjects']>[1] = {};
        if (a.ids) q.ids = a.ids;
        if (a.group) q.group = a.group;
        if (a.class) q.class = a.class;
        if (a.near) q.near = a.near;
        if (a.rect) q.rect = a.rect;
        if (a.page !== undefined) q.page = a.page;
        return agent.queryObjects(a.session, q);
      },
    ),
  );

  mcp.registerTool(
    'create_objects',
    {
      description:
        'Create groups and objects as one step. New groups get a ref you can use as the group of objects in the same call; an object group may also be an existing group id or name. ' +
        'Position [x, y, z] in m, orientation [yaw, pitch, roll] in degrees, scale (default 1). The new objects are held by you until you release them or ask for review.',
      inputSchema: {
        session,
        groups: z.array(z.object({ ref: z.string(), name: z.string(), color: z.string().optional().describe('#RRGGBB') })).optional(),
        objects: z
          .array(
            z.object({
              class: z.string(),
              group: z.string(),
              position: vec3,
              orientation: vec3.optional(),
              scale: z.number().positive().optional(),
            }),
          )
          .optional(),
      },
    },
    run(
      (a: {
        session?: string;
        groups?: { ref: string; name: string; color?: string }[];
        objects?: {
          class: string;
          group: string;
          position: [number, number, number];
          orientation?: [number, number, number];
          scale?: number;
        }[];
      }) =>
        agent.createObjects(
          a.session,
          (a.groups ?? []).map((g) => (g.color ? { ref: g.ref, name: g.name, color: g.color } : { ref: g.ref, name: g.name })),
          (a.objects ?? []).map((o) => {
            const spec: Parameters<Agent['createObjects']>[2][number] = { class: o.class, group: o.group, position: o.position };
            if (o.orientation) spec.orientation = o.orientation;
            if (o.scale !== undefined) spec.scale = o.scale;
            return spec;
          }),
        ),
    ),
  );

  mcp.registerTool(
    'modify_objects',
    {
      description:
        'Change existing objects (position, orientation, scale, group, hidden, locked, persist, customString) or groups (name, color, hidden, locked) as one step. ' +
        'Objects are locked first; if someone else is editing one, nothing changes.',
      inputSchema: {
        session,
        changes: z.array(
          z.object({
            id: z.string(),
            position: vec3.optional(),
            orientation: vec3.optional(),
            scale: z.number().positive().optional(),
            group: z.string().optional(),
            hidden: z.boolean().optional(),
            locked: z.boolean().optional(),
            name: z.string().optional(),
            color: z.string().optional(),
            persist: z.boolean().optional(),
            customString: z.string().optional(),
          }),
        ),
      },
    },
    run((a: { session?: string; changes: Parameters<Agent['modifyObjects']>[1] }) =>
      agent.modifyObjects(
        a.session,
        a.changes.map(
          (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)) as Parameters<Agent['modifyObjects']>[1][number],
        ),
      ),
    ),
  );

  mcp.registerTool(
    'delete_objects',
    {
      description: 'Delete objects or groups (with their objects) as one step. Objects are locked first.',
      inputSchema: { session, ids: z.array(z.string()) },
    },
    run((a: { session?: string; ids: string[] }) => agent.deleteObjects(a.session, a.ids)),
  );

  mcp.registerTool(
    'release',
    {
      description: 'Release held objects so others can edit them: the named ones, or all.',
      inputSchema: { session, ids: z.array(z.string()).optional() },
    },
    run((a: { session?: string; ids?: string[] }) => agent.release(a.session, a.ids)),
  );

  mcp.registerTool(
    'set_status',
    {
      description:
        'Set the phase ("waiting" for work or "working") and a one-line status everyone in the session sees, e.g. "building a military camp at the airfield". At most 200 bytes.',
      inputSchema: { session, phase: z.enum(['waiting', 'working']), status: z.string().optional() },
    },
    run((a: { session?: string; phase: 'waiting' | 'working'; status?: string }) => agent.setStatus(a.session, a.phase, a.status)),
  );

  mcp.registerTool(
    'request_review',
    {
      description:
        'Done: switch to "waiting for review" with an optional summary as status and release everything held. A person then saves or discards; agents never save.',
      inputSchema: { session, status: z.string().optional() },
    },
    run((a: { session?: string; status?: string }) => agent.requestReview(a.session, a.status)),
  );

  mcp.registerTool(
    'world_info',
    {
      description:
        'Which map data exist for the session’s map: world, data revision, game version, export date, class data revision, size, sea level; ' +
        'place names near a point (near: X, Z, radius, default 2000 m) or matching a text (place).',
      inputSchema: {
        session,
        map,
        near: z.object({ x: z.number(), z: z.number(), radius: z.number().positive().optional() }).optional(),
        place: z.string().optional(),
      },
    },
    run((a: { session?: string; map?: string; near?: { x: number; z: number; radius?: number }; place?: string }) =>
      w.worldInfo(a.session, a.map, a.near, a.place),
    ),
  );

  mcp.registerTool(
    'world_objects',
    {
      description:
        'Static map objects (buildings, trees, rocks, walls) and project objects in a circle (X, Z, radius in m) or rectangle, optionally by class or flags ' +
        '(1 building, 2 tree, 4 bush, 8 rock, 256 house): id, source (map or project), class, model, position, orientation [yaw, pitch, roll], scale, distance, size [X, Y, Z] or "box unknown". ' +
        'An object counts if its box touches the area. Pages of 500.',
      inputSchema: {
        session,
        map,
        near: z.object({ x: z.number(), z: z.number(), radius: z.number().min(0) }).optional(),
        rect: z.object({ minX: z.number(), minZ: z.number(), maxX: z.number(), maxZ: z.number() }).optional(),
        class: z.string().optional(),
        flags: z.number().int().positive().optional(),
        source: z.enum(['all', 'map', 'project']).optional(),
        page: z.number().int().min(0).optional(),
      },
    },
    run(
      (a: {
        session?: string;
        map?: string;
        near?: { x: number; z: number; radius: number };
        rect?: { minX: number; minZ: number; maxX: number; maxZ: number };
        class?: string;
        flags?: number;
        source?: 'all' | 'map' | 'project';
        page?: number;
      }) => {
        const q: Parameters<WorldTools['worldObjects']>[2] = {};
        if (a.near) q.near = a.near;
        if (a.rect) q.rect = a.rect;
        if (a.class) q.class = a.class;
        if (a.flags) q.flags = a.flags;
        if (a.source) q.source = a.source;
        if (a.page !== undefined) q.page = a.page;
        return w.worldObjects(a.session, a.map, q);
      },
    ),
  );

  mcp.registerTool(
    'ground_at',
    {
      description:
        `Ground at up to ${MAX_POINTS} points (X, Z): terrain height (bilinear), material and water of the nearest grid point, sea level in the sea, ` +
        'walkable surface (road, bridge, floor) with height and model, walkable surfaces of buildings there; with y also the highest surface below y.',
      inputSchema: {
        session,
        map,
        points: z
          .array(z.object({ x: z.number(), z: z.number(), y: z.number().optional() }))
          .min(1)
          .max(MAX_POINTS),
      },
    },
    run((a: { session?: string; map?: string; points: { x: number; z: number; y?: number }[] }) =>
      w.groundAt(
        a.session,
        a.map,
        a.points.map((p) => (p.y === undefined ? { x: p.x, z: p.z } : p)),
      ),
    ),
  );

  mcp.registerTool(
    'object_ground',
    {
      description:
        'How project objects (ids) or a hypothetical placement stand on the ground: the four lower corners of the box with the surface below and the distance; ' +
        '"floats <x> m", "<x> m in the ground", or the smallest and largest distance.',
      inputSchema: { session, map, ids: z.array(z.string()).optional(), placement },
    },
    run((a: { session?: string; map?: string; ids?: string[]; placement?: Placement }) =>
      w.objectGround(a.session, a.map, a.ids, a.placement),
    ),
  );

  mcp.registerTool(
    'check_overlap',
    {
      description:
        'Which static map objects and project objects intersect project objects (ids) or a hypothetical placement, compared as rotated boxes ' +
        '(collision box, otherwise clipping box) with the penetration depth in m; objects without a known box are named, never treated as free. ' +
        'With precise, a box intersection counts only if the collision rasters (shape seen from above) confirm it, which handles L-shaped ' +
        'buildings, roofs and gaps; each pair says whether it was compared by rasters or, without one, as boxes only.',
      inputSchema: { session, map, ids: z.array(z.string()).optional(), placement, precise: z.boolean().optional() },
    },
    run((a: { session?: string; map?: string; ids?: string[]; placement?: Placement; precise?: boolean }) =>
      w.checkOverlap(a.session, a.map, a.ids, a.placement, a.precise ?? false),
    ),
  );

  mcp.registerTool(
    'class_info',
    {
      description:
        'Dimensions of classes or models: size [X, Y, Z] in m, clipping and collision box, radius, flags, whether a shape raster exists. ' +
        'By class name (case does not matter) or model path / model id; unknown classes say so.',
      inputSchema: { names: z.array(z.string()).min(1).max(500) },
    },
    run((a: { names: string[] }) => w.classInfo(a.names)),
  );

  return mcp;
}
