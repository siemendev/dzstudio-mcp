# dzstudio-mcp

An MCP server that lets an AI agent build in **dzStudio**, the in-game object editor for DayZ, together with people.
The agent joins a dzStudio collaboration session as a participant without the game: it speaks the open collaboration
protocol **dzcollab 1** (see `PROTOCOL.md` of the dzStudio collaboration server), keeps the project state on your
machine and applies every operation exactly like the editor does. Everyone in the session sees it as "‹you›'s agent",
with a status line saying what it is working on.

The agent works on data, not on screenshots. It never saves: when it is done it asks for review, and a person in the
session saves or discards.

## Setup (once)

Requires Node.js 22 or newer.

```bash
git clone <this repository> dzstudio-mcp
cd dzstudio-mcp
npm install
npm run build
```

Add it to your MCP client, for example in Claude Code:

```bash
claude mcp add dzstudio -- node /path/to/dzstudio-mcp/dist/index.js
```

or in a client's JSON configuration:

```json
{
  "mcpServers": {
    "dzstudio": {
      "command": "node",
      "args": ["/path/to/dzstudio-mcp/dist/index.js"],
      "env": { "DZSTUDIO_MCP_SERVERS": "home=https://collab.example.org/dzcollab/", "DZSTUDIO_MCP_AGENT_NAME": "Scout" }
    }
  }
}
```

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

## Tools

| Tool | What it does |
| --- | --- |
| `list_servers`, `add_server`, `login` | Servers, whether you are signed in, whether they admit agents |
| `list_projects`, `open_project`, `join_session` | Projects and sessions you may join; join one |
| `list_sessions`, `switch_session`, `leave_session` | The sessions the agent is in; the current one is used when a tool names none |
| `session_info`, `session_events` | Participants with phase and status, rights, save state; what happened since the last call |
| `read_scene`, `query_objects` | Groups and objects of the project, by id, group, class, circle or rectangle |
| `create_objects`, `modify_objects`, `delete_objects` | Each call is one step for everyone; objects are locked first |
| `release` | Let others edit objects the agent holds |
| `set_status`, `request_review` | Phase (waiting for work, working, waiting for review) and the status line everyone sees |
| `world_info`, `world_objects`, `ground_at`, `object_ground`, `check_overlap`, `class_info` | Map and class data — not available yet |

Some rules the MCP keeps for the agent: it joins only servers that announce the `agents` capability, so nobody sees it
as a human; it changes an existing object only while holding its lock; it never saves, invites, removes anyone or
ends a session; it does not edit loot (loot entries pass through unchanged); after 30 minutes without work it leaves
a session and joins again on the next task.

## Development

```bash
npm test           # unit tests, plus an integration test against the reference collaboration server if Go is installed
npm run typecheck
npm run format
```

The integration test builds the reference server from `../collab-server` (or `DZCOLLAB_SOURCE`), or uses the binary in
`DZCOLLAB_SERVER`, and runs it on a free port on 127.0.0.1. Without Go and without a binary it is skipped.

| Directory | Content |
| --- | --- |
| `src/scene` | The project state outside the game: text form, numbers, chunks, ids, applying operations, building new ones |
| `src/protocol` | The dzcollab 1 client: requests, the session with its poll and send channel |
| `src/config` | Servers, agent name and tokens, configured once |
| `src/mcp` | The tools and the MCP wiring |

## License

AGPL-3.0, see [LICENSE](LICENSE).
