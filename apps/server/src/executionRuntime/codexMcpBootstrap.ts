/**
 * codexMcpBootstrap - host-side resolution of the operator's Codex MCP servers
 * ("plugins") into a sandbox-safe form, plus the sandbox-side command that
 * installs them into the remote `config.toml`.
 *
 * Codex's extensibility is MCP servers declared under `[mcp_servers.*]` in the
 * host `config.toml`. A remote runtime runs `codex app-server` in a sandbox that
 * has none of them, so a remote agent runs tool-blind. This module extracts the
 * runnable slice and drops what cannot work in a sandbox:
 *
 *   - stdio/command servers are host-only (their binary/socket lives on the
 *     operator's machine), so they are dropped.
 *   - HTTP servers are runnable. Their auth, however, is an env-var *reference*
 *     (`bearer_token_env_var` / `env_http_headers`) whose secret lives in the host
 *     environment, not the file. We resolve those references on the host and
 *     materialize them as literal `http_headers`, so the sandbox needs nothing in
 *     its own environment. A server whose referenced env var is unset is skipped
 *     (a half-authed server would just 401), as is an oauth-login server whose
 *     token we cannot carry.
 *
 * The materialized headers carry secrets, so the install command writes them as a
 * base64 positional arg (never a visible command line) into a marker-delimited
 * block that is stripped-and-rewritten on every injection — so a resume re-applies
 * fresh tokens without duplicating tables.
 *
 * @module executionRuntime/codexMcpBootstrap
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { resolveBaseCodexHomePath } from "../codexHomePaths.ts";

import type { ExecutionRuntimeExecCollectInput } from "./Services/ExecutionRuntimeProviderAdapter.ts";

/** A host MCP server reduced to the form a sandboxed codex can connect with. */
export interface SandboxCodexMcpServer {
  readonly name: string;
  readonly url: string;
  /** Literal HTTP headers (bearer / env-header references already resolved). */
  readonly httpHeaders: Readonly<Record<string, string>>;
}

/** A host MCP server that was not synced, with the reason (carries no secrets). */
export interface SkippedCodexMcpServer {
  readonly name: string;
  readonly reason: string;
}

export interface ResolvedCodexMcpPlugins {
  readonly servers: ReadonlyArray<SandboxCodexMcpServer>;
  readonly skipped: ReadonlyArray<SkippedCodexMcpServer>;
}

// Marker lines delimiting the Synara-managed block in the sandbox config.toml.
// The install command deletes any prior block between these markers before
// appending a fresh one, so a resume re-injects without duplicating tables.
const MCP_BLOCK_BEGIN = "# >>> synara-managed mcp (do not edit) >>>";
const MCP_BLOCK_END = "# <<< synara-managed mcp <<<";

/** The runtime setting rides as text; only an explicit "true" enables sync. */
export const isMcpSyncEnabled = (value: string | undefined): boolean =>
  (value ?? "").trim().toLowerCase() === "true";

/** Parse the comma-separated allowlist setting into trimmed, non-empty names. */
export const parseMcpAllowlist = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Resolve the operator's host `[mcp_servers.*]` into a sandbox-safe set. Reads the
 * base Codex home `config.toml` (`CODEX_HOME` or `~/.codex`), keeps HTTP servers
 * whose auth can be materialized from `env`, and records every drop with a reason.
 * Degrades to empty (never throws) when the config is absent or unparseable, so a
 * resolution failure is a no-op rather than a provisioning failure.
 */
