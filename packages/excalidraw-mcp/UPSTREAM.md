# Upstream provenance

This package is a Synara-focused fork/adaptation of
[`excalidraw/excalidraw-mcp`](https://github.com/excalidraw/excalidraw-mcp).

- Upstream version: `0.3.2`
- Upstream commit: `157aa23ceb1976008aadc89eb05e3444060f09d6`
- License: MIT (preserved in `LICENSE`)
- Fork point verified: 2026-07-14

Synara retains the upstream `read_me`, `create_view`, pseudo-element deletion,
checkpoint, bounded-input, and stdio-server concepts. The MCP App iframe,
public HTTP server, export proxy, and remote checkpoint stores are intentionally
removed. This fork operates on one Drawing through a short-lived, thread-scoped
Synara loopback capability and never receives a filesystem path.

The upstream iframe converted shorthand elements with
`convertToExcalidrawElements`. Synara performs that same conversion in the
lazy-loaded Canvas workspace before applying and revision-saving the canonical
scene, because the stdio MCP process is intentionally headless and importing the
browser bundle under Node/Bun requires `window`.

## Verified local entry points

- Build: `bun run --cwd packages/excalidraw-mcp build`
- Test: `bun run --cwd packages/excalidraw-mcp test`
- Development stdio entry: `bun packages/excalidraw-mcp/src/main.ts`
- Packaged Node stdio entry: `node packages/excalidraw-mcp/dist/main.mjs`

The stdio process requires `SYNARA_CANVAS_BRIDGE_URL`,
`SYNARA_CANVAS_BRIDGE_TOKEN`, and `SYNARA_CANVAS_THREAD_ID`. Synara creates all
three values and does not expose them to the model or accept a drawing path from
tool input.
