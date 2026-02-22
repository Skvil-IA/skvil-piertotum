# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Skvil-Piertotum** is a two-component system that lets multiple Claude Code instances communicate over HTTP. A central broker (`broker.js`) holds all state in memory and exposes a REST API. Each Claude Code instance runs `mcp-server.js` as an MCP stdio server, which registers with the broker and exposes 11 tools for sending/receiving messages and sharing context. Optionally, the MCP server can process incoming messages autonomously via MCP Sampling.

## Running the Project

```bash
# Start the broker (port 4800 by default)
npm run broker

# Watch mode during development
npm run broker:dev

# Custom port
node broker.js 5000

# Start MCP server manually (normally Claude Code launches it)
BROKER_URL=http://localhost:4800 AGENT_ID=api AGENT_NAME="API Server" PROJECT_NAME=myproject node mcp-server.js

# With autonomous processing enabled
AUTO_PROCESS=true POLL_INTERVAL_MS=10000 BROKER_URL=http://localhost:4800 AGENT_ID=api node mcp-server.js
```

No test or lint scripts are defined.

## Architecture

```
Broker terminal (operator types commands/messages)
        │
        ▼
   broker.js :4800  ◄──── HTTP ────►  mcp-server.js (Instance A)
   (in-memory state)                   mcp-server.js (Instance B)
                                        │
                                        └─ AUTO_PROCESS=true:
                                           poll → createMessage → ack → reply
```

**`broker.js`** — Express HTTP server. Holds agents, message queues (Map per agentId), and shared context (key/value Map) entirely in memory. Also runs a readline console: plain text broadcasts to all agents, `@agentId message` targets one, `/agents` and `/help` are available commands.

**`mcp-server.js`** — MCP stdio server per Claude Code instance. Auto-registers on startup, heartbeats every 30s (auto re-registers on 404 to recover from broker restarts), deregisters gracefully on SIGTERM/SIGINT (waits up to 10s for in-flight processing).

## Environment Variables

### MCP Server (`mcp-server.js`)

| Variable | Default | Purpose |
|---|---|---|
| `BROKER_URL` | `http://localhost:4800` | Broker address — validated on startup (http/https only) |
| `AGENT_ID` | hostname (sanitized) | Unique ID per instance — must differ across terminals |
| `AGENT_NAME` | `SP-{id}` | Display name |
| `PROJECT_NAME` | `unknown` | Project grouping |
| `AUTO_PROCESS` | `false` | Enable autonomous processing via MCP Sampling |
| `POLL_INTERVAL_MS` | `10000` | Polling interval when `AUTO_PROCESS=true` (clamped to min 1000ms) |

### Broker (`broker.js`)

| Variable | Default | Purpose |
|---|---|---|
| `BROKER_PORT` | `4800` | Listening port (also accepts first CLI argument) |

## MCP Setup (per Claude Code instance)

```bash
claude mcp add skvil-piertotum \
  -e BROKER_URL=http://<broker-ip>:4800 \
  -e AGENT_ID=api \
  -e AGENT_NAME="API Project" \
  -e PROJECT_NAME="my-saas" \
  -- node /path/to/skvil-piertotum/mcp-server.js
```

Each terminal must have a unique `AGENT_ID`. Find the broker IP with `hostname -I` (Linux/WSL) or `ipconfig` (Windows).

## MCP Tools (11 total)

| Tool | Purpose |
|---|---|
| `sp_register` | Re-register this terminal (auto-runs on startup) |
| `sp_list_agents` | List agents — shows `formatLastSeen` and ⚠️ badge if >60s without heartbeat |
| `sp_send` | Send to a specific agent — hints `sp_list_agents` on 404 |
| `sp_broadcast` | Send to all agents — warns if `sentTo=0` |
| `sp_read` | Read messages with pagination (`limit`, default 20, max 50) and explicit ACK |
| `sp_clear` | Delete all messages in this agent's queue |
| `sp_set_context` | Save shared data — value is always string (use JSON.stringify for objects) |
| `sp_get_context` | Read shared data by key |
| `sp_list_contexts` | List all context keys |
| `sp_status` | Broker status: formatted uptime, agents, autonomous mode state + disable reason |
| `sp_auto_process` | Toggle autonomous sampling mode at runtime |

