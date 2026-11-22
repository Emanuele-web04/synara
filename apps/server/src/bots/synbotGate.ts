// FILE: synbotGate.ts
// Purpose: The server's authoritative SynBot gate. Every host requires Synara Alto (Pro) —
//          verified server-side against the Account API with fail-closed behavior — except the
//          Beta, Canary and Dev desktop flavors, which name themselves explicitly. A host with no
//          desktop flavor (the npx CLI, a headless server) or any other flavor requires Alto.
// Layer: Runtime gate
// Exports: SYNBOT_UNAVAILABLE_MESSAGE, SYNBOT_SUBSCRIPTION_REQUIRED_MESSAGE,
//          isServerSynbotEnabled, requiresServerSynbotAlto, checkServerSynbotAltoAccess,
//          noteServerAltoAccess, clearServerAltoAccess, onServerAltoAccessRevoked

import { SYNBOT_BETA_FEATURE } from "@synara/shared/betaFeatures";

import { readAccountCredentials, withFreshAccessToken } from "../accountAuth";
import { createServerAccountClient } from "../accountHttp";
import { SERVER_DESKTOP_FLAVOR, isServerBetaFeatureEnabled } from "../betaFeatureGate";
import { isServerGroupsEnabled } from "../projectAgent/groupsBetaGate";

export const SYNBOT_UNAVAILABLE_MESSAGE = "SynBot is not available on this host.";
export const SYNBOT_SUBSCRIPTION_REQUIRED_MESSAGE =
  "SynBot requires an active Synara Alto (Pro) subscription.";

/** SynBot runs on Hubs, so it needs both its own gate and the Hubs gate. */
export const isServerSynbotEnabled = (): boolean =>
  isServerBetaFeatureEnabled(SYNBOT_BETA_FEATURE) && isServerGroupsEnabled();

/**
 * The flavors where SynBot is free. Everything else, "unknown" included, requires Alto: a host
 * opts out only by naming one of these (the dev runner and the scenario harness use the Dev
 * flavor), never by leaving the flavor unset.
 */
const SYNBOT_FREE_FLAVORS: ReadonlySet<string> = new Set(["beta", "canary", "development"]);

/** Whether this host enforces Synara Alto (Pro) server-side; fails closed for unknown hosts. */
export const requiresServerSynbotAlto = (): boolean =>
  !SYNBOT_FREE_FLAVORS.has(SERVER_DESKTOP_FLAVOR);

const GRANTED_CACHE_TTL_MS = 60_000;
const DENIED_COALESCE_TTL_MS = 5_000;

interface CachedAltoAccess {
  readonly accountKey: string;
  readonly granted: boolean;
  readonly checkedAtMs: number;
}

interface InflightAltoCheck {
  readonly accountKey: string;
  readonly epoch: number;
  promise: Promise<boolean>;
}

const altoCacheByDir = new Map<string, CachedAltoAccess>();
const inflightByDir = new Map<string, InflightAltoCheck>();
/**
 * Bumped by every fresh grant and every sign-out. A check started under an older epoch was
 * overtaken by newer knowledge: it neither writes its result nor removes a newer check.
 */
const epochByDir = new Map<string, number>();
const epochOf = (credentialDir: string) => epochByDir.get(credentialDir) ?? 0;
const nextEpoch = (credentialDir: string) => {
  epochByDir.set(credentialDir, epochOf(credentialDir) + 1);
};

type AltoAccessRevokedListener = (credentialDir: string) => void;
const revokedListeners = new Set<AltoAccessRevokedListener>();

/**
 * Calls `listener` whenever this host learns that Alto access for a credential directory is
 * gone: sign-out, account deletion, or a billing read or check that finds no grant. Open SynBot
 * streams use it to end. Returns the unsubscribe.
 */
export function onServerAltoAccessRevoked(listener: AltoAccessRevokedListener): () => void {
  revokedListeners.add(listener);
  return () => {
    revokedListeners.delete(listener);
  };
}

