# Provider architecture

Synara treats provider integrations as adapters behind one server-owned orchestration boundary. The web app does not talk to Codex, Claude, Cursor, or another coding-agent runtime directly: provider operations enter the server through the typed contracts in `@synara/contracts`, are routed by `ProviderService`, and reach one concrete `ProviderAdapter` implementation.

## Implemented providers

`ProviderAdapterRegistryLive` currently registers nine first-class provider kinds:

- `codex`
- `claudeAgent`
- `cursor`
- `antigravity`
- `grok`
- `droid`
- `kilo`
- `opencode`
- `pi`

The registry is intentionally small. It maps `ProviderKind` to an adapter and lists the registered providers; it does not own session routing, persistence, or cross-provider orchestration.

## Adapter contract

`apps/server/src/provider/Services/ProviderAdapter.ts` is the provider boundary. Every adapter exposes the same core lifecycle:

- start, list, inspect, stop, and interrupt sessions;
- send turns and, where supported, steer an active turn;
- answer approvals and structured user-input requests;
- read and roll back provider thread state;
- stop all resources owned by the adapter;
- emit one canonical `ProviderRuntimeEvent` stream.

Optional methods advertise richer native behavior without forcing every provider to emulate it. These include native review, task stop/backgrounding, subagent steering, compaction, thread forking, runtime model/agent discovery, skills, slash commands, plugins, and voice prewarm/transcription.

Adapters also expose explicit capabilities rather than making the UI infer support from provider names. Current capability flags cover session model switching, conversation rollback strategy, skill/plugin discovery and mentions, native slash-command discovery, runtime model lists, turn steering, and live diff patches.

The adapter runtime-event queue is bounded. If durable consumers fall behind, backpressure is applied at the provider boundary instead of allowing unbounded process-memory growth.

## Runtime flow

A normal provider-backed turn follows this path:

1. The client dispatches an orchestration command through the typed server API.
2. Orchestration persists the intent and `ProviderCommandReactor` performs the provider-side operation.
3. `ProviderService` resolves the thread's provider/session and routes the call through `ProviderAdapterRegistry`.
4. The concrete adapter translates the request into its native protocol or CLI.
5. Native output is normalized into canonical `ProviderRuntimeEvent` values.
6. `ProviderRuntimeIngestion` converts those runtime events back into durable orchestration commands/events.
7. Projection streams update the shell/thread read models consumed by the web app.

This separation is important: provider-native session IDs, protocol frames, tool shapes, and subprocess behavior stay inside the adapter layer. Orchestration consumes canonical events and remains provider-agnostic.

## Provider-specific state

Provider configuration is split across typed server settings, discovery/health services, and adapter start options. A provider integration may contribute:

- binary/config-path settings;
- health and authentication probes;
- runtime model, agent, skill, command, or plugin discovery;
- provider-specific model options and runtime modes;
- session resume cursors and native thread identifiers;
- handoff/import support;
- provider update metadata.

Capability and discovery data should be authoritative. UI surfaces should consume the shared provider metadata instead of hard-coding behavior from `ProviderKind` where a capability exists.

## OpenCode-compatible providers

OpenCode and Kilo share the OpenCode-compatible runtime/adapter family while remaining distinct provider kinds. Shared transport code belongs in that family; provider-specific defaults, health/configuration, model discovery, and presentation stay explicit.

Other providers use their own native integration paths where doing so exposes richer semantics than a lowest-common-denominator protocol.

## Adding a provider

A new first-class provider normally needs changes across several boundaries:

1. contracts/shared provider metadata and model/options types;
2. a server adapter implementing the required `ProviderAdapter` lifecycle;
3. registry/runtime-layer wiring;
4. health/auth and, when applicable, update/discovery support;
5. persistence/model-selection compatibility;
6. web settings, provider/model picker metadata, icons, and handoff surfaces;
7. focused adapter tests plus regression coverage for lifecycle, interruption, resume, approvals, and event normalization.

Prefer capability-driven behavior and existing shared protocol helpers. Do not add provider-specific branches to orchestration when the difference can stay inside the adapter.

## Related code

- `apps/server/src/provider/Services/ProviderAdapter.ts` — adapter contract and capabilities
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — concrete provider registry
- `apps/server/src/provider/Layers/ProviderService.ts` — session-aware provider routing
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — orchestration intent to provider calls
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` — provider events to durable orchestration
- `packages/contracts/src/orchestration.ts` — provider kinds, runtime modes, session/turn contracts
- `packages/shared/src/providerMetadata.ts` — shared provider metadata