## Autonomous Mode (MCP Sampling)

When `AUTO_PROCESS=true`, `pollAndProcess()` runs every `POLL_INTERVAL_MS`:

1. Checks client capabilities — if sampling not supported, disables itself and records reason in `autoProcessStatusReason`
2. Fetches up to 10 unread messages from the broker
3. For each message in order:
   - Sets `{AGENT_ID}-status` context to `busy | task: ... | início: HH:MM:SS`
   - Calls `server.server.createMessage()` with the message wrapped in XML nonce delimiters (prompt injection protection)
   - Sends Claude's response back to the sender
   - Sets status back to `idle`
   - ACKs the message individually via `POST /messages/:agentId/ack`
4. Even on processing errors, the message is ACKed to prevent poison message loops
5. Breaks the loop early if autonomous mode is self-disabled mid-batch

Only one poll runs at a time (`isProcessing` flag set before the first `await`). RESET messages (`/^RESET[\s:]/`) skip sampling and reply with `RESET ACK` immediately.

The `sp_auto_process` tool toggles this at runtime. The disable reason is visible in `sp_status` output.

## Orchestrator/Worker Status Convention

Agents publish state to shared context under `{AGENT_ID}-status`:
- `idle` — ready for tasks
- `busy | task: {description} | início: {HH:MM:SS}` — working
- `offline` — set on graceful shutdown

Orchestrators should call `sp_get_context("{agent_id}-status")` before delegating.

## Key Design Decisions

- **In-memory only** — all state lost on broker restart. Heartbeat auto re-registers agents within 30s. Max 200 messages/queue (oldest dropped), 100 agents, 1000 context keys, 100 KB/value.
- **Separate read/ACK** — `GET /messages` never auto-marks as read. Clients call `POST /messages/:agentId/ack` with explicit message IDs after successful processing. `sp_read` does this automatically.
- **Stale agent reaper** — runs every 30s; removes agents with no heartbeat for >90s (3 missed intervals). `sp_list_agents` flags agents >60s as stale before the reaper removes them.
- **ES modules** — both files use `import/export` (`"type": "module"` in `package.json`).
- **Message types enum** — `text`, `code`, `schema`, `endpoint`, `config`. Type `broadcast` was intentionally removed (was dead code).
- **Broker operator messages** — `from: "broker"` / `fromName: "Operador"`. Autonomous mode processes them but never replies (broker is not a registered agent).
- **Fetch timeout** — all broker calls: 5s via `AbortSignal.timeout`; deregister on shutdown: 3s.
- **BROKER_URL validation** — checked on startup; non-http/https protocols cause immediate exit with a clear error.

## Broker REST API

```
POST   /agents/register             Register (or re-register) an agent
GET    /agents                      List all agents with lastSeen timestamps
POST   /agents/:agentId/heartbeat    Heartbeat — 404 if not registered
DELETE /agents/:agentId              Deregister agent + clear its queue

POST   /messages/send               Send to one agent (404 if unknown)
POST   /messages/broadcast          Send to all except sender
GET    /messages/:agentId            Read queue (?unread=true, ?limit=N) — does NOT mark as read
POST   /messages/:agentId/ack       Mark specific message IDs as read
DELETE /messages/:agentId            Clear entire queue

POST   /context                     Save context (key + value required, max 100 KB)
GET    /context                     List all context keys
GET    /context/:key                Read context value
DELETE /context/:key                Delete context entry

GET    /status                      Broker overview: uptime, agents, unread counts, context count
```