const notifyRevoked = (credentialDir: string) => {
  for (const listener of [...revokedListeners]) {
    try {
      listener(credentialDir);
    } catch {
      // A listener's failure must not stop the others or the caller.
    }
  }
};

/** Billing is per organization: a token is scoped to one, so the cache is too. */
const accountKeyOf = (input: {
  readonly accountUrl: string;
  readonly organizationId?: string | undefined;
  readonly userId?: string | undefined;
}) => `${input.accountUrl}::${input.organizationId ?? "unknown"}::${input.userId ?? "unknown"}`;

/** Records a fresh billing result from AccountSession so checkout unlocks SynBot immediately. */
export function noteServerAltoAccess(
  credentialDir: string,
  input: {
    readonly accountUrl: string;
    readonly organizationId?: string;
    readonly userId?: string;
    readonly granted: boolean;
  },
): void {
  nextEpoch(credentialDir);
  altoCacheByDir.set(credentialDir, {
    accountKey: accountKeyOf(input),
    granted: input.granted,
    checkedAtMs: Date.now(),
  });
  if (!input.granted) notifyRevoked(credentialDir);
}

/** Clears cached Alto access immediately on sign-out or account deletion. */
export function clearServerAltoAccess(credentialDir: string): void {
  nextEpoch(credentialDir);
  altoCacheByDir.delete(credentialDir);
  inflightByDir.delete(credentialDir);
  notifyRevoked(credentialDir);
}

const freshCached = (credentialDir: string, accountKey: string, nowMs: number) => {
  const cached = altoCacheByDir.get(credentialDir);
  if (!cached || cached.accountKey !== accountKey) return null;
  const ttl = cached.granted ? GRANTED_CACHE_TTL_MS : DENIED_COALESCE_TTL_MS;
  return nowMs - cached.checkedAtMs < ttl ? cached.granted : null;
};

/**
 * Verifies active Synara Alto (Pro) access for `credentialDir` against the Account API.
 * Strictly in-memory cache; always fails closed when signed out, billing is unavailable,
 * or the API refuses/errors.
 */
export async function checkServerSynbotAltoAccess(credentialDir: string): Promise<boolean> {
  if (!requiresServerSynbotAlto()) return true;
  const credentials = await readAccountCredentials(credentialDir).catch(() => null);
  if (!credentials) {
    altoCacheByDir.delete(credentialDir);
    notifyRevoked(credentialDir);
    return false;
  }
  const key = accountKeyOf(credentials);
  const cached = freshCached(credentialDir, key, Date.now());
  if (cached !== null) return cached;
  const epoch = epochOf(credentialDir);
  const existing = inflightByDir.get(credentialDir);
  if (existing && existing.accountKey === key && existing.epoch === epoch) return existing.promise;
  const check: InflightAltoCheck = { accountKey: key, epoch, promise: Promise.resolve(false) };
  inflightByDir.set(credentialDir, check);
  check.promise = (async () => {
    let granted = false;
    try {
      const client = createServerAccountClient(credentials.accountUrl);
      const status = await withFreshAccessToken(
        { baseDir: credentialDir, client, credentials },
        (token) => client.billingStatus(token),
      );
      granted = status.available === true && status.access === "granted";
    } catch {
      granted = false;
    }
    if (epochOf(credentialDir) !== epoch) {
      // A grant or sign-out landed while this check ran: answer from what is known now.
      return freshCached(credentialDir, key, Date.now()) ?? false;
    }
    altoCacheByDir.set(credentialDir, { accountKey: key, granted, checkedAtMs: Date.now() });
    if (!granted) notifyRevoked(credentialDir);
    return granted;
  })().finally(() => {
    if (inflightByDir.get(credentialDir) === check) inflightByDir.delete(credentialDir);
  });
  return check.promise;
}
