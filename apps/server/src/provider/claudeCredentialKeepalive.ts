// macOS keeps Claude OAuth in the Keychain (~8h token TTL) while the auth path only reads ~/.claude/.credentials.json — expiry is never observed, so invoke `claude` periodically to refresh it; opt-in via SYNARA_CLAUDE_KEEPALIVE=1

import { execProcessFile } from "@synara/shared/processRuntime";
import { promisify } from "node:util";

import { acquireClaudeAuthStatusLock } from "./claudeAuthStatusLock";
import { buildClaudeProcessEnv } from "./claudeProcessEnv";

const execFileAsync = promisify(execProcessFile);

const DEFAULT_INTERVAL_MINUTES = 30;
const COMMAND_TIMEOUT_MS = 20_000;
export const CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS = 2_147_483_647;
export const CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS = ["auth", "status"] as const;

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

export function isClaudeCredentialKeepaliveEnabled(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  return platform === "darwin" && envFlagEnabled(env.SYNARA_CLAUDE_KEEPALIVE);
}

export function resolveClaudeCredentialKeepaliveBinaryPath(binaryPath: string | undefined): string {
  return binaryPath?.trim() || "claude";
}

// Caps the tuning knob before setInterval can overflow into Node's 1ms clamp behavior.
export function resolveClaudeCredentialKeepaliveIntervalMs(env: NodeJS.ProcessEnv): number {
  const raw = env.SYNARA_CLAUDE_KEEPALIVE_MINUTES?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const minutes = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MINUTES;
  return Math.min(minutes * 60 * 1000, CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS);
}

// `claude auth status` refreshes the Keychain token near expiry — held under the shared lock since the refresh token it may redeem is single-use
async function nudgeClaudeTokenRefresh(
  binaryPath: string,
  homeDir: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const release = await acquireClaudeAuthStatusLockWithSignal(signal);
  try {
    await execFileAsync(binaryPath, [...CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      signal,
      env: buildClaudeProcessEnv(homeDir ? { homeDir } : undefined),
      requireExecutable: true,
    });
  } finally {
    release();
  }
}

function acquireClaudeAuthStatusLockWithSignal(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void acquireClaudeAuthStatusLock().then(
      (release) => {
        if (settled) {
          release();
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(release);
      },
      (cause) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

export interface ClaudeCredentialKeepaliveHandle {
  readonly stop: () => Promise<void>;
}

export interface ClaudeCredentialKeepaliveController {
  readonly reconcile: (input: {
    readonly enabled: boolean;
    readonly binaryPath?: string;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function startClaudeCredentialKeepalive(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly homeDir?: string;
  readonly log?: (message: string) => void;
  readonly runAuthStatus?: (input: {
    readonly binaryPath: string;
    readonly homeDir: string | undefined;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}): ClaudeCredentialKeepaliveHandle {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(input?.binaryPath);
  const homeDir = input?.homeDir;
  const log = input?.log ?? (() => {});
  const runAuthStatus =
    input?.runAuthStatus ??
    ((input) => nudgeClaudeTokenRefresh(input.binaryPath, input.homeDir, input.signal));

  // opt-in only — touches Claude auth data, so it must not run just because the app opened
  if (!isClaudeCredentialKeepaliveEnabled({ platform, env })) {
    return { stop: async () => {} };
  }

  const intervalMs = resolveClaudeCredentialKeepaliveIntervalMs(env);
  const abortController = new AbortController();
  let stopped = false;
  let activeTick: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  const tick = (): Promise<void> => {
    if (stopped || activeTick) {
      return activeTick ?? Promise.resolve();
    }
    activeTick = runAuthStatus({ binaryPath, homeDir, signal: abortController.signal })
      .catch((cause) => {
        if (abortController.signal.aborted) return;
        // Best-effort: a missing binary, a genuinely logged-out user, or a transient failure must never crash the server. Keep it quiet since it self-heals on the next tick.
        log(
          `[claude-keepalive] token refresh nudge failed (non-fatal): ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      })
      .finally(() => {
        activeTick = null;
      });
    return activeTick;
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Never keep the process alive solely for this background timer.
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  void tick();
  log(`[claude-keepalive] started (every ${intervalMs / 60_000}m, macOS)`);
  return {
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      const inFlight = activeTick;
      abortController.abort();
      stopPromise = inFlight ?? Promise.resolve();
      return stopPromise;
    },
  };
}

export function createClaudeCredentialKeepaliveController(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly log?: (message: string) => void;
  readonly start?: typeof startClaudeCredentialKeepalive;
}): ClaudeCredentialKeepaliveController {
  const start = input?.start ?? startClaudeCredentialKeepalive;
  let active: {
    readonly binaryPath: string;
    readonly handle: ClaudeCredentialKeepaliveHandle;
  } | null = null;
  let transitionQueue = Promise.resolve();

  const stopActive = async (): Promise<void> => {
    const handle = active?.handle;
    active = null;
    await handle?.stop();
  };

  const enqueueTransition = (transition: () => Promise<void>): Promise<void> => {
    const queued = transitionQueue.then(transition, transition);
    transitionQueue = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  };

  return {
    reconcile: (settings) =>
      enqueueTransition(async () => {
        if (!settings.enabled) {
          await stopActive();
          return;
        }
        const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(settings.binaryPath);
        if (active?.binaryPath === binaryPath) {
          return;
        }
        await stopActive();
        active = {
          binaryPath,
          handle: start({
            ...(input?.platform ? { platform: input.platform } : {}),
            ...(input?.env ? { env: input.env } : {}),
            binaryPath,
            ...(input?.homeDir ? { homeDir: input.homeDir } : {}),
            ...(input?.log ? { log: input.log } : {}),
          }),
        };
      }),
    stop: () => enqueueTransition(stopActive),
  };
}
