# External MCP computer control — live end-to-end evidence

Date: 2026-09-18 · Feature commit `e45515583` · Driver: packaged rev-20 (`0.28.2`)

## What was proven

The complete external-agent computer-control chain, live, on a real Synara
server (isolated `SYNARA_HOME=/tmp/synara-live/home`, port 4099):

1. External MCP integration `mcp_int_521a1735` ("CC live") created with the
   `computer:control` capability alongside `projects:read`, `tasks:create`,
   `tasks:wait`, `tasks:read`, `runtime:local`.
2. External stdio MCP bridge paired via credential store
   (`/tmp/synara-live/home/mcp/credentials/`). `tools/list` exposed the six
   orchestration tools; `synara_capabilities` disclosed `computer:control`.
3. `synara_create_task` invoked with `enableComputerControl: true` and
   `computerControlMode: "request"` → thread
   `agent-805744b999c73bc1694c55082dde5103`, provider `devin`, model `swe-2`,
   `creationSource: external_mcp`.
4. The spawned agent's session carried `mcp__synara__computer_*` tools. Agent
   transcript: _"let me check the overflow file for the `computer_list_windows`
   tool schema"_ → _"Calling `computer_list_windows` on the synara MCP server
   now."_
5. The tool call surfaced a real pending interaction
   (`interactionKind: "approval"`, `lifecycleGeneration` present). Answered via
   `thread.approval.respond` — **note:** `lifecycleGeneration` is required; a
   respond without it is accepted as a command but never resolves the
   interaction (status stays `pending`). With the generation included the
   interaction resolved and dispatch proceeded.
6. The tool executed through approval gate → trusted host → packaged rev-20
   `cua-driver` → returned a **14,340-char real window list**
   (CursorUIViewService windows, real pids/bounds/stacking order) to the
   external agent. Turn `completed`.

## Gate verification

- An earlier external task created **without** `computer:control` produced an
  agent whose toolset had zero `mcp__synara__computer_*` tools — capability
  filtering confirmed live, not just by test.
- Each individual computer action still requires per-action approval; the
  integration scope only makes the tools _visible_ to the task's agent.

## Notable behavior

- Turn interrupted once by VM pause; the pending approval persisted as
  `status: "uncertain"` and a fresh turn on the same thread resumed cleanly.
- Agent reported needing no approval for `list_windows` on its second attempt
  — approval semantics per tool class are governed by `computerControlMode:
"request"`; observations may be admitted without a prompt while mutations
  still gate (verify per-mode matrix if this matters for policy).
