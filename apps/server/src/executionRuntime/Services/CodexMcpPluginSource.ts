/**
 * CodexMcpPluginSource - the seam that resolves which Codex MCP servers a remote
 * sandbox should run with, decoupled from where that resolution comes from.
 *
 * The Daytona adapter (the only codex-aware provider boundary today) depends on
 * this service and calls {@link CodexMcpPluginSourceShape.resolve} inside its
 * credential-injection step, which runs on both provision and resume. Keeping the
 * source behind a service lets the adapter stay settings-agnostic: the live layer
 * reads server settings + host state, while tests bind a disabled stub — so the
 * generic runtime seam never learns about codex MCP plugins.
 *
 * @module executionRuntime/Services/CodexMcpPluginSource
 */
import type { Effect } from "effect";
import { ServiceMap } from "effect";

import type { SandboxCodexMcpServer } from "../codexMcpBootstrap.ts";

export interface CodexMcpPluginSourceShape {
  /**
   * The sandbox-ready Codex MCP servers to inject, resolved from current settings
   * + host state on each call. Empty when the feature is off or nothing resolves.
   * Never fails: an unreadable host config or a settings error degrades to empty.
   */
  readonly resolve: Effect.Effect<ReadonlyArray<SandboxCodexMcpServer>>;
}

export class CodexMcpPluginSource extends ServiceMap.Service<
  CodexMcpPluginSource,
  CodexMcpPluginSourceShape
>()("t3/executionRuntime/CodexMcpPluginSource") {}
