// FILE: claudeCredentialKeepalive.ts
// Purpose: Keep the macOS Claude Code OAuth token fresh so long-lived provider sessions
//   don't intermittently report "not logged in" roughly every ~8 hours.
// Layer: server background job (best-effort, never throws).
//
// Why this exists
// ---------------
// On macOS, Claude Code stores its OAuth credentials in the login Keychain item
// "Claude Code-credentials" (accessToken + refreshToken + expiresAt). The access token has
// an ~8h TTL and is meant to be refreshed via the refresh token. The Claude auth path here
// (`claudeProcessEnv.ts`) only inspects the FILE `~/.claude/.credentials.json`, which does NOT
// exist on macOS (creds live in the Keychain), so the expiry is never observed and a refresh
// is never triggered. A long-lived Claude Agent SDK session then rides a token that lapses
// after ~8h -> the user sees "not logged in" until they re-login interactively.
//
// Fix: periodically invoke the official `claude` CLI, which validates and refreshes its own
// Keychain token (using its own Keychain ACL, so there is no auth prompt and no risk of this
// process mishandling refresh-token rotation). This keeps the Keychain token perpetually
// fresh, so the SDK session always reads a valid token.
//
// Opt out:  T3CODE_CLAUDE_KEEPALIVE=0
// Tune:     T3CODE_CLAUDE_KEEPALIVE_MINUTES=<n>   (default 30)

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_INTERVAL_MINUTES = 30;
const COMMAND_TIMEOUT_MS = 20_000;

function envFlagDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
  );
}

function resolveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.T3CODE_CLAUDE_KEEPALIVE_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MINUTES;
  return minutes * 60 * 1000;
}

// `claude auth status` validates the stored OAuth token and refreshes it via the refresh
// token when at/near expiry, persisting the new token back to the Keychain. It is a cheap,
// local operation that never consumes inference quota.
async function nudgeClaudeTokenRefresh(binaryPath: string): Promise<void> {
  await execFileAsync(binaryPath, ["auth", "status", "--json"], {
    timeout: COMMAND_TIMEOUT_MS,
  });
}

export interface ClaudeCredentialKeepaliveHandle {
  readonly stop: () => void;
}

export function startClaudeCredentialKeepalive(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly log?: (message: string) => void;
}): ClaudeCredentialKeepaliveHandle {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const binaryPath = input?.binaryPath ?? "claude";
  const log = input?.log ?? (() => {});

  // Only macOS exhibits the Keychain/short-TTL behavior that causes the bug; other platforms
  // use the credentials file the SDK already manages, so the keepalive is a no-op there.
  if (platform !== "darwin" || envFlagDisabled(env.T3CODE_CLAUDE_KEEPALIVE)) {
    return { stop: () => {} };
  }

  const intervalMs = resolveIntervalMs(env);
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      await nudgeClaudeTokenRefresh(binaryPath);
    } catch (cause) {
      // Best-effort: a missing binary, a genuinely logged-out user, or a transient failure
      // must never crash the server. Keep it quiet since it self-heals on the next tick.
      log(
        `[claude-keepalive] token refresh nudge failed (non-fatal): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never keep the process alive solely for this background timer.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  // Refresh once shortly after startup so an already-stale token recovers promptly.
  void tick();

  log(`[claude-keepalive] started (every ${intervalMs / 60_000}m, macOS)`);
  return {
    stop: () => clearInterval(timer),
  };
}
