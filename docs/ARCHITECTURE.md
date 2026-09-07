# Architecture and decisions

## Runtime flow

1. The browser opens the React application and connects to `/agents/incident-agent/checkout-war-room` through the Agents SDK.
2. Cloudflare routes that room to one `IncidentAgent` Durable Object with a stable identity.
3. `AIChatAgent` restores persisted chat messages and streams new messages over the WebSocket.
4. `onChatMessage` sends bounded conversation context and the current incident projection to GLM 4.7 Flash on Workers AI.
5. The model selects structured tools. The Agent validates inputs with Zod, performs the mutation, persists the full next state, and broadcasts it to connected clients.
6. Scheduled reminders survive hibernation. When a reminder fires, the Agent writes an audit entry and broadcasts a one-off application event.

## State model

The synchronized `IncidentState` contains only data required by the active room:

- Incident identity, severity, status, commander, and summary
- Impacted services and next-update time
- Up to 40 recent timeline entries
- Active action items

Chat messages are managed separately by `AIChatAgent` and capped at 100. The timeline bound matters because Agent state is broadcast on every update. For a production history longer than 40 entries, older entries would move to the Agent's embedded SQL tables and be loaded on demand.

## Coordination model

The model can read the snapshot and request six operational tools:

| Tool                   | Effect                                                  | Control                      |
| ---------------------- | ------------------------------------------------------- | ---------------------------- |
| `getIncidentSnapshot`  | Reads current state                                     | Automatic                    |
| `recordFinding`        | Adds evidence, a decision, or an action to the timeline | Automatic                    |
| `updateIncident`       | Updates metadata and impact                             | Automatic                    |
| `assignActionItem`     | Adds an owned action and audit entry                    | Automatic                    |
| `changeIncidentStatus` | Changes lifecycle status                                | Resolution requires approval |
| `scheduleNextUpdate`   | Creates a durable reminder                              | Automatic                    |

The system prompt tells the model to separate evidence from hypotheses and never invent operational facts. Tool schemas constrain writes, while approval provides a hard runtime gate for resolution rather than relying on prompt compliance.

## Failure behavior

- WebSocket reconnects restore chat and state from the Agent instance.
- Stream recovery is enabled, so interrupted model responses can resume.
- Durable schedules persist independently of an open browser connection.
- A tool mutates state only after its input validates and execution begins.
- A rejected resolution leaves the lifecycle state unchanged.
- The health endpoint does not invoke AI and can be used for deployment probes.

## Security boundary

This assessment intentionally uses a fixed public demo room. Production deployment should put Cloudflare Access in front of the Worker and derive room names from authenticated tenant and incident IDs. External tools should use narrowly scoped credentials in Worker secrets or authenticated MCP connections. Logs and prompts should be treated as potentially sensitive incident data with explicit retention and redaction policies.

## Why Durable Objects instead of a separate database

The required workload is room-shaped: one incident has shared state, ordered updates, live clients, and timers. A Durable Object gives that room a single coordination point, colocated SQLite, WebSocket hibernation, scheduling, and immediate consistency. A separate D1 database would add useful cross-incident analytics later, but it is not needed for the active-room control path.

## Dependency compatibility

`@cloudflare/ai-chat` is pinned to `0.9.3`. Live browser validation found that `0.9.4` calls an internal `_withAgentSpan` hook that is not present in the latest published `agents@0.17.4`, causing every Agent WebSocket handshake to return 500. Version `0.9.3` uses the same public chat API without that unreleased tracing dependency. The lockfile preserves the tested combination.

## Model choice

The first implementation used the assignment's suggested Llama 3.3 70B model. In an authenticated end-to-end test it selected the correct `recordFinding` tool but emitted `{}` instead of the required arguments on every retry. Cloudflare's current provider guidance recommends Kimi K2.7 for tools, but that model requires a paid Workers plan. GLM 4.7 Flash is optimized for multi-turn function calling, works within the Workers Free allocation, and completed the same live tool test with validated arguments. SignalDesk therefore uses GLM for a reliable, zero-key setup while remaining fully on Workers AI.
