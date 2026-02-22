<div align="center">
  <img src="logo.png" width="150" alt="Skvil-Piertotum logo" />

# Skvil-Piertotum

[![npm version](https://img.shields.io/npm/v/skvil-piertotum)](https://www.npmjs.com/package/skvil-piertotum)
[![Node.js](https://img.shields.io/node/v/skvil-piertotum)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

**Let your Claude Code instances talk to each other.**

Skvil-Piertotum is a lightweight MCP + HTTP broker that connects multiple Claude Code terminals — across projects, machines, WSL, or VMs — so they can exchange messages, share context, and even delegate tasks autonomously.

</div>

```
Claude Code (API project)          Claude Code (Frontend project)
      │                                       │
      │  sp_send / sp_broadcast               │  sp_read
      └──────────────┬────────────────────────┘
                     │ HTTP
              ┌──────┴──────┐
              │   broker    │
              │  :4800      │
              │             │
              │  messages   │
              │  contexts   │
              │  agents     │
              └─────────────┘
```

---

## How it works

Two components, zero infrastructure:

**`broker.js`** — a tiny Express HTTP server that holds all state in memory (agents, message queues, shared key/value context). Run it once on any machine in your network.

**`mcp-server.js`** — an MCP stdio server that runs inside each Claude Code instance. It auto-registers on startup, heartbeats every 30s, and exposes 11 tools so Claude can send/receive messages and share data with other instances.

When `AUTO_PROCESS=true`, the MCP server polls for incoming messages and uses **MCP Sampling** (`createMessage`) to inject them directly into Claude's context — enabling fully autonomous agent-to-agent workflows without human intervention.

---

## Quick Start

### 1. Install

**Requirements:** Node.js 18 or later (`node --version` to check).

```bash
git clone https://github.com/LCGF00/skvil-piertotum
cd skvil-piertotum
npm install
```

### 2. Start the broker

Run this once, on any machine accessible to your terminals:

```bash
node broker.js
# custom port:
node broker.js 5000
# or via env:
BROKER_PORT=5000 node broker.js
```

The broker listens on `0.0.0.0` — reachable from any IP on your network.

> **Tip:** Run the broker on your main machine or a server that stays on. Use `hostname -I` (Linux/WSL) or `ipconfig` (Windows) to find its IP.

### 3. Add the MCP server to each Claude Code terminal

Each terminal gets a unique `AGENT_ID`:

```bash
# Terminal 1 — API project
claude mcp add skvil-piertotum \
  -e BROKER_URL=http://YOUR-IP:4800 \
  -e AGENT_ID=api \
  -e AGENT_NAME="API Project" \
  -e PROJECT_NAME="my-saas" \
  -- node /path/to/skvil-piertotum/mcp-server.js

# Terminal 2 — Frontend project
claude mcp add skvil-piertotum \
  -e BROKER_URL=http://YOUR-IP:4800 \
  -e AGENT_ID=front \
  -e AGENT_NAME="Frontend Project" \
  -e PROJECT_NAME="my-saas" \
  -- node /path/to/skvil-piertotum/mcp-server.js
```

If everything is on the same machine, use `BROKER_URL=http://localhost:4800`.

### 4. Or configure via `~/.claude.json`

```json
{
  "mcpServers": {
    "skvil-piertotum": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/skvil-piertotum/mcp-server.js"],
      "env": {
        "BROKER_URL": "http://192.168.1.10:4800",
        "AGENT_ID": "api",
        "AGENT_NAME": "API Project",
        "PROJECT_NAME": "my-saas"
      }
    }
  }
}
```

> Each terminal must have a **different** `AGENT_ID`.

---

## Usage examples

Once configured, just talk to Claude naturally:

### See who's connected

```
Register in the broker and show me who else is online
```

### Send context from one project to another

**In the API terminal:**
```
I just finished the auth endpoints. Send the full request/response
structure to the 'front' terminal as type 'endpoint'.
```

**In the Frontend terminal:**
```
Read incoming messages and use the endpoint spec to build the Axios services.
```

### Share a schema or config

**In the API terminal:**
```
Save the full Prisma schema we just defined to shared context under the key 'db-schema'.
```

**In any other terminal:**
```
Read the shared context 'db-schema' and use it as the source of truth for TypeScript types.
```

### Broadcast an announcement

```
Broadcast to all agents that the base API URL changed from /api/v1 to /api/v2.
```

### Check system status

```
Show broker status with all connected agents and their unread message counts.
```

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `sp_register` | Re-register this terminal (runs automatically on startup) |
| `sp_list_agents` | List all connected agents with staleness indicators |
| `sp_send` | Send a message to a specific agent |
| `sp_broadcast` | Send a message to all connected agents |
| `sp_read` | Read received messages (with pagination and explicit ACK) |
| `sp_clear` | Delete all messages in this agent's queue |
| `sp_set_context` | Save shared data by key (schema, config, endpoints, etc.) |
| `sp_get_context` | Read shared data by key |
| `sp_list_contexts` | List all available context keys |
| `sp_status` | Broker status: uptime, agents, unread counts, autonomous mode state |
| `sp_auto_process` | Toggle autonomous message processing at runtime |

---

## Environment Variables

### MCP server (`mcp-server.js`)

| Variable | Default | Description |
|---|---|---|
| `BROKER_URL` | `http://localhost:4800` | URL of the broker |
| `AGENT_ID` | machine hostname | Unique identifier for this instance — **must differ per terminal** |
| `AGENT_NAME` | `SP-{id}` | Human-readable display name |
| `PROJECT_NAME` | `unknown` | Used for grouping agents by project |
| `AUTO_PROCESS` | `false` | Set to `true` to enable autonomous message processing via MCP Sampling |
| `POLL_INTERVAL_MS` | `10000` | Polling interval in ms when `AUTO_PROCESS=true` (minimum: 1000) |

### Broker (`broker.js`)

| Variable | Default | Description |
|---|---|---|
| `BROKER_PORT` | `4800` | Port to listen on (also accepts first CLI argument) |

---

## Autonomous Mode

When `AUTO_PROCESS=true`, the MCP server polls for unread messages and uses **MCP Sampling** to process them without human input:

1. Polls the broker every `POLL_INTERVAL_MS` for unread messages
2. For each message: marks itself `busy`, calls `createMessage()` with the message injected into Claude's context
3. Sends Claude's response back to the original sender
4. Marks itself `idle` and ACKs the message

Enable it at startup via env var, or toggle it at runtime with `sp_auto_process`:

```
Enable autonomous processing mode
```

Agents broadcast their availability via shared context under `{AGENT_ID}-status`:
- `idle` — ready to receive tasks
- `busy | task: ... | início: HH:MM:SS` — working
- `offline` — gracefully shut down

> **Requirements:** The Claude Code client must support MCP Sampling. If it doesn't, the mode disables itself automatically and reports the reason in `sp_status`.

---

## Broker REST API

The broker exposes a plain HTTP API — useful for debugging or integration:

```bash
# Status overview
curl http://localhost:4800/status

# List agents
curl http://localhost:4800/agents

# Read messages for an agent (unread only, limit 10)
curl "http://localhost:4800/messages/api?unread=true&limit=10"

# ACK messages by ID
curl -X POST http://localhost:4800/messages/api/ack \
  -H "Content-Type: application/json" \
  -d '{"ids": ["msg_123", "msg_456"]}'

# Send a message
curl -X POST http://localhost:4800/messages/send \
  -H "Content-Type: application/json" \
  -d '{"from":"api","to":"front","content":"hello","type":"text"}'

# Shared context
curl http://localhost:4800/context
curl http://localhost:4800/context/db-schema
```

Full endpoint reference:

```
POST   /agents/register             Register an agent
GET    /agents                      List agents
POST   /agents/:id/heartbeat        Heartbeat (404 if not registered)
DELETE /agents/:id                  Deregister agent

POST   /messages/send               Send to one agent
POST   /messages/broadcast          Send to all agents except sender
GET    /messages/:id                Read messages (?unread=true, ?limit=N)
POST   /messages/:id/ack            Mark message IDs as read
DELETE /messages/:id                Clear all messages

POST   /context                     Save context entry
GET    /context                     List context keys
GET    /context/:key                Read context value
DELETE /context/:key                Delete context entry

GET    /status                      Broker overview
```

---

## Design Notes

- **In-memory only** — all state is lost if the broker restarts. Agents re-register automatically on the next heartbeat (within 30s). For persistence, adapt the broker to use SQLite.
- **Resource limits** — max 100 agents, 200 messages per queue (oldest dropped), 1000 context keys, 100 KB per context value.
- **Stale agent cleanup** — agents that miss 3 heartbeats (90s) are automatically removed.
- **Message types** — `text`, `code`, `schema`, `endpoint`, `config`. Used by agents to route and handle responses appropriately.
- **Prompt injection protection** — in autonomous mode, incoming message content is wrapped in XML tags with a random nonce before being injected into Claude's context.
- **ES modules** — both files use `import/export` (`"type": "module"` in `package.json`).

---

## Use Cases

**Monorepo with multiple services**
Each service runs in its own terminal. When the API changes a contract, it notifies the frontend automatically.

**Distributed setup (PC + WSL + VM)**
Run the broker on the host machine. WSL and VM terminals connect via the host IP.

**Multi-agent orchestration**
An orchestrator terminal delegates tasks to worker terminals. Workers report status via shared context. The orchestrator checks `sp_get_context("{worker}-status")` before assigning new work.

**Team knowledge sharing**
Each developer registers their terminal. Share schemas, decisions, and context across the team in real time — without copy-pasting into chat.

---

## Contributing

Issues and pull requests are welcome. For non-trivial changes, please open an issue first to discuss the approach.

## License

MIT — see [LICENSE](./LICENSE).

## References

The tool design, security hardening, and MCP best practices in this project were based on:

- [Writing tools for agents — Anthropic Engineering](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [MCP Security Best Practices — Model Context Protocol](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