export const resolveOperatorCodexMcpPlugins = (
  env: NodeJS.ProcessEnv = process.env,
  options: { readonly allowlist?: ReadonlyArray<string> } = {},
): ResolvedCodexMcpPlugins => {
  const configPath = path.join(resolveBaseCodexHomePath(env), "config.toml");
  if (!existsSync(configPath)) {
    return { servers: [], skipped: [] };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch {
    return { servers: [], skipped: [] };
  }
  const mcpServers = asRecord(parsed.mcp_servers);
  if (mcpServers === null) {
    return { servers: [], skipped: [] };
  }

  const allowlist = options.allowlist ?? [];
  const allowAll = allowlist.length === 0;
  const servers: SandboxCodexMcpServer[] = [];
  const skipped: SkippedCodexMcpServer[] = [];
  const skip = (name: string, reason: string) => skipped.push({ name, reason });

  for (const [name, rawValue] of Object.entries(mcpServers)) {
    const raw = asRecord(rawValue);
    if (raw === null) {
      continue;
    }
    if (!allowAll && !allowlist.includes(name)) {
      skip(name, "not in allowlist");
      continue;
    }
    if (raw.enabled === false) {
      skip(name, "disabled in host config");
      continue;
    }
    if (asNonEmptyString(raw.command) !== null) {
      skip(name, "stdio transport (host-only binary)");
      continue;
    }
    const url = asNonEmptyString(raw.url);
    if (url === null) {
      skip(name, "no http url");
      continue;
    }

    const headers: Record<string, string> = {};
    // Static headers are copied verbatim (a value here may be an inline secret).
    const staticHeaders = asRecord(raw.http_headers);
    if (staticHeaders !== null) {
      for (const [headerName, headerValue] of Object.entries(staticHeaders)) {
        const literal = asNonEmptyString(headerValue);
        if (literal !== null) {
          headers[headerName] = literal;
        }
      }
    }
    // `bearer_token_env_var` names a host env var; resolve it to a literal header.
    const bearerEnvVar = asNonEmptyString(raw.bearer_token_env_var);
    if (bearerEnvVar !== null) {
      const token = asNonEmptyString(env[bearerEnvVar]);
      if (token === null) {
        skip(name, `host env var ${bearerEnvVar} is unset`);
        continue;
      }
      headers.Authorization = `Bearer ${token}`;
    }
    // `env_http_headers` map a header name to a host env var name; resolve each.
    const envHeaders = asRecord(raw.env_http_headers);
    let missingEnvVar: string | null = null;
    if (envHeaders !== null) {
      for (const [headerName, envVarValue] of Object.entries(envHeaders)) {
        const envVarName = asNonEmptyString(envVarValue);
        if (envVarName === null) {
          continue;
        }
        const resolved = asNonEmptyString(env[envVarName]);
        if (resolved === null) {
          missingEnvVar = envVarName;
          break;
        }
        headers[headerName] = resolved;
      }
    }
    if (missingEnvVar !== null) {
      skip(name, `host env var ${missingEnvVar} is unset`);
      continue;
    }
    // An oauth-login server keeps its token in codex's own store, which is not
    // synced; with no other auth materialized it would fail in the sandbox.
    if (asNonEmptyString(raw.oauth_resource) !== null && Object.keys(headers).length === 0) {
      skip(name, "requires interactive oauth login");
      continue;
    }

    servers.push({ name, url, httpHeaders: headers });
  }

  return { servers, skipped };
};

const serversToTomlObject = (
  servers: ReadonlyArray<SandboxCodexMcpServer>,
): Record<string, unknown> => {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = { url: server.url };
    if (Object.keys(server.httpHeaders).length > 0) {
      entry.http_headers = { ...server.httpHeaders };
    }
    mcpServers[server.name] = entry;
  }
  return { mcp_servers: mcpServers };
};

/** Serialize the sandbox MCP servers into the marker-delimited managed block. */
export const buildSandboxMcpConfigToml = (servers: ReadonlyArray<SandboxCodexMcpServer>): string =>
  `${MCP_BLOCK_BEGIN}\n${stringifyToml(serversToTomlObject(servers))}\n${MCP_BLOCK_END}\n`;

/**
 * Build the exec that installs the MCP servers into `$HOME/.codex/config.toml`
 * inside the sandbox. It strips any prior Synara-managed block (so a resume does
 * not duplicate tables), ensures the file ends in a newline, then appends the
 * fresh block. The newline guard matters because the block is appended with `>>`
 * and the begin marker must land at the start of a line for the strip to find it
 * on the next resume — an image-shipped `config.toml` (the file the minimal-config
 * write deliberately leaves untouched) may have no trailing newline, which would
 * otherwise glue the marker onto the prior line and duplicate the tables. The
 * block — which carries resolved bearer tokens in its headers — rides as a base64
 * positional arg (`$0`), so the secret never appears on a visible command line;
 * only `codex-mcp-injected` is echoed.
 */
export const buildCodexMcpConfigCommand = (
  servers: ReadonlyArray<SandboxCodexMcpServer>,
): ExecutionRuntimeExecCollectInput => {
  const b64 = Buffer.from(buildSandboxMcpConfigToml(servers), "utf8").toString("base64");
  return {
    command: "bash",
    args: [
      "-lc",
      'cfg="$HOME/.codex/config.toml" && mkdir -p "$HOME/.codex" && touch "$cfg" && ' +
        'sed -i "/^# >>> synara-managed mcp/,/^# <<< synara-managed mcp/d" "$cfg" && ' +
        'if [ -s "$cfg" ] && [ -n "$(tail -c1 "$cfg")" ]; then printf "\\n" >> "$cfg"; fi && ' +
        'printf %s "$0" | base64 -d >> "$cfg" && echo codex-mcp-injected',
      b64,
    ],
  };
};
