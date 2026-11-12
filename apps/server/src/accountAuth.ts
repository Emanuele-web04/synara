/**
 * accountAuth - the credential file, token refresh, host linking, and the
 * `synara auth` (host link) / `synara status` CLI flows. Sign-in itself is
 * app-only.
 *
 * Plain async functions so the CLI handlers stay thin and the flows are
 * testable without a network or an Effect runtime. Every collaborator the
 * flows touch (account client, stdout, platform, hostname) is injectable.
 *
 * @module accountAuth
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import OS from "node:os";
import path from "node:path";
import { exponentialBackoffMs, jitterMs } from "./backoff";
import { reportReliabilityIssue } from "./reliability";

import {
  type AccountHost,
  type AccountHostEndpoint,
  type AccountHostPlatform,
  EnvironmentId,
  type OrganizationSummary,
} from "@synara/contracts";
import {
  AccountApiError,
  ACCOUNT_URL_ENV_NAME,
  createAccountClient,
  GRANT_REQUEST_TIMEOUT_MS,
  OrganizationRequiredError,
  resolveConfiguredAccountUrl,
  type AccountClient,
} from "@synara/shared/account";
import { Effect, Path } from "effect";

import { withCredentialFileLock } from "./accountCredentialLock";
import { createFileStringExclusively, writeFileStringAtomically } from "./atomicWrite";
import { deriveServerPaths } from "./config";
import { PRIVATE_FILE_MODE } from "./privatePathPermissions";
import {
  deleteHostIdentity,
  generateAndPersistHostIdentity,
  mintHostLinkProof,
  mintHostProof,
  readHostIdentity,
} from "./hostIdentity";
import { decodeJwtClaims } from "./jwtClaims";
import { isLoopbackHost, isWildcardHost } from "./startupAccess";
import { resolveTailscaleEndpoint } from "./tailscaleEndpoint";
import serverPackageJson from "../package.json" with { type: "json" };

// Re-exported so CLI wiring keeps naming the variable through the module that
// owns the auth flows; the value itself lives with the client that reads it.
export { ACCOUNT_URL_ENV_NAME };

const CREDENTIALS_FILE_NAME = "account-credentials.json";

/** Exact Slice A issuer/audience derived from the root URL used by AccountClient. */
export function accountApiIssuer(accountUrl: string): string {
  return `${accountUrl.replace(/\/+$/, "")}/api/v1`;
}

/** What the user sees when a rotated refresh token can no longer be redeemed. */
export const SESSION_EXPIRED_MESSAGE = "Session expired — sign in again from the Synara app.";

/** What the user sees when the workspace they signed in to is no longer theirs. */
export const WORKSPACE_CHANGED_MESSAGE =
  "Your workspace access changed — sign in again from the Synara app.";

/**
 * The stored account file. The user session and the public-key host link have
 * independent lifetimes: an expired user session leaves the host link intact.
 * The private host key lives separately under the private secrets directory.
 *
 * `organizationId` is part of the session, not an extra: hosts belong to
 * organizations, and every refresh must name the same one or the renewed token
 * comes back unable to reach anything.
 */
export interface StoredAccountFile {
  readonly accountUrl: string;
  readonly workosClientId: string;
  readonly workosApiUrl: string;
  readonly organizationId?: string;
  /**
   * The signed-in user's id, recorded so machine-local state keyed to the
   * session (the usage reporter's watermark identity) can tell two users of
   * the same workspace apart. Optional: files written before it existed lack
   * it, and the next sign-in or token rotation backfills it.
   */
  readonly userId?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  /**
   * Legacy: released versions wrote this before every refresh and refused to
   * renew while it matched the stored token. It is still parsed so their files
   * load, but nothing writes or reads it any more; the next rotation drops it.
   */
  readonly refreshPendingTokenHash?: string | undefined;
  /** The active account row for this shell's device signing key. */
  readonly deviceId?: string;
  /** RFC 7638 thumbprint of the device key retained in the private secrets directory. */
  readonly deviceJkt?: string;
  readonly hostId?: string;
  readonly hostOwnerUserId?: string;
  readonly hostKeyGeneration?: number;
  /** Last authenticated commercial policy, never a cached paid-access grant. */
  readonly remoteBillingPolicy?: {
    readonly apiIssuer: string;
    readonly hostId: string;
    readonly ownerUserId: string;
    readonly enforced: boolean;
  };
  /**
   * Owner answers to the discoverability consent prompt, keyed by host id.
   * This is machine-local for now; a future slice may move it to the account
   * service so another owner device knows the question was already answered.
   */
  readonly discoverabilityAcknowledgedByHostId?: Readonly<Record<string, true>>;
}

/** A {@link StoredAccountFile} that carries a usable user session. */
export interface AccountCredentials extends StoredAccountFile {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationId: string;
}

type Stdout = (text: string) => void;

const defaultStdout: Stdout = (text) => {
  process.stdout.write(text);
};

/** Runs an Effect that only needs the Node path service (no scope, no filesystem layer). */
const runWithPath = <A, E>(effect: Effect.Effect<A, E, Path.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(Path.layer)));

/** Account credentials follow the installation whose environment and keys they name.
 * Production keeps its existing location; dev never adopts that live identity. */
export function accountStateDirectory(baseDir: string, devUrl?: URL): string {
  return devUrl === undefined ? baseDir : path.join(baseDir, "dev");
}

export function accountCredentialsPath(baseDir: string): string {
  return path.join(baseDir, CREDENTIALS_FILE_NAME);
}

/**
 * Reads the stored account file. A missing, unreadable, or malformed file is
 * reported as absent rather than an error: the CLI must always be able to
 * recover by running `synara auth` again.
 *
 * A pre-WorkOS file (identified by its `deviceToken`) is also treated as
 * absent. Those tokens were minted by an endpoint that no longer exists, so
 * there is nothing to migrate — re-authenticating is the only path forward.
 */
