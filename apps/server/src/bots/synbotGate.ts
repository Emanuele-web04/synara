// FILE: synbotGate.ts
// Purpose: The server's authoritative SynBot gate. Ships in Stable under Synara Alto (Pro) —
//          verified server-side against the Account API with fail-closed behavior — and unlocked
//          in non-Stable flavors (Beta, Canary, Dev, tests) where billing is not enabled.
// Layer: Runtime gate
// Exports: SYNBOT_UNAVAILABLE_MESSAGE, SYNBOT_SUBSCRIPTION_REQUIRED_MESSAGE,
//          isServerSynbotEnabled, requiresServerSynbotAlto, checkServerSynbotAltoAccess,
//          noteServerAltoAccess, clearServerAltoAccess

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

/** Stable desktop builds enforce Synara Alto (Pro) server-side with no local bypass. */
export const requiresServerSynbotAlto = (): boolean => SERVER_DESKTOP_FLAVOR === "production";

const GRANTED_CACHE_TTL_MS = 60_000;
const DENIED_COALESCE_TTL_MS = 5_000;

interface CachedAltoAccess {
  readonly accountKey: string;
  readonly granted: boolean;
  readonly checkedAtMs: number;
}

const altoCacheByDir = new Map<string, CachedAltoAccess>();
const inflightByDir = new Map<string, Promise<boolean>>();

const accountKeyOf = (accountUrl: string, userId?: string) =>
  `${accountUrl}::${userId ?? "unknown"}`;

/** Records a fresh billing result from AccountSession so checkout unlocks SynBot immediately. */
export function noteServerAltoAccess(
  credentialDir: string,
  input: { readonly accountUrl: string; readonly userId?: string; readonly granted: boolean },
): void {
  altoCacheByDir.set(credentialDir, {
    accountKey: accountKeyOf(input.accountUrl, input.userId),
    granted: input.granted,
    checkedAtMs: Date.now(),
  });
}

/** Clears cached Alto access immediately on sign-out or account deletion. */
export function clearServerAltoAccess(credentialDir: string): void {
  altoCacheByDir.delete(credentialDir);
  inflightByDir.delete(credentialDir);
}

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
    return false;
  }
  const key = accountKeyOf(credentials.accountUrl, credentials.userId);
  const now = Date.now();
  const cached = altoCacheByDir.get(credentialDir);
  if (cached && cached.accountKey === key) {
    const ttl = cached.granted ? GRANTED_CACHE_TTL_MS : DENIED_COALESCE_TTL_MS;
    if (now - cached.checkedAtMs < ttl) return cached.granted;
  }
  const existing = inflightByDir.get(credentialDir);
  if (existing) return existing;
  const check = (async () => {
    try {
      const client = createServerAccountClient(credentials.accountUrl);
      const status = await withFreshAccessToken(
        { baseDir: credentialDir, client, credentials },
        (token) => client.billingStatus(token),
      );
      const granted = status.available === true && status.access === "granted";
      altoCacheByDir.set(credentialDir, {
        accountKey: key,
        granted,
        checkedAtMs: Date.now(),
      });
      return granted;
    } catch {
      altoCacheByDir.set(credentialDir, {
        accountKey: key,
        granted: false,
        checkedAtMs: Date.now(),
      });
      return false;
    } finally {
      inflightByDir.delete(credentialDir);
    }
  })();
  inflightByDir.set(credentialDir, check);
  return check;
}
