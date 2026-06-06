/**
 * codexAuthBootstrap - host-side resolution of the operator's Codex credentials
 * and the sandbox-side commands that install them before the agent transport
 * starts.
 *
 * A remote runtime runs `codex app-server` inside a sandbox that has no Codex
 * login of its own. Codex reads its auth from `$HOME/.codex/auth.json`, so before
 * the agent transport starts the runtime must write the host operator's auth into
 * that path inside the sandbox. This module owns the two halves of that:
 *
 *   - {@link resolveOperatorCodexAuth} reads the host operator's `auth.json` from
 *     the resolved base Codex home (`CODEX_HOME` or `~/.codex`). It returns
 *     `null` when there is no login, so provisioning degrades to "no auth"
 *     instead of failing — codex then surfaces its own auth error on first turn.
 *
 *   - {@link buildCodexAuthInjectionCommand} and
 *     {@link buildMinimalCodexConfigCommand} produce runtime-neutral exec inputs
 *     that write `auth.json` (and a minimal `config.toml`) inside the sandbox.
 *     The auth bytes ride as a base64 positional arg so their content can never
 *     break the shell, and the file is left mode 600 yet writable by the owner so
 *     codex can refresh an expired token in place.
 *
 * The host config.toml is intentionally NOT copied: it carries host-only state (a
 * local browser-plugin socket, absolute `[projects]` paths) that is meaningless
 * — and in the browser-socket case actively wrong — inside a sandbox. Only a
 * minimal config that lets codex pick a safe sandbox/approval default is written,
 * and only when the image ships none.
 *
 * @module executionRuntime/codexAuthBootstrap
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { resolveBaseCodexHomePath } from "../codexHomePaths.ts";

import type { ExecutionRuntimeExecCollectInput } from "./Services/ExecutionRuntimeProviderAdapter.ts";

/** The host operator's Codex auth, resolved from the base Codex home. */
export interface OperatorCodexAuth {
  /** Raw `auth.json` contents (a JSON document). */
  readonly authJson: string;
}

/** The host operator's global Codex instructions (`<codex home>/AGENTS.md`). */
export interface OperatorCodexInstructions {
  /** Raw `AGENTS.md` markdown codex loads into every session. */
  readonly agentsMarkdown: string;
}

/**
 * Read the host operator's Codex `auth.json` from the resolved base Codex home
 * (`explicitHomePath` > `CODEX_HOME` > `~/.codex`). Returns `null` when the file
 * is absent or unreadable, so a missing host login degrades to "no auth injected"
 * rather than failing provisioning.
 */
export const resolveOperatorCodexAuth = (
  env: NodeJS.ProcessEnv = process.env,
  explicitHomePath?: string,
): OperatorCodexAuth | null => {
  const home = resolveBaseCodexHomePath(env, explicitHomePath);
  const authPath = path.join(home, "auth.json");
  if (!existsSync(authPath)) {
    return null;
  }
  try {
    const authJson = readFileSync(authPath, "utf8");
    return authJson.trim().length === 0 ? null : { authJson };
  } catch {
    return null;
  }
};

/**
 * Read the host operator's global Codex instructions from `<base codex home>/AGENTS.md`.
 * codex loads this file into every session regardless of cwd, so without it a sandbox
 * agent runs with only codex's built-in defaults while a local session carries the
 * operator's persona and rules — the dominant reason a remote agent "acts different".
 * Returns `null` when absent, so a host with no global instructions degrades to "none
 * injected".
 */
export const resolveOperatorCodexInstructions = (
  env: NodeJS.ProcessEnv = process.env,
  explicitHomePath?: string,
): OperatorCodexInstructions | null => {
  const home = resolveBaseCodexHomePath(env, explicitHomePath);
  const agentsPath = path.join(home, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return null;
  }
  try {
    const agentsMarkdown = readFileSync(agentsPath, "utf8");
    return agentsMarkdown.trim().length === 0 ? null : { agentsMarkdown };
  } catch {
    return null;
  }
};

/**
 * Build the exec that writes the operator's global instructions into
 * `$HOME/.codex/AGENTS.md` inside the sandbox, so the remote agent loads the same
 * persona and rules a local session does. The markdown rides as a base64 positional
 * arg so its content cannot break the shell.
 */
export const buildCodexInstructionsInjectionCommand = (
  instructions: OperatorCodexInstructions,
): ExecutionRuntimeExecCollectInput => {
  const b64 = Buffer.from(instructions.agentsMarkdown, "utf8").toString("base64");
  return {
    command: "bash",
    args: [
      "-lc",
      'mkdir -p "$HOME/.codex" && printf %s "$0" | base64 -d > "$HOME/.codex/AGENTS.md" && echo codex-instructions-injected',
      b64,
    ],
  };
};

/**
 * A minimal `config.toml` for a sandboxed codex. It only sets a permissive
 * sandbox/approval default so a config-driven codex can run a turn unattended;
 * the model and per-turn policy ride the app-server protocol, not this file. It
 * deliberately omits everything host-specific (browser plugin, `[projects]`).
 */
export const MINIMAL_SANDBOX_CODEX_CONFIG = [
  'sandbox_mode = "danger-full-access"',
  'approval_policy = "never"',
  "",
].join("\n");

/**
 * Build the exec that writes the operator's auth into `$HOME/.codex/auth.json`
 * inside the sandbox. The auth bytes ride as a base64 positional arg (`$0`), so
 * arbitrary JSON content cannot break the shell. The file is left mode 600 but
 * owner-writable so codex can rewrite it on token refresh.
 */
export const buildCodexAuthInjectionCommand = (
  auth: OperatorCodexAuth,
): ExecutionRuntimeExecCollectInput => {
  const b64 = Buffer.from(auth.authJson, "utf8").toString("base64");
  return {
    command: "bash",
    args: [
      "-lc",
      'mkdir -p "$HOME/.codex" && printf %s "$0" | base64 -d > "$HOME/.codex/auth.json" && chmod 600 "$HOME/.codex/auth.json" && echo codex-auth-injected',
      b64,
    ],
  };
};

/**
 * Build the exec that writes a minimal `config.toml` into `$HOME/.codex` only
 * when the sandbox image ships none, so an image-provided config is never
 * clobbered. The config bytes ride as a base64 positional arg.
 */
export const buildMinimalCodexConfigCommand = (
  config: string = MINIMAL_SANDBOX_CODEX_CONFIG,
): ExecutionRuntimeExecCollectInput => {
  const b64 = Buffer.from(config, "utf8").toString("base64");
  return {
    command: "bash",
    args: [
      "-lc",
      'mkdir -p "$HOME/.codex" && if [ ! -f "$HOME/.codex/config.toml" ]; then printf %s "$0" | base64 -d > "$HOME/.codex/config.toml"; fi && echo codex-config-ready',
      b64,
    ],
  };
};