export async function readAccountFile(baseDir: string): Promise<StoredAccountFile | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(accountCredentialsPath(baseDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.deviceToken === "string") return undefined;
    if (
      typeof record.accountUrl !== "string" ||
      typeof record.workosClientId !== "string" ||
      typeof record.workosApiUrl !== "string"
    ) {
      return undefined;
    }
    const hasLinkedHost =
      typeof record.hostId === "string" &&
      typeof record.hostOwnerUserId === "string" &&
      Number.isSafeInteger(record.hostKeyGeneration) &&
      Number(record.hostKeyGeneration) >= 0;
    const hasRegisteredDevice =
      typeof record.deviceId === "string" && typeof record.deviceJkt === "string";
    const hint = record.remoteBillingPolicy;
    const remoteBillingPolicy =
      hasLinkedHost &&
      typeof hint === "object" &&
      hint !== null &&
      "apiIssuer" in hint &&
      hint.apiIssuer === accountApiIssuer(record.accountUrl) &&
      "hostId" in hint &&
      hint.hostId === record.hostId &&
      "ownerUserId" in hint &&
      hint.ownerUserId === record.hostOwnerUserId &&
      "enforced" in hint &&
      typeof hint.enforced === "boolean"
        ? {
            apiIssuer: hint.apiIssuer as string,
            hostId: hint.hostId as string,
            ownerUserId: hint.ownerUserId as string,
            enforced: hint.enforced,
          }
        : undefined;
    const discoverabilityAcknowledgedByHostId =
      typeof record.discoverabilityAcknowledgedByHostId === "object" &&
      record.discoverabilityAcknowledgedByHostId !== null
        ? Object.fromEntries(
            Object.entries(record.discoverabilityAcknowledgedByHostId).filter(
              ([hostId, acknowledged]) => hostId.trim().length > 0 && acknowledged === true,
            ),
          )
        : undefined;
    return {
      accountUrl: record.accountUrl,
      workosClientId: record.workosClientId,
      workosApiUrl: record.workosApiUrl,
      ...(typeof record.organizationId === "string"
        ? { organizationId: record.organizationId }
        : {}),
      ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
      ...(typeof record.accessToken === "string" ? { accessToken: record.accessToken } : {}),
      ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
      ...(typeof record.refreshPendingTokenHash === "string"
        ? { refreshPendingTokenHash: record.refreshPendingTokenHash }
        : {}),
      ...(hasRegisteredDevice
        ? { deviceId: record.deviceId as string, deviceJkt: record.deviceJkt as string }
        : {}),
      ...(remoteBillingPolicy ? { remoteBillingPolicy } : {}),
      ...(hasLinkedHost
        ? {
            hostId: record.hostId as string,
            hostOwnerUserId: record.hostOwnerUserId as string,
            hostKeyGeneration: record.hostKeyGeneration as number,
          }
        : {}),
      ...(discoverabilityAcknowledgedByHostId &&
      Object.keys(discoverabilityAcknowledgedByHostId).length > 0
        ? { discoverabilityAcknowledgedByHostId }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The stored file, but only when it carries a redeemable user session.
 *
 * A v2 file — tokens but no `organizationId` — is deliberately not one. Its
 * refresh token is still live, but every renewal from it would produce an
 * org-less token the account refuses, so the user would see failures with no
 * hint that the file is the problem. Treating it as signed out sends them
 * through `synara auth`, which is the only thing that fixes it. The host
 * fields survive, exactly as they do after an ordinary session expiry.
 */
export async function readAccountCredentials(
  baseDir: string,
): Promise<AccountCredentials | undefined> {
  const stored = await readAccountFile(baseDir);
  if (!stored?.accessToken || !stored.refreshToken || !stored.organizationId) return undefined;
  return {
    ...stored,
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    organizationId: stored.organizationId,
  };
}

export async function writeAccountCredentials(
  baseDir: string,
  credentials: StoredAccountFile,
): Promise<void> {
  await Effect.runPromise(
    writeFileStringAtomically({
      filePath: accountCredentialsPath(baseDir),
      contents: `${JSON.stringify(credentials, null, 2)}\n`,
      mode: PRIVATE_FILE_MODE,
    }),
  );
}

export async function deleteAccountCredentials(baseDir: string): Promise<void> {
  await fs.rm(accountCredentialsPath(baseDir), { force: true });
}

export interface UnlinkLocalAccountHostOptions {
  readonly baseDir: string;
  readonly devUrl?: URL | undefined;
  readonly client?: AccountClient;
}

/**
 * Unlinks only this machine's host key while preserving the signed-in user
 * session. The remote mutation and local credential rewrite share the same
 * lock so a concurrent refresh or re-link cannot restore the old host fields.
 */
export async function unlinkLocalAccountHost(
  options: UnlinkLocalAccountHostOptions,
): Promise<void> {
  await withLockedAccountFile(accountStateDirectory(options.baseDir, options.devUrl), async () => {
    const stored = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
    if (!stored?.hostId || stored.hostKeyGeneration === undefined) return;

    const { hostIdentityPath } = await runWithPath(
      deriveServerPaths(options.baseDir, options.devUrl),
    );
    const identity = await readHostIdentity(hostIdentityPath);
    if (!identity) {
      throw new Error("The local host identity is missing, so this machine cannot prove unlinking");
    }
    const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
    const hostProof = await mintHostProof({
      identity,
      apiIssuer: accountApiIssuer(stored.accountUrl),
      environmentId,
      hostId: stored.hostId,
      keyGeneration: stored.hostKeyGeneration,
    });
    await clientFor(stored.accountUrl, options.client).unlinkHost(hostProof, stored.hostId);

    const {
      hostId: _hostId,
      hostOwnerUserId: _hostOwnerUserId,
      hostKeyGeneration: _hostKeyGeneration,
      discoverabilityAcknowledgedByHostId,
      ...session
    } = stored;
    const remainingAcknowledgements = Object.fromEntries(
      Object.entries(discoverabilityAcknowledgedByHostId ?? {}).filter(
        ([acknowledgedHostId]) => acknowledgedHostId !== stored.hostId,
      ),
    ) as Record<string, true>;
    await writeAccountCredentials(accountStateDirectory(options.baseDir, options.devUrl), {
      ...session,
      ...(Object.keys(remainingAcknowledgements).length > 0
        ? { discoverabilityAcknowledgedByHostId: remainingAcknowledgements }
        : {}),
    });
    await deleteHostIdentity(hostIdentityPath);
  });
}

/** Deletes the credentials file, reporting whether there was one to delete. */
async function deleteAccountCredentialsIfPresent(baseDir: string): Promise<boolean> {
  try {
    await fs.rm(accountCredentialsPath(baseDir));
    return true;
  } catch {
    return false;
  }
}

/**
 * The account service the CLI was pointed at, or `undefined` when it was
 * pointed at none. The CLI deliberately does not fall back to
 * `DEFAULT_ACCOUNT_URL`: `synara status` must be able to say "account features
 * are not configured" rather than report on a hosted service the operator
 * never opted into. The in-app flow, which the user reaches by clicking sign
 * in, does take the default.
 */
export function resolveAccountUrl(input: {
  readonly flag?: string | undefined;
  readonly env?: NodeJS.ProcessEnv;
}): string | undefined {
  return resolveConfiguredAccountUrl(input);
}

/**
 * Resolves the environment id the server persists at
 * `<stateDir>/environment-id`, generating and persisting it in the same format
 * when the server has never started. Registering a host under a different id
 * would leave the account with a phantom host once the server does start.
 *
 * Creation is exclusive, not last-writer-wins: `synara auth` and a starting
 * server can both find the file missing and generate different UUIDs, and the
 * loser of a plain overwrite would register a host under an id nobody
 * persisted. Whoever creates the file first wins; everyone else reads the
 * winner's id back.
 */
export async function resolveEnvironmentId(
  baseDir: string,
  devUrl?: URL | undefined,
): Promise<string> {
  const { environmentIdPath } = await runWithPath(deriveServerPaths(baseDir, devUrl));
  const readPersisted = async (): Promise<string | undefined> => {
    try {
      const persisted = (await fs.readFile(environmentIdPath, "utf8")).trim();
      return persisted.length > 0 ? persisted : undefined;
    } catch {
      return undefined;
    }
  };

  const persisted = await readPersisted();
  if (persisted !== undefined) return persisted;

  const generated = randomUUID();
  const created = await Effect.runPromise(
    createFileStringExclusively({ filePath: environmentIdPath, contents: `${generated}\n` }),
  );
  if (created) return generated;
  // Lost the creation race: the other writer's id is the persisted identity.
  const winner = await readPersisted();
  if (winner !== undefined) return winner;
  // The file exists but is empty/unreadable — a truncated write from a
  // crashed process. Fail loudly rather than mint an unpersisted id.
  throw new Error(`Environment id file at ${environmentIdPath} exists but holds no id`);
}

const SUPPORTED_PLATFORMS: Record<string, AccountHostPlatform> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

export function toAccountHostPlatform(
  platform: NodeJS.Platform | string,
): AccountHostPlatform | undefined {
  return SUPPORTED_PLATFORMS[platform];
}

/**
 * Derives this machine's reachable LAN endpoint from a running server's
 * persisted runtime state. Loopback and wildcard binds are not reachable from
 * another device, so they yield no endpoint at all rather than a URL that
 * silently fails for every other host on the account.
 */
export async function resolveLanEndpoints(
  baseDir: string,
  devUrl?: URL | undefined,
): Promise<AccountHostEndpoint[]> {
  const { serverRuntimeStatePath } = await runWithPath(deriveServerPaths(baseDir, devUrl));
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(serverRuntimeStatePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return [];
    state = parsed as Record<string, unknown>;
  } catch {
    return [];
  }
  const host = typeof state.host === "string" ? state.host : undefined;
  const endpoints: AccountHostEndpoint[] = [];
  if (host && !isWildcardHost(host) && !isLoopbackHost(host) && typeof state.origin === "string") {
    endpoints.push({ url: state.origin, transport: "lan" });
  }
  if (typeof state.port === "number" && Number.isInteger(state.port)) {
    const tailscale = await resolveTailscaleEndpoint(state.port);
    if (tailscale) endpoints.push(tailscale);
  }
  return endpoints;
}

function describeError(error: unknown): string {
  if (error instanceof AccountApiError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export interface AccountFlowOptions {
  readonly accountUrl: string;
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
  readonly devUrl?: URL | undefined;
  readonly platform?: NodeJS.Platform | string;
  readonly hostname?: string;
  readonly appVersion?: string;
  readonly devicePollDelayMs?: number;
}

function clientFor(accountUrl: string, injected: AccountClient | undefined): AccountClient {
  return injected ?? createAccountClient({ baseUrl: accountUrl });
}

/**
 * Thrown when the stored session can no longer be renewed. Distinct from a
 * transient failure: the only cure is signing in again.
 */
export class SessionExpiredError extends Error {
  constructor() {
    super(SESSION_EXPIRED_MESSAGE);
    this.name = "SessionExpiredError";
  }
}

/**
 * Thrown when the account stops accepting the workspace this machine signed in
 * to — the membership was revoked, or the organization was removed. The stored
 * refresh token may well still be good, so this is not an expiry; what is
 * stale is the organization choice, and only a fresh `synara auth` can make a
 * new one.
 */
export class WorkspaceAccessChangedError extends Error {
  constructor() {
    super(WORKSPACE_CHANGED_MESSAGE);
    this.name = "WorkspaceAccessChangedError";
  }
}

function isUnauthorized(error: unknown): boolean {
  if (!(error instanceof AccountApiError)) return false;
  if (error.status === 401) return error.code !== "bad_proof";
  // These denials are decided after authentication; a fresh token cannot fix them.
  return (
    error.status === 403 &&
    error.code !== "subscription_required" &&
    error.code !== "not_host_owner" &&
    error.code !== "device_not_registered" &&
    error.code !== "organization_rename_not_allowed"
  );
}

/** The refresh endpoint reserves this pair for WorkOS's terminal invalid_grant. */
function isGrantRejected(error: unknown): boolean {
  return error instanceof AccountApiError && error.status === 401 && error.code === "unauthorized";
}

/**
 * Why this machine dropped, stopped trusting, or could not renew its stored
 * session — or how long each step of a sign-in took.
 */
export type AccountSessionLogReason =
  /** The refresh endpoint's terminal `401 unauthorized`; the session was cleared. */
  | "refresh_rejected"
  /** The account answered `organization_required`; the session was cleared. */
  | "workspace_refused"
  /** An account, workspace or user fence refused the stored session. */
  | "identity_fence"
  /** `/me` still answered 401 after renewal; status reports signed out. */
  | "status_unauthorized"
  /** A renewal series ended without a new pair; the session is kept. */
  | "refresh_failed"
  /** One sign-in's per-step durations (step names and milliseconds only). */
  | "sign_in_timing";

type AccountSessionLogDetail = Readonly<Record<string, string | number | boolean>>;

const SESSION_LOG_REPEAT_MS = 10 * 60_000;
/** When each distinct line was last written, per credential directory (monotonic). */
const sessionLogWrittenAt = new Map<string, number>();

/**
 * One server log line for each way this machine's account session is lost, so
 * a report of an unexpected sign-out says which path fired. `detail` must stay
 * non-secret: HTTP statuses, account error codes, field names, counts and
 * durations — never tokens, emails, user or organization ids, or response
 * bodies. The same line for the same credential directory is written at most
 * once per {@link SESSION_LOG_REPEAT_MS}, so pollers cannot flood the log.
 */
export function logAccountSession(
  baseDir: string,
  reason: AccountSessionLogReason,
  detail: AccountSessionLogDetail = {},
): void {
  const key = `${baseDir}\0${reason}\0${JSON.stringify(detail)}`;
  const now = performance.now();
  const written = sessionLogWrittenAt.get(key);
  if (written !== undefined && now - written < SESSION_LOG_REPEAT_MS) return;
  for (const [writtenKey, at] of sessionLogWrittenAt)
    if (now - at >= SESSION_LOG_REPEAT_MS) sessionLogWrittenAt.delete(writtenKey);
  sessionLogWrittenAt.set(key, now);
  console.warn(`[account] session ${reason}`, detail);
}

/** The non-secret shape of a failed account call: status and code, or the error class. */
function failureDetail(error: unknown): AccountSessionLogDetail {
  if (error instanceof AccountApiError) return { status: error.status, code: error.code };
  return { failure: error instanceof Error ? error.name : typeof error };
}

const IDENTITY_FIELDS = ["accountUrl", "organizationId", "userId", "hostId"] as const;
type IdentityFields = Readonly<
  Partial<Record<(typeof IDENTITY_FIELDS)[number], string | undefined>>
>;

/** Logs which identity fence refused the session, naming the first differing field. */
function identityFenceRefused(
  baseDir: string,
  fence: string,
  current: IdentityFields,
  expected: IdentityFields,
): WorkspaceAccessChangedError {
  const field = IDENTITY_FIELDS.find((name) => current[name] !== expected[name]) ?? "none";
  logAccountSession(baseDir, "identity_fence", { fence, field });
  return new WorkspaceAccessChangedError();
}

export interface WithFreshAccessTokenOptions {
  readonly baseDir: string;
  readonly client: AccountClient;
  /** Pass the snapshot used to choose client, or bind that choice with expectedIdentity below. */
  readonly credentials?: AccountCredentials;
  /** Pin an operation to its captured authority/user/workspace/host before sending a token. */
  readonly expectedIdentity?: Pick<
    StoredAccountFile,
    "accountUrl" | "userId" | "organizationId" | "hostId"
  >;
}

/** Strips the session half of a stored file, keeping the host registration. */
function withoutSession(credentials: StoredAccountFile): StoredAccountFile {
  const {
    accessToken: _accessToken,
    refreshToken: _refreshToken,
    refreshPendingTokenHash: _refreshPendingTokenHash,
    organizationId: _organizationId,
    userId: _userId,
    ...rest
  } = credentials;
  return rest;
}

/**
 * Runs `fn` under the credential-file lock (see accountCredentialLock.ts).
 * Every read-modify-write of the stored file goes through here so concurrent
 * operations — this process's or another's — cannot interleave between the
 * read and the write.
 */
export function withLockedAccountFile<A>(baseDir: string, fn: () => Promise<A>): Promise<A> {
  return withCredentialFileLock(accountCredentialsPath(baseDir), fn);
}

/** Merge only a policy response for the still-current host; never replace session tokens. */
export async function recordRemoteBillingPolicy(
  baseDir: string,
  expected: { readonly accountUrl: string; readonly hostId: string; readonly ownerUserId: string },
  enforced: boolean,
): Promise<boolean> {
  return withLockedAccountFile(baseDir, async () => {
    const current = await readAccountFile(baseDir);
    const apiIssuer = accountApiIssuer(expected.accountUrl);
    if (
      !current ||
      accountApiIssuer(current.accountUrl) !== apiIssuer ||
      current.hostId !== expected.hostId ||
      current.hostOwnerUserId !== expected.ownerUserId
    )
      return false;
    if (current.remoteBillingPolicy?.enforced === enforced) return true;
    await writeAccountCredentials(baseDir, {
      ...current,
      remoteBillingPolicy: {
        apiIssuer,
        hostId: expected.hostId,
        ownerUserId: expected.ownerUserId,
        enforced,
      },
    });
    return true;
  });
}

/** Every host-link key writer shares the credential lock with the final CAS. */
function generateHostIdentityForLink(
  baseDir: string,
  hostIdentityPath: string,
  expected?: Pick<StoredAccountFile, "accountUrl" | "organizationId" | "userId">,
) {
  return withLockedAccountFile(baseDir, async () => {
    const current = expected ? await readAccountFile(baseDir) : undefined;
    if (
      expected &&
      (!current ||
        current.accountUrl !== expected.accountUrl ||
        current.organizationId !== expected.organizationId ||
        current.userId !== expected.userId)
    )
      throw new WorkspaceAccessChangedError();
    return generateAndPersistHostIdentity(hostIdentityPath);
  });
}

/**
 * Drops the session half of the stored file, keeping the host registration —
 * but only if the on-disk refresh token is still `consumedRefreshToken`.
 *
 * The compare-and-swap is what makes a concurrent rotation safe: a caller
 * that decided "this session is dead" from a stale snapshot must not clear
 * the fresh pair another caller has stored since. If the token on disk has
 * moved on, the clear is silently skipped — the on-disk session is not the
 * one that was rejected.
 *
 * The registration is kept because it is still real, and keeping it lets a
 * later `synara auth` re-link this machine instead of stranding a phantom
 * host on the account. The organization goes with the session: it was chosen
 * for that sign-in, and carrying it into the next one would silently re-pick
 * a workspace the user may no longer have.
 */
async function clearStoredSessionIfCurrent(
  baseDir: string,
  consumedRefreshToken: string,
): Promise<boolean> {
  return withLockedAccountFile(baseDir, async () => {
    const current = await readAccountFile(baseDir);
    if (!current || current.refreshToken !== consumedRefreshToken) return false;
    await writeAccountCredentials(baseDir, withoutSession(current));
    return true;
  });
}

/** What renewing the session produced: a usable token, or a dead session. */
type SessionRenewal =
  | { kind: "renewed"; accessToken: string; refreshToken: string; userId: string | undefined }
  | { kind: "expired" };

/**
 * Presenting the same refresh token again is how a failed renewal recovers.
 * WorkOS answers a replay inside its 30-second grace with the pair it already
 * rotated to, a token whose exchange never reached it is simply still valid,
 * and a replay after the grace is a terminal `invalid_grant` — no worse than
 * the sign-in an abandoned token would force anyway.
 * https://workos.com/docs/authkit/session-resilience
 *
 * A renewal therefore makes up to {@link RENEWAL_ATTEMPTS} attempts, spaced
 * 1s, 2s, 4s (jittered), and starts a retry only while it fits inside
 * {@link RENEWAL_RETRY_WINDOW_MS} of the first one: the series runs under the
 * credential-file lock, so it must stay short for everyone queued behind it.
 */
const RENEWAL_ATTEMPTS = 4;
const RENEWAL_RETRY_BASE_MS = 1_000;
const RENEWAL_RETRY_MAX_MS = 4_000;
// This limits replay dispatch. An in-flight replay still gets its own deadline.
const RENEWAL_RETRY_WINDOW_MS = 28_000;

/**
 * After a series fails, later renewals of the same token wait before trying
 * again: 5s, doubling per failed series up to a minute, jittered. Without it
 * every poller that finds the token expired would run its own series against
 * an account service that is down. When the service was unreachable, the
 * first caller it answers again may run one series before the wait is over.
 */
const RENEWAL_COOLDOWN_BASE_MS = 5_000;
const RENEWAL_COOLDOWN_MAX_MS = 60_000;

type RenewalCooldown = {
  readonly tokenHash: string;
  readonly failedSeries: number;
  readonly until: number;
  readonly error: unknown;
  /** The failure's logged shape, so an unchanged outage is not logged on every series. */
  readonly signature: string;
  /** The series failed without an answer from the account service itself. */
  readonly serviceUnreachable: boolean;
  /** This cooldown's one early series was already spent. */
  readonly probed: boolean;
};

/** Per credential directory: the last failed renewal series of one refresh token (monotonic clock). */
const renewalCooldowns = new Map<string, RenewalCooldown>();

/** A failure that says the account service could not be reached, not that it refused. */
function isAccountServiceUnreachable(error: unknown): boolean {
  return !(error instanceof AccountApiError) || error.status === 408 || error.status === 503;
}

/**
 * How a failed refresh call bears on the stored session. Only the endpoint's
 * `401 unauthorized` (WorkOS `invalid_grant`) ends it. A transport error,
 * timeout (408), rate answer (429) or server fault (5xx) proves nothing about
 * the token, so it is retried; `refresh_not_attempted` proves the token never
 * left the account API, so it waits for the next renewal. Any other answer is
 * a refusal this caller cannot fix by retrying, but it does not end the
 * session either.
 */
function classifyRefreshFailure(
  error: unknown,
): "rejected" | "transient" | "not-attempted" | "refused" {
  if (!(error instanceof AccountApiError)) return "transient";
  if (isGrantRejected(error)) return "rejected";
  if (error.status === 429 && error.code === "refresh_not_attempted") return "not-attempted";
  if (error.status === 408 || error.status === 429 || error.status >= 500) return "transient";
  return "refused";
}

/**
 * Renews the stored session after `consumed` was rejected, serialized under
 * the credential-file lock and committed compare-and-swap.
 *
 * Inside the lock the file is re-read first: if the refresh token on disk no
 * longer equals the one this caller consumed, another caller already
 * refreshed — the loser of that race must use the winner's stored pair, not
 * spend a token of its own (WorkOS refresh tokens are single-use, so a
 * second redemption would be refused and, without this check, would clear
 * the winner's perfectly valid session).
 *
 * A failure that is not a terminal refusal keeps the stored pair and reaches
 * the caller as itself — never as an expired session — after the bounded
 * retries above. A crash or lost reply mid-exchange is recovered the same
 * way: the next renewal presents the same token. The rotated pair is
 * persisted while still inside the lock and *before* the caller retries, and
 * the write merges into the re-read file, not the caller's snapshot, so host
 * fields stored concurrently survive.
 */
async function renewSession(
  baseDir: string,
  client: AccountClient,
  consumed: AccountCredentials,
  /** The cooldown already in force when this caller got an answer from the service. */
  answeredDuring: RenewalCooldown | undefined,
): Promise<SessionRenewal> {
  return withLockedAccountFile(baseDir, async (): Promise<SessionRenewal> => {
    const current = await readAccountFile(baseDir);
    // Signed out (or the file vanished) while this caller was in flight:
    // there is no session left to renew.
    if (!current?.refreshToken || !current.organizationId) return { kind: "expired" };
    // A replacement account is not a token rotation. A legacy user may only be
    // backfilled here while the unchanged refresh token still proves its lineage.
    if (
      current.accountUrl !== consumed.accountUrl ||
      current.organizationId !== consumed.organizationId ||
      (current.userId !== consumed.userId &&
        (consumed.userId !== undefined || current.refreshToken !== consumed.refreshToken))
    )
      throw identityFenceRefused(
        baseDir,
        "renewal_stored_account",
        {
          accountUrl: current.accountUrl,
          organizationId: current.organizationId,
          userId: current.userId,
        },
        {
          accountUrl: consumed.accountUrl,
          organizationId: consumed.organizationId,
          userId: consumed.userId,
        },
      );
    // Someone else rotated first — their stored pair is the live one.
    if (current.refreshToken !== consumed.refreshToken) {
      return current.accessToken
        ? {
            kind: "renewed",
            accessToken: current.accessToken,
            refreshToken: current.refreshToken,
            userId: current.userId,
          }
        : { kind: "expired" };
    }

    const { refreshToken, organizationId } = current;
    const tokenHash = createHash("sha256").update(refreshToken).digest("hex");
    const cooldown = renewalCooldowns.get(baseDir);
    const previous = cooldown?.tokenHash === tokenHash ? cooldown : undefined;
    const coolingDown = previous !== undefined && performance.now() < previous.until;
    // A cooldown that began because the service was unreachable ends early,
    // once, for a caller the service has just answered: the outage may be
    // over, and failing that caller with the old error would outlast it.
    const probing =
      coolingDown && previous === answeredDuring && previous.serviceUnreachable && !previous.probed;
    if (coolingDown && !probing) throw previous.error;

    const startedAt = performance.now();
    let refreshed;
    for (let attempt = 1; ; attempt++) {
      try {
        refreshed = await client.refreshAccessToken({ refreshToken, organizationId });
        break;
      } catch (refreshError) {
        const failure = classifyRefreshFailure(refreshError);
        if (failure === "rejected") {
          renewalCooldowns.delete(baseDir);
          reportReliabilityIssue("account.refresh_rejected");
          // `attempt` above 1 means the refusal answered a replay after a transient failure.
          logAccountSession(baseDir, "refresh_rejected", {
            ...failureDetail(refreshError),
            attempt,
            failedSeriesBefore: previous?.failedSeries ?? 0,
            legacyPendingMarker: current.refreshPendingTokenHash !== undefined,
          });
          await writeAccountCredentials(baseDir, withoutSession(current));
          return { kind: "expired" };
        }
        const delay = jitterMs(
          exponentialBackoffMs(attempt, RENEWAL_RETRY_BASE_MS, RENEWAL_RETRY_MAX_MS),
        );
        if (
          failure === "transient" &&
          attempt < RENEWAL_ATTEMPTS &&
          performance.now() - startedAt + delay <= RENEWAL_RETRY_WINDOW_MS
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          if (performance.now() - startedAt <= RENEWAL_RETRY_WINDOW_MS) continue;
        }
        reportReliabilityIssue(
          failure === "not-attempted"
            ? "account.refresh_rate_limited"
            : "account.refresh_uncertain",
        );
        const failedSeries = (previous?.failedSeries ?? 0) + 1;
        const cooldownMs = jitterMs(
          exponentialBackoffMs(failedSeries, RENEWAL_COOLDOWN_BASE_MS, RENEWAL_COOLDOWN_MAX_MS),
        );
        const detail = { ...failureDetail(refreshError), outcome: failure };
        const signature = JSON.stringify(detail);
        renewalCooldowns.set(baseDir, {
          tokenHash,
          failedSeries,
          until: performance.now() + cooldownMs,
          error: refreshError,
          signature,
          serviceUnreachable: isAccountServiceUnreachable(refreshError),
          probed: probing,
        });
        // A long outage logs its 1st, 2nd, 4th, 8th… series, and any series
        // that fails differently from the one before.
        if ((failedSeries & (failedSeries - 1)) === 0 || previous?.signature !== signature)
          logAccountSession(baseDir, "refresh_failed", {
            ...detail,
            attempts: attempt,
            failedSeries,
            retryInMs: Math.round(cooldownMs),
            legacyPendingMarker: current.refreshPendingTokenHash !== undefined,
          });
        throw refreshError;
      }
    }
    renewalCooldowns.delete(baseDir);

    if (current.userId !== undefined && refreshed.user.id !== current.userId)
      throw identityFenceRefused(
        baseDir,
        "renewal_refreshed_user",
        { userId: refreshed.user.id },
        { userId: current.userId },
      );
    const { refreshPendingTokenHash: _legacyPendingMarker, ...stored } = current;
    await writeAccountCredentials(baseDir, {
      ...stored,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      // Backfills files written before userId existed; on current files this
      // rewrites the same id.
      userId: refreshed.user.id,
    });
    return {
      kind: "renewed",
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      userId: refreshed.user.id,
    };
  });
}

/**
 * Runs `fn` with the stored access token, renewing it once if the account
 * rejects it, or before sending it once this process has seen it outlive its
 * own lifetime. WorkOS access tokens live about five minutes, so any CLI
 * command run more than a few minutes after `synara auth` needs this.
 *
 * Credentials are re-read per call rather than captured by the caller: a
 * rotation performed for one call must be visible to the next one, and the
 * spent refresh token must never be presented twice. Renewal itself runs
 * under the credential-file lock with compare-and-swap semantics — see
 * {@link renewSession} — so concurrent expired-token operations cannot
 * double-spend the single-use refresh token or clobber each other's writes.
 *
 * The early renewal trusts no wall clock: it compares the token's own lifetime
 * (`exp - iat`) with how long this process has held it on its monotonic clock.
 * A token first seen after a restart, a token without those claims, or a clock
 * that runs ahead therefore falls back to the rejected-call path, so it never
 * renews more often than a 401 would have.
 *
 * Only a terminal refusal of the refresh token signs the session out. Any
 * other renewal failure — including an early renewal attempted while this
 * machine is offline — rejects with that failure and leaves the stored pair
 * for the next call to renew.
 */
export async function withFreshAccessToken<A>(
  options: WithFreshAccessTokenOptions,
  fn: (accessToken: string) => Promise<A>,
): Promise<A> {
  const { baseDir, client } = options;
  const credentials = options.credentials ?? (await readAccountCredentials(baseDir));
  if (!credentials) throw new SessionExpiredError();
  const assertIdentity = (current: StoredAccountFile, fence: string) => {
    const expected = options.expectedIdentity;
    if (
      expected &&
      (current.accountUrl !== expected.accountUrl ||
        current.userId !== expected.userId ||
        current.organizationId !== expected.organizationId ||
        current.hostId !== expected.hostId)
    )
      throw identityFenceRefused(baseDir, fence, current, expected);
  };
  assertIdentity(credentials, "expected_identity_before_send");
  const send = async (accessToken: string, refreshToken: string): Promise<A> => {
    try {
      return await fn(accessToken);
    } catch (error) {
      if (!(error instanceof OrganizationRequiredError)) throw error;
      const cleared = await clearStoredSessionIfCurrent(baseDir, refreshToken);
      logAccountSession(baseDir, "workspace_refused", {
        cleared,
        organizations: error.organizations.length,
      });
      throw new WorkspaceAccessChangedError();
    }
  };
  let answeredDuring: RenewalCooldown | undefined;
  // A token held for its whole lifetime would only come back 401; renew before sending it.
  if (!accessTokenOutlived(baseDir, credentials.accessToken)) {
    try {
      return await send(credentials.accessToken, credentials.refreshToken);
    } catch (error) {
      if (!isUnauthorized(error)) throw error;
      answeredDuring = renewalCooldowns.get(baseDir);
    }
  }

  const renewal = await renewSession(baseDir, client, credentials, answeredDuring);
  if (renewal.kind === "expired") throw new SessionExpiredError();
  const current = await readAccountCredentials(baseDir);
  if (!current) throw new SessionExpiredError();
  // Renewal's verified user includes the permitted legacy backfill. Host metadata
  // may change independently; explicit background identity fences still apply below.
  if (
    current.accountUrl !== credentials.accountUrl ||
    current.organizationId !== credentials.organizationId ||
    current.userId !== renewal.userId
  )
    throw identityFenceRefused(
      baseDir,
      "after_renewal",
      {
        accountUrl: current.accountUrl,
        organizationId: current.organizationId,
        userId: current.userId,
      },
      {
        accountUrl: credentials.accountUrl,
        organizationId: credentials.organizationId,
        userId: renewal.userId,
      },
    );
  assertIdentity(current, "expected_identity_after_renewal");
  accessTokenOutlived(baseDir, renewal.accessToken);
  return send(renewal.accessToken, renewal.refreshToken);
}

/** When this process first held each credential directory's current access token (monotonic). */
const accessTokenFirstSeen = new Map<string, { readonly tokenHash: string; readonly at: number }>();

/**
 * Whether this process has held the token at least its own lifetime. First
 * sight comes after issuance, so a true answer means the account API would
 * already refuse it; the claims only avoid a doomed request, never authorize.
 */
function accessTokenOutlived(baseDir: string, accessToken: string): boolean {
  const claims = decodeJwtClaims(accessToken);
  const exp = claims?.exp;
  const iat = claims?.iat;
  if (typeof exp !== "number" || typeof iat !== "number" || !(exp > iat)) return false;
  const tokenHash = createHash("sha256").update(accessToken).digest("hex");
  const seen = accessTokenFirstSeen.get(baseDir);
  if (seen?.tokenHash !== tokenHash) {
    accessTokenFirstSeen.set(baseDir, { tokenHash, at: performance.now() });
    return false;
  }
  return performance.now() - seen.at >= (exp - iat) * 1_000;
}

/**
 * Resolves which workspace to use, fail-closed. V1 is personal-org-only:
 * one organization answers itself; several are refused with a classified
 * error rather than silently taking whichever the provider listed first
 * (membership order is not a tenant-selection contract). None means the
 * account is unusable until a workspace exists.
 */
export async function selectOrganization(
  organizations: readonly OrganizationSummary[],
): Promise<OrganizationSummary> {
  const first = organizations[0];
  if (!first) {
    throw new Error(
      "Your account has no workspace to sign in to. Contact your administrator, or create one in the WorkOS dashboard.",
    );
  }
  if (organizations.length > 1) {
    throw new AccountApiError({
      code: "multiple_organizations_unsupported",
      status: 403,
      message: "Multiple workspaces aren't supported yet",
    });
  }
  return first;
}

/**
 * Links this machine against the stored session and records the host fields,
 * leaving the session half of the file exactly as it found it.
 *
 * The credentials are re-read from disk after the call rather than merged into
 * a captured copy: `withFreshAccessToken` may have rotated and persisted a new
 * token pair on the way through, and writing a stale pair back over it would
 * spend the user's session for nothing.
 */
async function linkThisHost(
  options: AccountFlowOptions,
  client: AccountClient,
  stdout: Stdout,
): Promise<void> {
  const platform = toAccountHostPlatform(options.platform ?? process.platform);
  if (!platform) {
    stdout(
      `Signed in, but this host was not registered: platform "${String(options.platform ?? process.platform)}" is not supported for remote hosts (darwin, linux, windows).\n`,
    );
    return;
  }

  const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
  const name = options.hostname ?? OS.hostname();
  const appVersion = options.appVersion ?? serverPackageJson.version;
  const { hostIdentityPath } = await runWithPath(
    deriveServerPaths(options.baseDir, options.devUrl),
  );

  const expected = await withLockedAccountFile(
    accountStateDirectory(options.baseDir, options.devUrl),
    async () => {
      const current = await readAccountCredentials(
        accountStateDirectory(options.baseDir, options.devUrl),
      );
      if (!current) throw new SessionExpiredError();
      // The passed client was selected before this locked read; never lend it another issuer's token.
      if (current.accountUrl !== options.accountUrl) throw new WorkspaceAccessChangedError();
      if (!current.userId || !current.hostOwnerUserId || current.hostOwnerUserId === current.userId)
        return current;
      // Repair an older mismatched file before a network failure can leave it serving.
      const {
        hostId: _hostId,
        hostOwnerUserId: _hostOwnerUserId,
        hostKeyGeneration: _hostKeyGeneration,
        remoteBillingPolicy: _remoteBillingPolicy,
        discoverabilityAcknowledgedByHostId: _discoverabilityAcknowledgedByHostId,
        ...session
      } = current;
      await writeAccountCredentials(
        accountStateDirectory(options.baseDir, options.devUrl),
        session,
      );
      await deleteHostIdentity(hostIdentityPath);
      return session;
    },
  );

  let linked;
  let linkedPublicKeyPem: string | undefined;
  try {
    const challenge = await withFreshAccessToken(
      {
        baseDir: accountStateDirectory(options.baseDir, options.devUrl),
        client,
        expectedIdentity: expected,
      },
      (accessToken) =>
        client.startHostLink(accessToken, {
          environmentId: EnvironmentId.makeUnsafe(environmentId),
          name,
          platform,
          kind: "local",
        }),
    );
    // Every link attempt is a key rotation. Persist before completing so the
    // account can never accept a public key this process did not durably keep.
    const identity = await generateHostIdentityForLink(
      accountStateDirectory(options.baseDir, options.devUrl),
      hostIdentityPath,
      expected,
    );
    linkedPublicKeyPem = identity.publicKeyPem;
    const proof = await mintHostLinkProof({
      identity,
      apiIssuer: accountApiIssuer(options.accountUrl),
      environmentId,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
      name,
      platform,
      appVersion,
    });
    linked = await client.completeHostLink({ challengeId: challenge.challengeId, proof });
  } catch (error) {
    stdout(
      `Signed in, but linking this host failed: ${describeError(error)}\nRun \`synara auth\` to try again.\n`,
    );
    return;
  }

  const endpoints = await resolveLanEndpoints(options.baseDir, options.devUrl);
  const saved = await withLockedAccountFile(
    accountStateDirectory(options.baseDir, options.devUrl),
    async () => {
      const current = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
      if (!current) return "missing" as const;
      // A completed link must not restore an old owner's authority after sign-in changed.
      if (
        current.accountUrl !== expected.accountUrl ||
        current.organizationId !== expected.organizationId ||
        current.userId !== expected.userId ||
        (current.userId !== undefined && current.userId !== linked.host.ownerUserId)
      )
        throw new WorkspaceAccessChangedError();
      const persistedIdentity = await readHostIdentity(hostIdentityPath);
      if (!persistedIdentity || persistedIdentity.publicKeyPem !== linkedPublicKeyPem) {
        return "superseded" as const;
      }
      await writeAccountCredentials(accountStateDirectory(options.baseDir, options.devUrl), {
        ...current,
        hostId: linked.host.id,
        hostOwnerUserId: linked.host.ownerUserId,
        hostKeyGeneration: linked.host.keyGeneration,
      });
      return "saved" as const;
    },
  );
  if (saved === "missing") {
    stdout(
      `Linked this host as "${linked.host.name}" (${linked.host.id}), but the local credentials file disappeared before the link could be saved.\nRun \`synara auth\` again; unlink the stale host if it lingers.\n`,
    );
    return;
  }
  if (saved === "superseded") {
    stdout(
      "Another host link completed with a newer local key, so this link result was not stored.\n",
    );
    return;
  }

  if (endpoints.length > 0) {
    try {
      const { hostIdentityPath } = await runWithPath(
        deriveServerPaths(options.baseDir, options.devUrl),
      );
      const identity = await readHostIdentity(hostIdentityPath);
      if (identity) {
        const hostProof = await mintHostProof({
          identity,
          apiIssuer: accountApiIssuer(options.accountUrl),
          environmentId,
          hostId: linked.host.id,
          keyGeneration: linked.host.keyGeneration,
        });
        await client.replaceHostEndpoints(hostProof, linked.host.id, endpoints);
      }
    } catch {
      // Endpoint reporting is startup-refreshed and must not invalidate a
      // successfully persisted link.
    }
  }

  stdout(
    [
      `Signed in to ${options.accountUrl}.`,
      `Linked this host as "${linked.host.name}" (${linked.host.platform}, ${linked.host.id}).`,
      endpoints.length === 0
        ? "No reachable endpoint was advertised — start the server on a LAN address to make this host reachable."
        : `Advertising ${endpoints.map((endpoint) => endpoint.url).join(", ")}.`,
      "",
    ].join("\n"),
  );
}

/**
 * ADR 0015's primary Desktop path: link the bundled local host when the
 * signed-in session does not already have a complete, usable local link.
 * `linkThisHost` deliberately leaves sign-in usable when the account service
 * is unavailable; a later status read retries this idempotent guard.
 */
export async function ensureLocalAccountHostLinked(options: AccountFlowOptions): Promise<void> {
  const existing = await readAccountCredentials(
    accountStateDirectory(options.baseDir, options.devUrl),
  );
  if (!existing) return;
  const { hostIdentityPath } = await runWithPath(
    deriveServerPaths(options.baseDir, options.devUrl),
  );
  if (
    existing.hostId &&
    existing.hostOwnerUserId &&
    existing.hostOwnerUserId === existing.userId &&
    existing.hostKeyGeneration !== undefined &&
    (await readHostIdentity(hostIdentityPath))
  ) {
    return;
  }
  await linkThisHost(
    options,
    clientFor(existing.accountUrl, options.client),
    options.stdout ?? (() => {}),
  );
}

/**
 * Which account URL `synara auth` must register the host against.
 *
 * Once a session exists, the URL persisted at sign-in wins — exactly as
 * refresh, status, and logout resolve theirs — because the stored tokens were
 * minted by THAT service and registering through any other URL would send
 * them somewhere they do not belong. An explicit `--account-url`/env value
 * that CONTRADICTS the stored one is refused loudly rather than silently
 * overridden in either direction: the user asked for a service the session
 * does not belong to, and only signing out resolves that.
 *
 * With no session stored, the explicit value (possibly `undefined`) is
 * returned unchanged — the caller keeps its configured-URL requirement.
 */
export async function resolveAuthLoginAccountUrl(options: {
  readonly baseDir: string;
  readonly explicitUrl: string | undefined;
  readonly devUrl?: URL;
}): Promise<string | undefined> {
  const stored = await readAccountCredentials(
    accountStateDirectory(options.baseDir, options.devUrl),
  );
  if (!stored) return options.explicitUrl;
  if (options.explicitUrl !== undefined && options.explicitUrl !== stored.accountUrl) {
    throw new Error(
      `This machine is signed in to ${stored.accountUrl}, but ${options.explicitUrl} was requested. Run \`synara auth logout\` first to link against a different account service.`,
    );
  }
  return stored.accountUrl;
}

/**
 * `synara auth` — links this machine as a host using the app's signed-in
 * session. Sign-in itself is app-only (email OTP or SSO in the Synara UI);
 * the CLI and the app share the credentials file, so once the app has signed
 * in, this command has a session to register the host with.
 */
export async function runAuthLogin(options: AccountFlowOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  const existing = await readAccountCredentials(
    accountStateDirectory(options.baseDir, options.devUrl),
  );
  if (!existing) {
    stdout(
      "Not signed in — sign in from the Synara app first (account menu), then run `synara auth` to link this machine.\n",
    );
    return;
  }

  const { hostIdentityPath } = await runWithPath(
    deriveServerPaths(options.baseDir, options.devUrl),
  );
  if (
    existing.hostId &&
    existing.hostOwnerUserId &&
    existing.hostOwnerUserId === existing.userId &&
    existing.hostKeyGeneration !== undefined &&
    (await readHostIdentity(hostIdentityPath))
  ) {
    stdout(
      `Already signed in to ${existing.accountUrl} and this host is linked.\nRun \`synara auth logout\` first to link as someone else.\n`,
    );
    return;
  }

  const client = clientFor(options.accountUrl, options.client);
  stdout("Signed in — completing host link.\n");
  await linkThisHost(options, client, stdout);
}

/** Links a headless host through the account service's device-code approval flow. */
export async function runDeviceCodeHostLink(options: AccountFlowOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  const client = clientFor(options.accountUrl, options.client);
  const platform = toAccountHostPlatform(options.platform ?? process.platform);
  if (!platform)
    throw new Error(`Unsupported host platform: ${options.platform ?? process.platform}`);
  const code = await client.startDeviceHostLink();
  stdout(`Open ${code.verificationUri} and enter code ${code.userCode}.\nWaiting for approval…\n`);
  const expiresAt = new Date(code.expiresAt).getTime();
  let challenge: Awaited<ReturnType<AccountClient["exchangeDeviceHostLink"]>>;
  while (true) {
    if (Date.now() >= expiresAt) throw new Error("The device link code expired");
    try {
      challenge = await client.exchangeDeviceHostLink({ deviceCode: code.deviceCode });
      break;
    } catch (error) {
      if (!(error instanceof AccountApiError) || error.code !== "approval_pending") throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options.devicePollDelayMs ?? code.interval * 1_000),
      );
    }
  }
  const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
  const name = options.hostname ?? OS.hostname();
  const { hostIdentityPath } = await runWithPath(
    deriveServerPaths(options.baseDir, options.devUrl),
  );
  const identity = await generateHostIdentityForLink(
    accountStateDirectory(options.baseDir, options.devUrl),
    hostIdentityPath,
  );
  const proof = await mintHostLinkProof({
    identity,
    apiIssuer: accountApiIssuer(options.accountUrl),
    environmentId,
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    name,
    platform,
    appVersion: options.appVersion ?? serverPackageJson.version,
  });
  const linked = await client.completeHostLink({ challengeId: challenge.challengeId, proof });
  const instance = await client.instance();
  await withLockedAccountFile(accountStateDirectory(options.baseDir, options.devUrl), async () => {
    const persistedIdentity = await readHostIdentity(hostIdentityPath);
    if (!persistedIdentity || persistedIdentity.publicKeyPem !== identity.publicKeyPem) {
      throw new Error("Another host link superseded this device-code link with a newer local key");
    }
    const previous = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
    await writeAccountCredentials(accountStateDirectory(options.baseDir, options.devUrl), {
      ...(previous?.accountUrl === options.accountUrl ? previous : {}),
      accountUrl: options.accountUrl,
      workosClientId: instance.clientId,
      workosApiUrl: instance.workosApiUrl,
      hostId: linked.host.id,
      hostOwnerUserId: linked.host.ownerUserId,
      hostKeyGeneration: linked.host.keyGeneration,
    });
  });
  await refreshHostRegistration({
    baseDir: options.baseDir,
    client,
    ...(options.devUrl ? { devUrl: options.devUrl } : {}),
  }).catch(() => {});
  stdout(`Linked this host as "${linked.host.name}" (${linked.host.id}).\n`);
}

/** A scoped session: tokens that name a workspace, which one, and whose. */
export interface ScopedSessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly organizationId: string;
  /** The signed-in user's id, persisted alongside the session. */
  readonly userId: string;
}

export interface ScopeTokenToWorkspaceOptions {
  readonly client: AccountClient;
  /**
   * Resolves the workspace from the account's list. Both callers — the CLI
   * and the in-app flow — fail closed on more than one workspace in V1
   * (personal-org-only); the seam stays injected so a future workspace
   * picker slots in without touching probing, refreshing, or how the token
   * is spent.
   */
  readonly chooseOrganization: (
    organizations: readonly OrganizationSummary[],
  ) => Promise<OrganizationSummary>;
  /** Told which workspace was chosen, once, after the scoped token is minted. */
  readonly onOrganizationChosen?: (organization: OrganizationSummary) => void;
  /** Times each request this makes, for the sign-in step log. */
  readonly measure?: <A>(
    step: "workspace_probe" | "workspace_refresh",
    run: () => Promise<A>,
  ) => Promise<A>;
}

/**
 * Turns an org-less token a sign-in grant returns into one scoped to a
 * workspace.
 *
 * The probe is a real `/me` call rather than an assumption: WorkOS mints
 * sign-in tokens without `org_id`, so the account answers 403 with the
 * memberships to choose from — and, on a first-ever sign-in, provisions the
 * personal workspace as a side effect of being asked. A token that already
 * carries a workspace skips the whole dance.
 */
export async function scopeTokenToWorkspace(
  token: { accessToken: string; refreshToken: string },
  options: ScopeTokenToWorkspaceOptions,
): Promise<ScopedSessionTokens> {
  const { client, chooseOrganization, onOrganizationChosen } = options;
  const measure = options.measure ?? (<A>(_step: string, run: () => Promise<A>) => run());

  let organizations: readonly OrganizationSummary[];
  try {
    const me = await measure("workspace_probe", () => client.me(token.accessToken));
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      organizationId: me.organization.id,
      userId: me.id,
    };
  } catch (error) {
    if (!(error instanceof OrganizationRequiredError)) throw error;
    organizations = error.organizations;
  }

  const organization = await chooseOrganization(organizations);
  // Redeeming the refresh token here spends it, so the rotated pair this
  // returns is the only usable one — the caller must persist it, not the
  // pair it started with.
  const refreshed = await measure("workspace_refresh", () =>
    client.refreshAccessToken({
      refreshToken: token.refreshToken,
      organizationId: organization.id,
      timeoutMs: GRANT_REQUEST_TIMEOUT_MS,
    }),
  );

  onOrganizationChosen?.(organization);
  return {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    organizationId: organization.id,
    userId: refreshed.user.id,
  };
}

export interface RefreshHostRegistrationOptions {
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly devUrl?: URL | undefined;
  readonly appVersion?: string;
}

/**
 * Re-advertises this machine's reachable endpoints and bumps `lastSeenAt`.
 *
 * Called once per server start, best effort: a host that was linked before
 * ever starting the server registered with no endpoints at all, and
 * nothing else would ever fix that. Failure is silent by design — the account
 * is an optional add-on and must never be able to hold up or fail a boot.
 */
export async function refreshHostRegistration(
  options: RefreshHostRegistrationOptions,
): Promise<void> {
  const credentials = await readAccountFile(accountStateDirectory(options.baseDir, options.devUrl));
  if (!credentials?.hostId || credentials.hostKeyGeneration === undefined) return;

  const client = clientFor(credentials.accountUrl, options.client);
  const endpoints = await resolveLanEndpoints(options.baseDir, options.devUrl);
  const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
  const { hostIdentityPath } = await runWithPath(
    deriveServerPaths(options.baseDir, options.devUrl),
  );
  const identity = await readHostIdentity(hostIdentityPath);
  if (!identity) return;
  const hostProof = await mintHostProof({
    identity,
    apiIssuer: accountApiIssuer(credentials.accountUrl),
    environmentId,
    hostId: credentials.hostId,
    keyGeneration: credentials.hostKeyGeneration,
  });
  await client.replaceHostEndpoints(hostProof, credentials.hostId, endpoints);
}

/**
 * Sign-out talks to the account the credentials were minted against, never an
 * ambient one: unsetting `SYNARA_ACCOUNT_URL` after signing in must not strand
 * a user with credentials they cannot revoke.
 */
export interface LogoutOptions {
  readonly baseDir: string;
  readonly devUrl?: URL | undefined;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
}

export async function runAuthLogout(options: LogoutOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  // The whole logout — read, remote host teardown, file deletion — runs
  // under the credential-file lock. Deleting the file without it lets a
  // concurrent slow refresh (or a host-registration save) that read the file
  // before the deletion write its result afterwards, silently recreating the
  // credentials logout just reported deleted. Ordering inside the lock
  // matters too: the host link is re-read and the remote host unlinked
  // *inside* the critical section, so the host torn down is the one on disk
  // at that moment (a racing registration or rotation commits either before
  // this section — and its result is what gets torn down — or after the file
  // is gone, where every writer's own locked re-read makes it bail). The
  // remote call is bounded by the client's request timeout, far inside the
  // lock's stale threshold, so holding the lock across it is safe.
  await withLockedAccountFile(accountStateDirectory(options.baseDir, options.devUrl), async () => {
    // Deliberately the raw file, not a live session: a user whose session
    // expired still has a host registration to tear down and a file to delete.
    const credentials = await readAccountFile(
      accountStateDirectory(options.baseDir, options.devUrl),
    );
    if (!credentials) {
      // A file that exists but does not parse as v2 is a leftover from a
      // previous version or a corrupt write. Deleting it is the whole point of
      // logout, and leaving it behind would also keep `synara auth` from ever
      // reporting a clean "Not signed in".
      const stale = await deleteAccountCredentialsIfPresent(
        accountStateDirectory(options.baseDir, options.devUrl),
      );
      stdout(
        stale
          ? "Removed stale credentials from a previous version. The host record may need manual removal.\n"
          : "Not signed in — nothing to do.\n",
      );
      return;
    }

    // Every remote call here is best effort: local credentials must be dropped
    // even when the account server is unreachable, otherwise a user with a dead
    // network can never sign out.
    const client = clientFor(credentials.accountUrl, options.client);

    if (credentials.hostId && credentials.hostKeyGeneration !== undefined) {
      try {
        const environmentId = await resolveEnvironmentId(options.baseDir, options.devUrl);
        const { hostIdentityPath } = await runWithPath(
          deriveServerPaths(options.baseDir, options.devUrl),
        );
        const identity = await readHostIdentity(hostIdentityPath);
        if (identity) {
          const hostProof = await mintHostProof({
            identity,
            apiIssuer: accountApiIssuer(credentials.accountUrl),
            environmentId,
            hostId: credentials.hostId,
            keyGeneration: credentials.hostKeyGeneration,
          });
          await client.unlinkHost(hostProof, credentials.hostId);
          stdout(`Unlinked host ${credentials.hostId} from the account.\n`);
        }
      } catch (error) {
        stdout(`Could not unlink host ${credentials.hostId}: ${describeError(error)}\n`);
      }
    }

    // The account service no longer brokers session listing or revocation —
    // WorkOS owns sessions, and the access token is short-lived. Dropping the
    // local credentials is what sign-out means here.
    await deleteAccountCredentials(accountStateDirectory(options.baseDir, options.devUrl));
    const { hostIdentityPath } = await runWithPath(
      deriveServerPaths(options.baseDir, options.devUrl),
    );
    await deleteHostIdentity(hostIdentityPath);
    stdout(
      `Signed out of ${credentials.accountUrl}. Local credentials deleted.\nThe browser session at the identity provider expires on its own.\n`,
    );
  });
}

export interface StatusOptions {
  readonly accountUrl?: string | undefined;
  readonly baseDir: string;
  readonly client?: AccountClient;
  readonly stdout?: Stdout;
  readonly devUrl?: URL | undefined;
}

function formatEndpoints(host: AccountHost): string {
  return host.endpoints.length === 0
    ? "—"
    : host.endpoints.map((endpoint) => `${endpoint.url} (${endpoint.transport})`).join(", ");
}

function renderHostTable(hosts: readonly AccountHost[], thisHostId: string | undefined): string {
  const header = ["", "NAME", "PLATFORM", "KIND", "ENDPOINTS", "LAST SEEN"];
  const rows = hosts.map((host) => [
    host.id === thisHostId ? "*" : "",
    host.name,
    host.platform,
    host.kind,
    formatEndpoints(host),
    host.lastSeenAt,
  ]);
  const widths = header.map((_, column) =>
    Math.max(header[column]?.length ?? 0, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const renderRow = (cells: string[]) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [renderRow(header), ...rows.map(renderRow)].join("\n");
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const stdout = options.stdout ?? defaultStdout;
  if (!options.accountUrl) {
    stdout(
      `Account features are not configured — set ${ACCOUNT_URL_ENV_NAME} (or pass --account-url) to point at a Synara account server.\n`,
    );
    return;
  }

  const credentials = await readAccountCredentials(
    accountStateDirectory(options.baseDir, options.devUrl),
  );
  if (!credentials) {
    stdout(`Not signed in to ${options.accountUrl} — sign in from the Synara app.\n`);
    return;
  }

  const client = clientFor(credentials.accountUrl, options.client);
  let sessionCredentials = credentials;
  const withToken = <A>(fn: (accessToken: string) => Promise<A>) =>
    withFreshAccessToken(
      {
        baseDir: accountStateDirectory(options.baseDir, options.devUrl),
        client,
        credentials: sessionCredentials,
      },
      fn,
    );

  let me;
  try {
    me = await withToken((accessToken) => client.me(accessToken));
    // Use the rotated token for the next call, allowing only the user /me just verified
    // to backfill a legacy file. Host enrollment metadata does not change this identity.
    const current = await readAccountCredentials(
      accountStateDirectory(options.baseDir, options.devUrl),
    );
    if (!current) throw new SessionExpiredError();
    if (
      current.accountUrl !== credentials.accountUrl ||
      current.organizationId !== credentials.organizationId ||
      (current.userId !== (credentials.userId ?? me.id) &&
        !(
          credentials.userId === undefined &&
          current.userId === undefined &&
          current.refreshToken === credentials.refreshToken
        ))
    )
      throw new WorkspaceAccessChangedError();
    sessionCredentials = current;
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      stdout(`${SESSION_EXPIRED_MESSAGE}\n`);
      return;
    }
    if (error instanceof WorkspaceAccessChangedError) {
      stdout(`${WORKSPACE_CHANGED_MESSAGE}\n`);
      return;
    }
    // Only a rejected token is worth telling the user to sign in again for;
    // an unreachable server would make that advice actively wrong.
    const rejected =
      error instanceof AccountApiError && (error.status === 401 || error.status === 403);
    stdout(
      rejected
        ? `Signed in to ${credentials.accountUrl}, but the account rejected the stored token: ${describeError(error)}\nRun \`synara auth logout\`, then sign in again from the Synara app.\n`
        : `Signed in to ${credentials.accountUrl}, but could not reach the account: ${describeError(error)}\n`,
    );
    return;
  }

  stdout(
    `Account:  ${credentials.accountUrl}\nSigned in: ${me.name} <${me.email}>\nWorkspace: ${me.organization.name}\n`,
  );

  let hosts: readonly AccountHost[];
  try {
    hosts = (await withToken((accessToken) => client.listHosts(accessToken))).hosts;
  } catch (error) {
    stdout(`Could not list hosts: ${describeError(error)}\n`);
    return;
  }

  const thisHost = credentials.hostId
    ? hosts.find((host) => host.id === credentials.hostId)
    : undefined;
  stdout(
    thisHost
      ? `This host: ${thisHost.name} (${thisHost.platform}, ${thisHost.kind}) — ${formatEndpoints(thisHost)}\n`
      : "This host: not registered — run `synara auth` to register it.\n",
  );

  stdout(
    hosts.length === 0
      ? "\nNo hosts registered on this account.\n"
      : `\nHosts (${hosts.length}):\n${renderHostTable(hosts, credentials.hostId)}\n`,
  );
}
