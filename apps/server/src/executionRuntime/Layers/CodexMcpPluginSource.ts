/**
 * CodexMcpPluginSource layers.
 *
 * `Live` resolves Codex MCP plugins from live server settings + the host
 * environment: opt-in (returns [] unless `sandboxes.runtime.syncMcpPlugins` is
 * enabled), reads settings live (no restart), and re-resolves host secrets on each
 * call so a resumed sandbox gets fresh bearer tokens. `Disabled` is the no-op
 * binding tests and non-codex paths use.
 *
 * @module executionRuntime/Layers/CodexMcpPluginSource
 */
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { SandboxCodexMcpServer } from "../codexMcpBootstrap.ts";
import {
  isMcpSyncEnabled,
  parseMcpAllowlist,
  resolveOperatorCodexMcpPlugins,
} from "../codexMcpBootstrap.ts";
import {
  CodexMcpPluginSource,
  type CodexMcpPluginSourceShape,
} from "../Services/CodexMcpPluginSource.ts";

export const CodexMcpPluginSourceLive = Layer.effect(
  CodexMcpPluginSource,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const resolve = Effect.gen(function* () {
      const current = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
      );
      const runtime = current.sandboxes.runtime;
      if (!isMcpSyncEnabled(runtime.syncMcpPlugins)) {
        return [] as ReadonlyArray<SandboxCodexMcpServer>;
      }
      const { servers, skipped } = resolveOperatorCodexMcpPlugins(process.env, {
        allowlist: parseMcpAllowlist(runtime.mcpAllowlist),
      });
      if (skipped.length > 0) {
        yield* Effect.logInfo("codex mcp plugin sync skipped servers", { skipped });
      }
      return servers;
    });
    return { resolve } satisfies CodexMcpPluginSourceShape;
  }),
);

/** No-op source for tests and non-codex paths: MCP plugin sync disabled. */
export const CodexMcpPluginSourceDisabled = Layer.succeed(CodexMcpPluginSource, {
  resolve: Effect.succeed([] as ReadonlyArray<SandboxCodexMcpServer>),
});
