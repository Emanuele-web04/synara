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
// Every enabled Claude account (provider instance) is kept fresh: each config dir has
// its own Keychain item, so each account runs `claude auth status` in its own
// launch environment.
//
// Opt in:   SYNARA_CLAUDE_KEEPALIVE=1
// Tune:     SYNARA_CLAUDE_KEEPALIVE_MINUTES=<n>   (default 30)

import { execProcessFile } from "@synara/shared/processRuntime";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import type { ServerSettings } from "@synara/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
} from "@synara/shared/providerInstances";

import { acquireClaudeAuthStatusLock } from "./claudeAuthStatusLock";
import { buildClaudeInstanceProcessEnv } from "./claudeEnvironment";
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

// Mirrors the Claude Agent adapter default while honoring persisted custom CLI paths.
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

// `claude auth status` validates the stored OAuth token and refreshes it via the refresh
// token when at/near expiry, persisting the new token back to the Keychain. It is a cheap,
// local operation that never consumes inference quota.
//
// Held under the shared lock (see claudeAuthStatusLock.ts): the refresh token this probe
// may redeem is single-use, so it must never race another `claude auth status` invocation
// (e.g. the provider-health check or a concurrent keepalive tick) started elsewhere in
// this process.
async function nudgeClaudeTokenRefresh(
  binaryPath: string,
  homeDir: string | undefined,
  signal: AbortSignal,
  processEnv: NodeJS.ProcessEnv | undefined,
): Promise<void> {
  const release = await acquireClaudeAuthStatusLockWithSignal(signal);
  try {
    await execFileAsync(binaryPath, [...CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS], {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      signal,
      env: processEnv ?? buildClaudeProcessEnv(homeDir ? { homeDir } : undefined),
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

/** A non-default Claude account whose OAuth token is kept fresh too. */
export interface ClaudeCredentialKeepaliveAccount {
  /** Stable account identity (the provider instance id). */
  readonly id: string;
  readonly binaryPath?: string;
  /** The environment this account's `claude` CLI is launched with. */
  readonly processEnv: NodeJS.ProcessEnv;
}

export interface ClaudeCredentialKeepaliveController {
  readonly reconcile: (input: {
    /** Whether the default Claude account is enabled. */
    readonly enabled: boolean;
    readonly binaryPath?: string;
    /** Additional enabled accounts, each refreshed in its own environment. */
    readonly accounts?: ReadonlyArray<ClaudeCredentialKeepaliveAccount>;
  }) => Promise<void>;
  readonly stop: () => Promise<void>;
}

export function startClaudeCredentialKeepalive(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly binaryPath?: string;
  readonly homeDir?: string;
  /** Account launch environment; the default account derives one from `homeDir`. */
  readonly processEnv?: NodeJS.ProcessEnv;
  /** Names the account in log lines. */
  readonly accountLabel?: string;
  readonly log?: (message: string) => void;
  readonly runAuthStatus?: (input: {
    readonly binaryPath: string;
    readonly homeDir: string | undefined;
    readonly processEnv?: NodeJS.ProcessEnv | undefined;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}): ClaudeCredentialKeepaliveHandle {
  const platform = input?.platform ?? process.platform;
  const env = input?.env ?? process.env;
  const binaryPath = resolveClaudeCredentialKeepaliveBinaryPath(input?.binaryPath);
  const homeDir = input?.homeDir;
  const processEnv = input?.processEnv;
  const logPrefix = input?.accountLabel
    ? `[claude-keepalive:${input.accountLabel}]`
    : "[claude-keepalive]";
  const log = input?.log ?? (() => {});
  const runAuthStatus =
    input?.runAuthStatus ??
    ((input) =>
      nudgeClaudeTokenRefresh(input.binaryPath, input.homeDir, input.signal, input.processEnv));

  // Only run when explicitly enabled. The check touches Claude Code auth data, so
  // Synara should not do it as background work merely because the app opened.
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
    activeTick = runAuthStatus({
      binaryPath,
      homeDir,
      ...(processEnv ? { processEnv } : {}),
      signal: abortController.signal,
    })
      .catch((cause) => {
        if (abortController.signal.aborted) return;
        // Best-effort: a missing binary, a genuinely logged-out user, or a transient failure
        // must never crash the server. Keep it quiet since it self-heals on the next tick.
        log(
          `${logPrefix} token refresh nudge failed (non-fatal): ${
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
  // Run once after opt-in so an already-stale token recovers promptly instead
  // of waiting for the first interval tick.
  void tick();
  log(`${logPrefix} started (every ${intervalMs / 60_000}m, macOS)`);
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

// Identity of one running keepalive: a changed binary or account environment restarts it.
function keepaliveSignature(binaryPath: string, processEnv: NodeJS.ProcessEnv | undefined): string {
  if (!processEnv) return JSON.stringify([binaryPath]);
  const environment = Object.entries(processEnv).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  // Hashed: the environment can carry credentials.
  return JSON.stringify([
    binaryPath,
    createHash("sha256").update(JSON.stringify(environment)).digest("hex"),
  ]);
}

const DEFAULT_ACCOUNT_KEY = "\u0000default";

export function createClaudeCredentialKeepaliveController(input?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly log?: (message: string) => void;
  readonly start?: typeof startClaudeCredentialKeepalive;
}): ClaudeCredentialKeepaliveController {
  const start = input?.start ?? startClaudeCredentialKeepalive;
  const active = new Map<
    string,
    { readonly signature: string; readonly handle: ClaudeCredentialKeepaliveHandle }
  >();
  let transitionQueue = Promise.resolve();

  const stopAccounts = async (keys: ReadonlyArray<string>): Promise<void> => {
    const handles = keys.flatMap((key) => {
      const entry = active.get(key);
      active.delete(key);
      return entry ? [entry.handle] : [];
    });
    await Promise.all(handles.map((handle) => handle.stop()));
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
        const desired = new Map<
          string,
          {
            readonly binaryPath: string;
            readonly processEnv?: NodeJS.ProcessEnv;
            readonly accountLabel?: string;
          }
        >();
        if (settings.enabled) {
          desired.set(DEFAULT_ACCOUNT_KEY, {
            binaryPath: resolveClaudeCredentialKeepaliveBinaryPath(settings.binaryPath),
          });
        }
        for (const account of settings.accounts ?? []) {
          desired.set(account.id, {
            binaryPath: resolveClaudeCredentialKeepaliveBinaryPath(account.binaryPath),
            processEnv: account.processEnv,
            accountLabel: account.id,
          });
        }
        const signatures = new Map(
          [...desired].map(([key, target]) => [
            key,
            keepaliveSignature(target.binaryPath, target.processEnv),
          ]),
        );
        await stopAccounts(
          [...active.keys()].filter((key) => active.get(key)?.signature !== signatures.get(key)),
        );
        for (const [key, target] of desired) {
          if (active.has(key)) continue;
          active.set(key, {
            signature: signatures.get(key)!,
            handle: start({
              ...(input?.platform ? { platform: input.platform } : {}),
              ...(input?.env ? { env: input.env } : {}),
              binaryPath: target.binaryPath,
              ...(input?.homeDir ? { homeDir: input.homeDir } : {}),
              ...(target.processEnv ? { processEnv: target.processEnv } : {}),
              ...(target.accountLabel ? { accountLabel: target.accountLabel } : {}),
              ...(input?.log ? { log: input.log } : {}),
            }),
          });
        }
      }),
    stop: () => enqueueTransition(() => stopAccounts([...active.keys()])),
  };
}

/**
 * Keepalive targets for every enabled Claude account. The default account keeps
 * the historical launch (ambient environment under `homeDir`) unless it has its
 * own home or environment; every other account runs in the environment its
 * runtime launches with.
 */
export function claudeCredentialKeepaliveTargets(
  settings: ServerSettings,
  paths: { readonly homeDir?: string | undefined; readonly stateDir?: string | undefined },
): Parameters<ClaudeCredentialKeepaliveController["reconcile"]>[0] {
  let enabled = false;
  let binaryPath: string | undefined;
  const accounts: ClaudeCredentialKeepaliveAccount[] = [];
  for (const instance of deriveProviderInstances(settings)) {
    if (instance.driver !== "claudeAgent" || !instance.enabled) continue;
    const options = providerStartOptionsFromInstance(instance)?.claudeAgent;
    if (instance.isDefault && !options?.homePath && options?.environment === undefined) {
      enabled = true;
      binaryPath = options?.binaryPath;
      continue;
    }
    accounts.push({
      id: String(instance.instanceId),
      ...(options?.binaryPath ? { binaryPath: options.binaryPath } : {}),
      processEnv: buildClaudeInstanceProcessEnv(options?.homePath, options?.environment, {
        ...(paths.homeDir ? { homeDir: paths.homeDir } : {}),
        ...(paths.stateDir ? { isolationRootDir: paths.stateDir } : {}),
        ...(instance.isDefault ? {} : { providerInstanceId: String(instance.instanceId) }),
      }),
    });
  }
  return { enabled, ...(binaryPath ? { binaryPath } : {}), accounts };
}
