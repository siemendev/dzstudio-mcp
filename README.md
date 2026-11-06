# dzstudio-mcp

An MCP server that lets an AI agent build in **dzStudio**, the in-game object editor for DayZ, together with people.
The agent joins a dzStudio collaboration session as a participant without the game: it speaks the open collaboration
protocol **dzcollab 1** (see `PROTOCOL.md` of the dzStudio collaboration server), keeps the project state on your
machine and applies every operation exactly like the editor does. Everyone in the session sees it as "‹you›'s agent",
with a status line saying what it is working on.

The agent works on data, not on screenshots. It never saves: when it is done it asks for review, and a person in the
session saves or discards.

## Setup (once)

Requires Node.js 22 or newer. Add it to your MCP client, for example in Claude Code:

```bash
claude mcp add dzstudio -e DZSTUDIO_MCP_SERVERS=dzbot=https://collab.dzbot.de/dzcollab/ -e DZSTUDIO_MCP_AGENT_NAME=Scout -- npx -y @dzbot/dzstudio-mcp
```

or in a client's JSON configuration (Claude Desktop, Cursor and others):

```json
{
  "mcpServers": {
    "dzstudio": {
      "command": "npx",
      "args": ["-y", "@dzbot/dzstudio-mcp"],
      "env": { "DZSTUDIO_MCP_SERVERS": "dzbot=https://collab.dzbot.de/dzcollab/", "DZSTUDIO_MCP_AGENT_NAME": "Scout" }
    }
  }
}
```

Use your own server's address instead of dzbot's if you run the collaboration server yourself. To run it from a
checkout instead: `npm install && npm run build`, then `node /path/to/dzstudio-mcp/dist/index.js` as the command.

That is all the configuration there is. From then on you work in the conversation:

1. **Servers** — the agent adds a server with `add_server` (a name of your choice and the server's base address), or
   you name them once in `DZSTUDIO_MCP_SERVERS` (`name=url`, comma-separated).
2. **Login** — `login` gives you an address and a code; confirm it in the browser and the agent finishes the login.
   The token is stored on your machine and kept across restarts.
3. **Sessions** — the agent lists projects and sessions, joins one (by id, by opening a project that has a running
   session, or with an invitation code), and can be in several sessions at once.

Settings and tokens live in `~/.config/dzstudio-mcp/` (or `$XDG_CONFIG_HOME/dzstudio-mcp`, `%APPDATA%\dzstudio-mcp` on
Windows, or the directory in `DZSTUDIO_MCP_CONFIG_DIR`). `credentials.json` is readable only by you; no tool ever
returns a token to the agent.

| Variable | Meaning |
| --- | --- |
| `DZSTUDIO_MCP_SERVERS` | Servers added on start if missing: `name=url,name=url` |
| `DZSTUDIO_MCP_AGENT_NAME` | Short name of the agent (default `Agent`) |
| `DZSTUDIO_MCP_CONFIG_DIR` | Where settings and tokens are kept |
| `DZSTUDIO_MCP_CACHE_LIMIT_MB` | Size limit of the map data cache in MB (default 2048) |
| `DZSTUDIO_MCP_WORLD_DATA` | Class and map data: a folder or a `file://`/`https://` base address (overrides `worldData.base`) |
| `DZSTUDIO_MCP_WORLD_DATA_POINTER` | Pointer to the current revisions for a base address (overrides `worldData.pointer`) |

### Class and map data

The world tools compute on static data: per world 256 m tiles with terrain heights, surface, walkable surfaces and
static objects, and one class index with boxes, dimensions and shape rasters. By default they come from dzbot
(`https://uploads.dzbot.de/world-data/`, current revisions from `https://dzbot.de/api/public/world-data`). Another
source is set once in `config.json`:

```json
{ "worldData": { "base": "file:///srv/world-data/" } }
```

or a mirror with its own pointer:

```json
{ "worldData": { "base": "https://mirror.example.org/world-data/", "pointer": "https://mirror.example.org/world-data.json" } }
```

A local folder has the published layout (`classes/<revision>/…`, `worlds/<world>/<revision>/…`); its newest revisions
are used and the map key comes from each manifest. Downloaded files are kept in `cache/` of the config directory below
their revision and never requested again; every tile and raster is checked against size and SHA-256 from the manifest,
a changed file in the cache is loaded once more, and a file that stays wrong is reported as "map data corrupt". The
session's map key (e.g. `chernarus`) picks the world; the revision stays the same for the whole session. Missing data
are "unknown", never zero: a class without data has "box unknown", a map without data gives "No map data for ‹map› —
project objects only", and a tile that cannot be loaded is named in the answer.

The cache holds at most 2 GB. Above that, the least recently used tiles and rasters are deleted (and downloaded again
when a question needs them); nothing of a revision that a session the agent is in works on is ever deleted. Another
limit is set in MB with `worldData.cacheLimitMb` in `config.json` or `DZSTUDIO_MCP_CACHE_LIMIT_MB`:

```json
{ "worldData": { "cacheLimitMb": 512 } }
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_servers`, `add_server`, `login` | Servers, whether you are signed in, whether they admit agents |
| `list_projects`, `open_project`, `join_session` | Projects and sessions you may join; join one, or open a project on the server that nobody has open |
| `list_sessions`, `switch_session`, `leave_session` | The sessions the agent is in; the current one is used when a tool names none |
| `session_info`, `session_events` | Participants with phase and status, rights, save state; what happened since the last call |
| `read_scene`, `query_objects` | Groups and objects of the project, by id, group, class, circle or rectangle |
| `create_objects`, `modify_objects`, `delete_objects` | Each call is one step for everyone; objects are locked first |
| `release` | Let others edit objects the agent holds |
| `set_status`, `request_review` | Phase (waiting for work, working, waiting for review) and the status line everyone sees |
| `world_info` | World, data revisions, game version and export date for the session's map; place names near a point or by text |
| `world_objects` | Static map objects and project objects whose box touches a circle or rectangle, with transform, distance and size or "box unknown" |
| `ground_at` | Terrain height, material, water, roads and building floors at up to 1000 points; the highest surface below a height |
| `object_ground` | How project objects or a hypothetical placement stand: "floats ‹x› m", "‹x› m in the ground", or the corner distances |
| `check_overlap` | Which map and project objects intersect, as rotated boxes with penetration depth; with `precise`, the collision rasters confirm each intersection (pairs without a raster are compared as boxes and say so); objects without a known box are named |
| `class_info` | Size, clipping and collision box, radius, flags and raster of classes or models |

Some rules the MCP keeps for the agent: it joins only servers that announce the `agents` capability, so nobody sees it
as a human; it changes an existing object only while holding its lock; it never saves, invites, removes anyone or
ends a session; it does not edit loot (loot entries pass through unchanged); after 30 minutes without work it leaves
a session and joins again on the next task.

**Opening a project nobody has open.** When no session is running for a project on the server, `open_project` loads
its files and builds the project state exactly as dzStudio does when it opens them — the same groups, objects, ids form,
companion data and order, byte for byte — then starts the session with it, as the only participant. This needs the right
to save the project (the server checks it) and the class data (for each object, dzStudio notes whether the game knows its
class; the class data stand in for the game). Where dzStudio's result depends on the running game and not on the files,
the MCP refuses instead of opening a different state: a group file that places a model by its path (the game places the
model to learn its origin), or a project with loot turned on. A person then opens it in dzStudio, and the agent joins
that session. Agents never create a new project.

## Development

```bash
npm test           # unit tests, plus an integration test against the reference collaboration server if Go is installed
npm run typecheck
npm run format
```

The integration tests build the reference server from `../collab-server` (or `DZCOLLAB_SOURCE`), or use the binary in
`DZCOLLAB_SERVER`, and run it on a free port on 127.0.0.1. One of them drives the whole agent flow through an MCP
client: login with a code, joining a person's session, status, a step, review, leaving. Without Go and without a binary
they are skipped.

The world tools are tested on a tiny world in `test/fixtures/world-data`, made with the reference converter. An opt-in
test compares every answer with the converter's JavaScript reader on a full converted world: it runs when
`DZSTUDIO_MCP_WORLD_DATA_REFERENCE` (default `/tmp/world-data-out`) holds one and `DZSTUDIO_MCP_WORLD_DATA_READER` points
to `world_data_read.js`; `DZSTUDIO_MCP_WORLD_DATA_WORLD` picks the world (default `chernarusplus`).

| Directory | Content |
| --- | --- |
| `src/scene` | The project state outside the game: text form, numbers, chunks, ids, applying operations, building new ones, opening a project from its files |
| `src/protocol` | The dzcollab 1 client: requests, the session with its poll and send channel |
| `src/config` | Servers, agent name, tokens and the world data source, configured once |
| `src/world` | Class and map data: file formats, loading and cache, and the geometry behind the world tools |
| `src/mcp` | The tools and the MCP wiring |

## Contributing

Issues and pull requests are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0, see [LICENSE](LICENSE).
