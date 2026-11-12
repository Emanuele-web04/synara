import {
  WsRpcError,
  type AccountSaveInboxRecapInput,
  type SavedInboxRecap,
  type ListSavedInboxRecapsInput,
  type ListSavedInboxRecapsResponse,
  type SavedInboxRecapIdInput,
} from "@synara/contracts";
import { ACCOUNT_INBOX_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import {
  remoteConnectionsUnavailableReason,
  requireAccountProfileSync,
  requireHostSecretsSync,
} from "./remoteFeaturePolicy";
/**
 * accountSession - the in-app account session, as the RPC handlers need it.
 *
 * The app never holds account credentials: the server owns the stored
 * credential file and every WorkOS round trip, and this module is the whole of
 * that. It is a thin adapter over `accountAuth` (the credential file, token
 * refresh, workspace scoping) and `AccountClient` (the HTTP surface) — the
 * `synara auth` CLI flow and the in-app flow share both, and the only thing
 * this adds is the parts a GUI needs and a terminal does not: a status that
 * reports "signed out" instead of throwing, a device poll the server runs on
 * the client's behalf, and the in-app email OTP grant.
 *
 * Two ways in, converging immediately. Email OTP sign-in happens inside
 * the app and the emailed code is pass-through — forwarded to the account
 * service, held nowhere here. SSO ("Continue with Google/Apple/GitHub")
 * takes the authorization-code + PKCE grant with a loopback redirect and the
 * system browser. Both end in `establishSession`, so workspace scoping and
 * credential persistence cannot drift between them.
 *
 * @module accountSession
 */
import { deleteHostIdentity } from "./hostIdentity";
import { randomUUID } from "node:crypto";
import OS from "node:os";

import type {
  AccountBillingStatus,
  AccountBillingCheckoutRequest,
  AccountBillingRedirect,
  AccountDeleteInput,
  AccountAuthenticateOtpInput,
  AccountDevice,
  AccountHost,
  AccountUsageSummaryInput,
  AccountBeginSsoInput,
  AccountBeginSsoResult,
  AccountCompleteSsoInput,
  AccountMe,
  AccountSendOtpInput,
  AccountSendOtpResult,
  AccountStatus,
  AccountUpdateProfileInput,
  AccountUploadAvatarInput,
  InstanceInfo,
  HostsEnrollmentResult,
  UsageSummary,
  ConfirmSyncKeyPairingRequest,
  SyncKeyPairingCode,
  SyncKeyPairingRequest,
} from "@synara/contracts";
import {
  AccountApiError,
  DEFAULT_ACCOUNT_URL,
  resolveAccountUrl,
  type AccountClient,
} from "@synara/shared/account";

import {
  accountApiIssuer,
  accountStateDirectory,
  ensureLocalAccountHostLinked,
  logAccountSession,
  readAccountCredentials,
  readAccountFile,
  deleteAccountCredentials,
  runAuthLogout,
  scopeTokenToWorkspace,
  selectOrganization,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
  unlinkLocalAccountHost,
  toAccountHostPlatform,
} from "./accountAuth";
import {
  ensureAccountDeviceRegistration,
  recoverAccountDeviceRegistration,
  type AccountDeviceRegistrationScope,
  type RegisteredAccountDeviceIdentity,
} from "./accountDeviceRegistration";
import { deviceIdentityPath, loadOrCreateDeviceIdentity } from "./deviceIdentity";
import {
  createPkcePair,
  createSsoState,
  startSsoCallbackListener,
  type SsoCallbackListener,
} from "./accountSsoCallback";
import { createServerAccountClient } from "./accountHttp";
import { createSignInTiming, type SignInTiming } from "./accountSignInTiming";
import { nudgeAccountUsageReporter } from "./accountUsageReporterRegistry";
import { noteRemoteAccessGranted, nudgeHostAuthorization } from "./hostConnectivitySignals";
import { Effect, Path as EffectPath } from "effect";
import { deriveServerPaths } from "./config";
import { HostSecretsCoordinator } from "./hostSecrets/coordinator";
import { hostSecretsSyncKeyPath } from "./hostSecrets/syncKeyStore";

function requireInboxRecaps(): void {
  if (!isServerBetaFeatureEnabled(ACCOUNT_INBOX_BETA_FEATURE)) {
    throw new WsRpcError({
      message: "Saved Inbox history is unavailable on this host.",
      code: "FEATURE_UNAVAILABLE",
      retryable: false,
    });
  }
}

const SIGNED_OUT: AccountStatus = { state: "signed-out" };

/**
 * How many loopback PKCE attempts may be live at once. Each one holds an open
 * HTTP listener, so the bound is much tighter than the device map's; evicting
 * the oldest closes its listener, costing only an abandoned attempt.
 */
const MAX_TRACKED_SSO_ATTEMPTS = 4;

/**
 * How long the loopback listener waits for the browser to come back. This
 * bounds the HUMAN leg — reading a consent screen, picking a Google account —
 * so it is generous (10 minutes), unlike the per-request grant deadline,
 * which bounds only the server-to-provider exchange call once the code is in
 * hand.
 */
const SSO_CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * How long a sign-in waits for device registration and host linking before
 * answering; they finish in the background after that. Enrollment is two or
 * three account requests (`POST /devices`, host link start and complete),
 * measured at 100-250 ms each and under 900 ms at p95, so it normally ends
 * well inside this and the sign-in answers exactly as before. A stalled
 * request (15 s client timeout each) no longer holds the sign-in past this.
 */
const SIGN_IN_ENROLLMENT_WAIT_MS = 5_000;

/**
 * How long after a sign-in answers the usage reporter is nudged. Its first
 * flush runs synchronous SQLite over the whole local history (hundreds of
 * milliseconds on a large database), so it waits until the sign-in result and
 * the app's follow-up reads are out; the reporter's own debounce is the same.
 */
const SIGN_IN_USAGE_NUDGE_DELAY_MS = 5_000;

/**
 * What a slow provider surfaces when nothing was persisted. Deliberately not
 * "unavailable": the grant may still have completed upstream, so the message
 * must promise neither failure nor a dead code.
 */
const PROVIDER_SLOW_MESSAGE =
  "The identity provider is responding slowly and the sign-in did not finish. It may still complete — if it doesn't, your code should still work; try again.";

/**
 * Whether a sign-in failure says nothing about the credential — a timed-out
 * attempt (408/504), a rate answer (429), or a provider/service fault (5xx).
 * These are the failures after which the grant may have SUCCEEDED upstream,
 * so the caller re-checks persisted status before reporting anything.
 * Classified refusals (wrong code, expired, multi-org) are terminal and pass
 * through untouched.
 */
function isTransientSignInFailure(error: unknown): boolean {
  return (
    error instanceof AccountApiError &&
    (error.status === 408 || error.status === 429 || error.status >= 500)
  );
}

export interface AccountSessionOptions {
  /** Where the credential file lives — the server's Synara home. */
  readonly baseDir: string;
  /**
   * The account service to talk to. Defaults to the configured one, falling
   * back to {@link DEFAULT_ACCOUNT_URL}: a user clicking "sign in" has opted
   * into the hosted service by doing so, which is why this flow takes the
   * default where the CLI refuses to.
   */
  readonly accountUrl?: string | undefined;
  /** Injectable for tests; production builds one per call from `accountUrl`. */
  readonly client?: AccountClient;
  /** Local-shell facts are injectable so enrollment tests do not depend on the runner. */
  readonly platform?: NodeJS.Platform | string;
  readonly hostname?: string;
  readonly appVersion?: string;
  readonly devUrl?: URL;
  /** Overrides {@link SIGN_IN_ENROLLMENT_WAIT_MS}; tests only. */
  readonly signInEnrollmentWaitMs?: number;
}

export interface AccountSession {
  status(): Promise<AccountStatus>;
  billingStatus(): Promise<AccountBillingStatus>;
  billingCheckout(input: AccountBillingCheckoutRequest): Promise<AccountBillingRedirect>;
  billingPortal(): Promise<AccountBillingRedirect>;
  /** Asks the account service to email a 6-digit sign-in code. */
  sendOtp(input: AccountSendOtpInput): Promise<AccountSendOtpResult>;
  /**
   * In-app email OTP sign-in: redeems the emailed 6-digit code, provisioning
   * the account first when the address is new. The code is a credential —
   * never log or persist the input. Success takes the same
   * `establishSession` path as every other sign-in.
   */
  authenticateOtp(input: AccountAuthenticateOtpInput): Promise<AccountStatus>;
  /**
   * Starts the desktop SSO path: authorization code + PKCE with a loopback
   * redirect, deep-linked to the chosen provider. The server owns the
   * loopback listener, the verifier, and the state; the caller only receives
   * the attempt id and the URL to open. Ends in `establishSession` like every
   * other sign-in.
   */
  beginSso(input: AccountBeginSsoInput): Promise<AccountBeginSsoResult>;
  /**
   * Waits for the loopback callback, exchanges the code (through the account
   * service — never the provider directly), and persists the session. The
   * server does the waiting, so a dropped WebSocket cannot lose a sign-in
   * that already succeeded.
   */
  completeSso(input: AccountCompleteSsoInput): Promise<AccountStatus>;
  /** Abandons a pending SSO attempt, closing its loopback listener. */
  cancelSso(input: AccountCompleteSsoInput): Promise<void>;
  updateProfile(input: AccountUpdateProfileInput): Promise<AccountMe>;
  saveInboxRecap(input: AccountSaveInboxRecapInput): Promise<SavedInboxRecap>;
  listInboxRecaps(input: ListSavedInboxRecapsInput): Promise<ListSavedInboxRecapsResponse>;
  deleteInboxRecap(input: SavedInboxRecapIdInput): Promise<void>;
  /**
   * Uploads a profile avatar: decodes the base64 the WS protocol carried and
   * forwards the raw bytes to the account service, which stores the image
   * and switches the avatar source to "uploaded". Answers the refreshed
   * `/me` like every profile write.
   */
  uploadAvatar(input: AccountUploadAvatarInput): Promise<AccountMe>;
  /** Removes the uploaded avatar; the service reverts the source to "sso". */
  deleteAvatar(): Promise<AccountMe>;
  /**
   * The account-wide usage summary — the "Account" side of the usage tab's
   * device/account toggle. Runs against the stored session with the usual
   * transparent refresh.
   */
  usageSummary(input: AccountUsageSummaryInput): Promise<UsageSummary>;
  deleteAccount(input: AccountDeleteInput): Promise<void>;
  signOut(): Promise<void>;
  /**
   * Whether `url` is the authorize URL of an SSO attempt this session
   * started. The RPC handler asks before opening a browser, so this method
   * can never become a general "open any URL for me" primitive.
   */
  isVerificationUrlAllowed(url: string): Promise<boolean>;
}

/** The host-management half of the same machine-owned account session. */
export interface HostsAccountSession {
  listHosts(): Promise<{ readonly hosts: readonly AccountHost[] }>;
  updateHost(input: {
    readonly hostId: string;
    readonly discoverable?: boolean | undefined;
    readonly name?: string | undefined;
  }): Promise<AccountHost>;
  deleteHost(input: { readonly hostId: string }): Promise<void>;
  listDevices(): Promise<{ readonly devices: readonly AccountDevice[] }>;
  revokeDevice(input: { readonly deviceId: string }): Promise<void>;
  revokeDeviceAccountSessions(input: {
    readonly deviceId: string;
  }): Promise<{ confirmed: number; pending: number }>;
  approveDeviceLink(input: { readonly userCode: string }): Promise<void>;
  requestGrant(input: { readonly hostId: string }): Promise<{ readonly grant: string }>;
  enrollment(): Promise<HostsEnrollmentResult>;
  unlinkLocalHost(): Promise<void>;
  beginSyncKeyPairing(): Promise<SyncKeyPairingRequest>;
  offerSyncKey(input: SyncKeyPairingRequest): Promise<SyncKeyPairingCode>;
  receiveSyncKey(): Promise<SyncKeyPairingCode>;
  confirmSyncKey(input: ConfirmSyncKeyPairingRequest): Promise<void>;
  /**
   * What an outbound session to another host is signed with: the signed-in
   * user and this shell's registered device key. The key never leaves the
   * process; callers get a signing handle, not key material.
   */
  dialIdentity(input?: {
    readonly expectedAccount: AccountDeviceRegistrationScope;
    readonly revalidateRegistration?: boolean;
  }): Promise<{
    readonly userId: string;
    readonly accountUrl: string;
    readonly key: CryptoKey;
    readonly publicJwk: import("@synara/contracts").Es256PublicKeyJwk;
    readonly jkt: string;
  }>;
  recoverDeviceRegistration(input: {
    readonly expectedAccount: AccountDeviceRegistrationScope;
    readonly revokedJkt: string;
  }): Promise<RegisteredAccountDeviceIdentity>;
}

/**
 * Whether an error means "there is no usable session" rather than "something
 * went wrong". Both are states the UI renders as signed out, and neither is
 * worth surfacing as a failed RPC: the user's next action is the same either
 * way, and a modal saying "session expired" over a screen that already shows a
 * sign-in button is noise.
 */
function isSignedOut(error: unknown): boolean {
  return error instanceof SessionExpiredError || error instanceof WorkspaceAccessChangedError;
}

/** Resolves when `promise` settles or after `ms`, whichever is first. Never rejects. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(
        () => {},
        () => {},
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createAccountSession(
  options: AccountSessionOptions,
): AccountSession & HostsAccountSession {
  const { baseDir } = options;
  const credentialDir = accountStateDirectory(baseDir, options.devUrl);
  const configuredUrl = options.accountUrl ?? resolveAccountUrl();
  let deviceRegistrationAttempt:
    | {
        readonly sessionKey: string;
        readonly promise: Promise<RegisteredAccountDeviceIdentity>;
      }
    | undefined;
  let hostSecretsCoordinator:
    | { readonly sessionKey: string; readonly value: HostSecretsCoordinator }
    | undefined;
  /** The enrollment running now, joined by status reads for the same user. */
  let enrollmentInFlight: { readonly userId: string; readonly promise: Promise<void> } | undefined;
  /**
   * The enrollment a sign-in started, until it finishes. A sign-in may answer
   * before it does, so host, device and enrollment reads wait for it and never
   * report the pre-enrollment state the app could otherwise cache.
   */
  let signInEnrollment: Promise<void> | undefined;

  /**
   * Loopback PKCE attempts this process has started, keyed by the opaque
   * attempt id handed to the client. The verifier and state never leave an
   * entry; the authorize URL is tracked so the browser-opener allowlist can
   * honour it exactly as it honours device-verification URLs. Bounded like
   * the device map — evicting the oldest closes its listener.
   */
  const pendingSsoAttempts = new Map<
    string,
    {
      readonly listener: SsoCallbackListener;
      readonly authorizeUrl: string;
      readonly codeVerifier: string;
      /**
       * The pair a successful exchange redeemed, cached until persistence for
       * the same reason as the device path: the authorization code is
       * single-use, and a failure between exchange and persistence must
       * recover on retry instead of stranding a spent code.
       */
      redeemedToken?: { accessToken: string; refreshToken: string };
    }
  >();

  function rememberSsoAttempt(
    ssoId: string,
    attempt: {
      listener: SsoCallbackListener;
      authorizeUrl: string;
      codeVerifier: string;
    },
  ): void {
    pendingSsoAttempts.set(ssoId, attempt);
    while (pendingSsoAttempts.size > MAX_TRACKED_SSO_ATTEMPTS) {
      const oldest = pendingSsoAttempts.entries().next();
      if (oldest.done) break;
      oldest.value[1].listener.close();
      pendingSsoAttempts.delete(oldest.value[0]);
    }
  }

  function clientFor(accountUrl: string): AccountClient {
    return options.client ?? createServerAccountClient(accountUrl);
  }

  /**
   * Runs `fn` against the stored session, renewing the access token if needed.
   * Rethrows as-is: callers decide whether an expired session is a state to
   * report or a failure to surface.
   */
  async function withSession<A>(fn: (accessToken: string, client: AccountClient) => Promise<A>) {
    const credentials = await readAccountCredentials(credentialDir);
    if (!credentials) throw new SessionExpiredError();
    const client = clientFor(credentials.accountUrl);
    return withFreshAccessToken({ baseDir: credentialDir, client, credentials }, (accessToken) =>
      fn(accessToken, client),
    );
  }

  // Checkout/portal links belong to one identity. Never return an earlier
  // account's billing result after another renderer changes the session.
  async function withBillingSession<A>(fn: (token: string, client: AccountClient) => Promise<A>) {
    const expected = await readAccountCredentials(credentialDir);
    if (!expected) throw new SessionExpiredError();
    const client = clientFor(expected.accountUrl);
    const assertCurrentAccount = async (accessToken: string) => {
      const current = await readAccountCredentials(credentialDir);
      if (
        !current ||
        current.accountUrl !== expected.accountUrl ||
        current.organizationId !== expected.organizationId ||
        // Legacy files can learn their user during renewal. The access token
        // still has to match the one on disk when no user was captured.
        (expected.userId === undefined
          ? current.accessToken !== accessToken
          : current.userId !== expected.userId)
      ) {
        throw new WorkspaceAccessChangedError();
      }
    };
    const { result, accessToken } = await withFreshAccessToken(
      { baseDir: credentialDir, client, credentials: expected },
      async (token) => {
        await assertCurrentAccount(token);
        return { result: await fn(token, client), accessToken: token };
      },
    );
    await assertCurrentAccount(accessToken);
    return result;
  }

  function deviceRegistrationOptions(accountUrl: string) {
    const platform = toAccountHostPlatform(options.platform ?? process.platform);
    if (!platform) {
      throw new Error(
        `Unsupported device platform: ${String(options.platform ?? process.platform)}`,
      );
    }
    return {
      baseDir,
      accountUrl,
      client: clientFor(accountUrl),
      displayName: (options.hostname ?? OS.hostname()).slice(0, 200),
      platform,
      ...(options.devUrl ? { devUrl: options.devUrl } : {}),
    };
  }

  type ScopedDeviceRegistration = RegisteredAccountDeviceIdentity & {
    readonly account: AccountDeviceRegistrationScope;
  };

  async function ensureShellDevice(
    knownUserId?: string,
    input?: Parameters<HostsAccountSession["dialIdentity"]>[0],
  ): Promise<ScopedDeviceRegistration> {
    const stored = await readAccountCredentials(credentialDir);
    if (!stored) throw new SessionExpiredError();
    const expected = input?.expectedAccount;
    if (
      expected &&
      (stored.accountUrl !== expected.accountUrl ||
        stored.organizationId !== expected.organizationId ||
        stored.userId !== expected.userId)
    ) {
      throw new WorkspaceAccessChangedError();
    }
    let userId = knownUserId ?? stored.userId;
    if (!userId) {
      const client = clientFor(stored.accountUrl);
      const me = await withFreshAccessToken(
        { baseDir: credentialDir, client, credentials: stored },
        (token) => client.me(token),
      );
      if (me.organization.id !== stored.organizationId) throw new WorkspaceAccessChangedError();
      userId = me.id;
    }
    const account = {
      accountUrl: stored.accountUrl,
      organizationId: stored.organizationId,
      userId,
    };
    const sessionKey = `${account.accountUrl}\0${account.organizationId}\0${account.userId}`;
    if (
      !input?.revalidateRegistration &&
      stored.deviceId &&
      stored.deviceJkt &&
      deviceRegistrationAttempt?.sessionKey === sessionKey
    ) {
      const cached = await deviceRegistrationAttempt.promise;
      if (cached.deviceId === stored.deviceId && cached.jkt === stored.deviceJkt)
        return { ...cached, account };
    }

    const promise = ensureAccountDeviceRegistration({
      ...deviceRegistrationOptions(stored.accountUrl),
      expectedAccount: account,
      ...(stored.userId === undefined ? { legacyRefreshToken: stored.refreshToken } : {}),
    });
    deviceRegistrationAttempt = { sessionKey, promise };
    try {
      return { ...(await promise), account };
    } catch (error) {
      if (deviceRegistrationAttempt?.promise === promise) deviceRegistrationAttempt = undefined;
      throw error;
    }
  }

  async function readRegisteredAccount(registration: ScopedDeviceRegistration) {
    const current = await readAccountCredentials(credentialDir);
    if (!current) throw new SessionExpiredError();
    if (
      current.accountUrl !== registration.account.accountUrl ||
      current.organizationId !== registration.account.organizationId ||
      current.userId !== registration.account.userId ||
      current.deviceId !== registration.deviceId ||
      current.deviceJkt !== registration.jkt
    ) {
      throw new WorkspaceAccessChangedError();
    }
    return current;
  }

  async function withRegisteredAccount<A>(
    registration: ScopedDeviceRegistration,
    use: (token: string, client: AccountClient) => Promise<A>,
  ): Promise<A> {
    const credentials = await readRegisteredAccount(registration);
    const client = clientFor(credentials.accountUrl);
    return withFreshAccessToken({ baseDir: credentialDir, client, credentials }, async (token) => {
      await readRegisteredAccount(registration);
      try {
        return await use(token, client);
      } finally {
        await readRegisteredAccount(registration);
      }
    });
  }

  async function currentHostSecretsCoordinator(
    registration: ScopedDeviceRegistration,
  ): Promise<HostSecretsCoordinator> {
    const { account, deviceId, jkt } = registration;
    const sessionKey = JSON.stringify([
      account.accountUrl,
      account.organizationId,
      account.userId,
      deviceId,
      jkt,
    ]);
    if (hostSecretsCoordinator?.sessionKey === sessionKey) return hostSecretsCoordinator.value;

    const { secretsDir } = await Effect.runPromise(
      deriveServerPaths(baseDir, options.devUrl).pipe(Effect.provide(EffectPath.layer)),
    );
    const withDevice = <A>(use: (token: string, client: AccountClient) => Promise<A>) =>
      withRegisteredAccount(registration, use);
    const value = new HostSecretsCoordinator({
      accountUrl: account.accountUrl,
      userId: account.userId,
      deviceId,
      syncKeyFilePath: hostSecretsSyncKeyPath(secretsDir),
      // Keep local key commits serialized with sign-out and account replacement.
      persistForAccount: (write) =>
        withLockedAccountFile(credentialDir, async () => {
          await readRegisteredAccount(registration);
          await write();
        }),
      api: {
        listHosts: () => withDevice((token, client) => client.listHosts(token)),
        listDevices: () => withDevice((token, client) => client.listDevices(token)),
        getHostSecret: (hostId) =>
          withDevice((token, client) => client.getHostSecret(token, hostId)),
        putHostSecret: (hostId, request) =>
          withDevice((token, client) => client.putHostSecret(token, hostId, request)),
        putSyncKeyWrap: (request) =>
          withDevice((token, client) => client.putSyncKeyWrap(token, request)),
        takeSyncKeyWrap: (deviceId) =>
          withDevice((token, client) => client.takeSyncKeyWrap(token, deviceId)),
        revokeDevice: (deviceId) =>
          withDevice((token, client) => client.revokeDevice(token, deviceId)),
      },
    });
    hostSecretsCoordinator = { sessionKey, value };
    return value;
  }

  async function withHostSecretsCoordinator<A>(
    use: (coordinator: HostSecretsCoordinator) => Promise<A>,
  ): Promise<A> {
    requireHostSecretsSync();
    const registration = await ensureShellDevice();
    const coordinator = await currentHostSecretsCoordinator(registration);
    await readRegisteredAccount(registration);
    try {
      return await use(coordinator);
    } finally {
      await readRegisteredAccount(registration);
    }
  }

  /**
   * Enrollment is additive to sign-in: local use survives an account outage.
   * One runs at a time: a status read joins the running one for the same
   * user, and anything else waits for it before starting, so a sign-in
   * finishing in the background never races a status read into two host links.
   */
  function ensureDesktopEnrollment(knownUserId: string, timing?: SignInTiming): Promise<void> {
    const running = enrollmentInFlight;
    if (running && running.userId === knownUserId && !timing) return running.promise;
    const promise = (running?.promise ?? Promise.resolve()).then(() =>
      enrollDesktop(knownUserId, timing),
    );
    const entry = { userId: knownUserId, promise };
    enrollmentInFlight = entry;
    void promise.finally(() => {
      if (enrollmentInFlight === entry) enrollmentInFlight = undefined;
    });
    return promise;
  }

  /** Never rejects: both halves retry on a later status read. */
  async function enrollDesktop(knownUserId: string, timing?: SignInTiming): Promise<void> {
    if (remoteConnectionsUnavailableReason()) return;
    const measure: SignInTiming["measure"] = timing
      ? (step, run) => timing.measure(step, run)
      : (_step, run) => run();
    try {
      await measure("device_registration", () => ensureShellDevice(knownUserId));
    } catch {
      // A later status read retries; the durable user session remains valid.
    }
    try {
      const stored = await readAccountCredentials(credentialDir);
      if (!stored) return;
      await measure("host_link", () =>
        ensureLocalAccountHostLinked({
          accountUrl: stored.accountUrl,
          baseDir,
          client: clientFor(stored.accountUrl),
          ...(options.devUrl ? { devUrl: options.devUrl } : {}),
          ...(options.platform ? { platform: options.platform } : {}),
          ...(options.hostname ? { hostname: options.hostname } : {}),
          ...(options.appVersion ? { appVersion: options.appVersion } : {}),
        }),
      );
    } catch {
      // Host linking has the same retry-on-status semantics as registration.
    }
  }

  async function signedInStatus(me: AccountMe): Promise<AccountStatus> {
    const current = await readAccountCredentials(credentialDir);
    if (!current || current.userId !== me.id || current.organizationId !== me.organization.id)
      return SIGNED_OUT;
    return { state: "signed-in", me, accountAuthority: accountApiIssuer(current.accountUrl) };
  }

  /**
   * Everything that happens after a sign-in produces a token pair, whichever
   * way it was produced: scope it to a workspace, persist it, and report the
   * resulting session.
   *
   * Shared by the OTP and SSO paths deliberately. The two differ only in
   * how they obtain the tokens; if workspace selection or credential
   * persistence ever diverged between them, one of the two would quietly stop
   * matching what the rest of the app expects of a signed-in machine.
   */
  async function establishSession(
    token: { accessToken: string; refreshToken: string },
    context: {
      accountUrl: string;
      client: AccountClient;
      instance: InstanceInfo;
      /** Records each step's duration for the sign-in log line. */
      timing: SignInTiming;
      /**
       * Called the moment the scoped pair is durably on disk — the point after
       * which the sign-in can no longer be lost. The device path uses it to
       * retire its pending authorization: deleting earlier would let a failure
       * between redemption and persistence strand the user with a spent code
       * and nothing stored.
       */
      onPersisted?: () => void;
    },
  ): Promise<AccountStatus> {
    const { accountUrl, client, instance, timing } = context;

    // V1 is personal-org-only and this flow has no picker, so more than one
    // workspace FAILS CLOSED — see selectOrganization.
    const scoped = await scopeTokenToWorkspace(token, {
      client,
      chooseOrganization: selectOrganization,
      measure: (step, run) => timing.measure(step, run),
    });

    // Expiry may remove the workspace, but it retains the host's owner.
    // Recover only that owner's link; another member of the same workspace
    // must enroll a fresh host identity instead of inheriting its authority.
    await timing.measure("credentials", () =>
      withLockedAccountFile(credentialDir, async () => {
        const previous = await readAccountFile(credentialDir);
        const sameAccountAndWorkspace =
          previous?.accountUrl === accountUrl &&
          previous.hostOwnerUserId === scoped.userId &&
          (previous.organizationId === scoped.organizationId ||
            (previous?.organizationId === undefined && previous?.hostId !== undefined));
        await writeAccountCredentials(credentialDir, {
          accountUrl,
          workosClientId: instance.clientId,
          workosApiUrl: instance.workosApiUrl,
          organizationId: scoped.organizationId,
          userId: scoped.userId,
          accessToken: scoped.accessToken,
          refreshToken: scoped.refreshToken,
          ...(sameAccountAndWorkspace && previous?.hostId ? { hostId: previous.hostId } : {}),
          ...(sameAccountAndWorkspace && previous?.hostOwnerUserId
            ? { hostOwnerUserId: previous.hostOwnerUserId }
            : {}),
          ...(sameAccountAndWorkspace && previous?.hostKeyGeneration !== undefined
            ? { hostKeyGeneration: previous.hostKeyGeneration }
            : {}),
          ...(sameAccountAndWorkspace && previous?.discoverabilityAcknowledgedByHostId
            ? {
                discoverabilityAcknowledgedByHostId: previous.discoverabilityAcknowledgedByHostId,
              }
            : {}),
        });
        if (previous && !sameAccountAndWorkspace) {
          const { hostIdentityPath } = await Effect.runPromise(
            deriveServerPaths(baseDir, options.devUrl).pipe(Effect.provide(EffectPath.layer)),
          );
          await deleteHostIdentity(hostIdentityPath);
        }
      }),
    );

    // The durable checkpoint: the scoped pair is on disk, so everything after
    // this line — the status `/me` below included — can fail without losing
    // the sign-in; `status()` recovers it from the file.
    context.onPersisted?.();

    // Enrollment and the final `/me` are independent once the pair is on
    // disk, so they run together. Enrollment gets a bounded wait and then
    // finishes in the background; its failures were always swallowed and
    // retried on the next status read.
    const enrollment = ensureDesktopEnrollment(scoped.userId, timing);
    timing.waitFor(enrollment);
    const tracked: Promise<void> = enrollment.then(
      () => {
        if (signInEnrollment === tracked) signInEnrollment = undefined;
      },
      () => {
        if (signInEnrollment === tracked) signInEnrollment = undefined;
      },
    );
    signInEnrollment = tracked;

    try {
      // Not redundant on the common path: scoping's probe `/me` ran against the
      // org-less token and was refused, so this is the first `/me` the scoped
      // token answers (and it runs through withSession's renewal). Only the
      // pre-scoped self-hoster path pays a second call.
      const [me] = await Promise.all([
        timing.measure("final_me", () => withSession((accessToken, c) => c.me(accessToken))),
        settleWithin(enrollment, options.signInEnrollmentWaitMs ?? SIGN_IN_ENROLLMENT_WAIT_MS),
      ]);
      return await signedInStatus(me);
    } finally {
      // A fresh session means the machine's EXISTING local history can sync:
      // the reporter's first flush has no watermark and backfills everything.
      // Deferred so its synchronous SQLite cannot delay this sign-in's answer.
      setTimeout(nudgeAccountUsageReporter, SIGN_IN_USAGE_NUDGE_DELAY_MS).unref?.();
    }
  }

  /** Waits for a sign-in's background enrollment, if one is still running. */
  async function afterSignInEnrollment(): Promise<void> {
    await signInEnrollment;
  }

  /** The `status()` body, callable from inside the session's own methods. */
  async function readStatus(): Promise<AccountStatus> {
    // Cheap and common: no credential file means signed out without a single
    // network call, which is the state every cold start begins in.
    const credentials = await readAccountCredentials(credentialDir);
    if (!credentials) return SIGNED_OUT;

    try {
      const me = await withSession(async (token, client) => {
        const verified = await client.me(token);
        // A concurrent refresh may rotate the token while /me is in flight.
        // An already verified identity stays signed in; legacy files may only
        // acquire an identity from the exact token that produced this response.
        await withLockedAccountFile(credentialDir, async () => {
          const current = await readAccountCredentials(credentialDir);
          const changed = !current
            ? "session"
            : current.accountUrl !== credentials.accountUrl
              ? "accountUrl"
              : current.organizationId !== verified.organization.id
                ? "organizationId"
                : current.userId
                  ? current.userId !== verified.id && "userId"
                  : current.accessToken !== token && "accessToken";
          if (!current || changed) {
            logAccountSession(credentialDir, "identity_fence", {
              fence: "status_verified_identity",
              field: changed || "session",
            });
            throw new SessionExpiredError();
          }
          if (!current.userId)
            await writeAccountCredentials(credentialDir, { ...current, userId: verified.id });
        });
        return verified;
      });
      await ensureDesktopEnrollment(me.id);
      return await signedInStatus(me);
    } catch (error) {
      if (isSignedOut(error)) return SIGNED_OUT;
      // A rejected token that survived the refresh attempt is a dead session
      // too — but an unreachable account is not, and reporting it as signed
      // out would make a network blip look like being logged out.
      if (
        error instanceof AccountApiError &&
        error.status === 401 &&
        error.code === "unauthorized"
      ) {
        logAccountSession(credentialDir, "status_unauthorized", {
          status: error.status,
          code: error.code,
        });
        return SIGNED_OUT;
      }
      throw error;
    }
  }

  /**
   * Runs a sign-in to completion, never reporting failure for an operation
   * that may have succeeded. A TRANSIENT failure (timeout, rate answer,
   * provider/service fault) after a grant call proves nothing about the
   * outcome: the provider may have completed the grant after an abort, and
   * `establishSession` may already have persisted the pair (the post-persist
   * `/me` is the classic case). So the persisted state is re-checked first,
   * and only when nothing landed on disk does the caller get an error — a
   * retryable one saying the provider was slow and the credential may still
   * be good, never a flat "unavailable" for a sign-in that might have
   * worked. Classified terminal refusals (wrong code, expired, multi-org)
   * pass through untouched.
   */
  async function signInWithRecovery(perform: () => Promise<AccountStatus>): Promise<AccountStatus> {
    try {
      return await perform();
    } catch (error) {
      if (!isTransientSignInFailure(error)) throw error;
      try {
        const recovered = await readStatus();
        if (recovered.state === "signed-in") return recovered;
      } catch {
        // The re-check itself failing changes nothing: fall through to the
        // honest retryable answer below.
      }
      throw new AccountApiError({
        code: "internal_error",
        // The original transient status survives so every retryable
        // classification downstream still recognizes it.
        status: (error as AccountApiError).status,
        message: PROVIDER_SLOW_MESSAGE,
      });
    }
  }

  return {
    status: readStatus,

    /**
     * The desktop SSO start: loopback listener first (its port names the
     * redirect URI), then the account service builds the provider's authorize
     * URL around it. Nothing is consumed yet; a failure here costs only the
     * listener, which is closed on the way out.
     */
    async beginSso(input) {
      const client = clientFor(configuredUrl);
      const pkce = createPkcePair();
      const state = createSsoState();
      const listener = await startSsoCallbackListener({
        state,
        timeoutMs: SSO_CALLBACK_TIMEOUT_MS,
      });

      let authorizeUrl: string;
      try {
        authorizeUrl = (
          await client.requestAuthorizeUrl({
            provider: input.provider,
            redirectUri: listener.redirectUri,
            codeChallenge: pkce.codeChallenge,
            state,
          })
        ).authorizeUrl;
      } catch (error) {
        listener.close();
        throw error;
      }

      const ssoId = randomUUID();
      rememberSsoAttempt(ssoId, { listener, authorizeUrl, codeVerifier: pkce.codeVerifier });
      return { ssoId, authorizeUrl };
    },

    /**
     * Waits for the browser to deliver the code, exchanges it through the
     * account service, and persists the session. The server does the waiting
     * — not the browser — so a dropped WebSocket cannot lose a sign-in that
     * already succeeded: the credentials are on disk before this returns,
     * and a reconnecting client recovers the result from `status()`.
     */
    completeSso(input) {
      const timing = createSignInTiming(credentialDir, "sso");
      const result = signInWithRecovery(async () => {
        const pending = pendingSsoAttempts.get(input.ssoId);
        if (!pending) {
          throw new Error("This sign-in attempt has expired. Start a new one.");
        }

        const accountUrl = configuredUrl;
        const client = clientFor(accountUrl);
        // Instance before anything can consume the code, as on every path.
        const instance = await timing.measure("instance", () => client.instance());

        // Resumable: a previous attempt may have exchanged the single-use
        // code and failed before persistence; the cached pair makes a retry
        // of this RPC recover the sign-in instead of stranding a spent code.
        let token = pending.redeemedToken;
        if (!token) {
          const code = await timing.measure("browser", () => pending.listener.waitForCode());
          try {
            token = await timing.measure("code_exchange", () =>
              client.exchangeAuthorizeCode({ code, codeVerifier: pending.codeVerifier }),
            );
          } catch (error) {
            // A classified terminal refusal means the code is dead and the
            // attempt can never complete — drop it and its listener now.
            if (error instanceof AccountApiError && error.status === 401) {
              pending.listener.close();
              pendingSsoAttempts.delete(input.ssoId);
            }
            throw error;
          }
        }
        pending.redeemedToken = token;

        return establishSession(token, {
          accountUrl,
          client,
          instance,
          timing,
          // Retired at the durable checkpoint, exactly like the device entry.
          // Retired only once the scoped pair is durably on disk: deleting
          // earlier would turn a failure between exchange and persistence
          // into a spent code with no session and no way to retry.
          onPersisted: () => {
            pending.listener.close();
            pendingSsoAttempts.delete(input.ssoId);
          },
        });
      });
      return timing.settle(result);
    },

    /**
     * User-initiated abandonment: closes the listener so the port is freed
     * and a late browser callback lands on nothing. A redeemed-but-not-yet-
     * persisted pair is deliberately discarded with the entry — the user
     * asked out, and no session may appear after that.
     */
    async cancelSso(input) {
      const pending = pendingSsoAttempts.get(input.ssoId);
      if (!pending) return;
      pending.listener.close();
      pendingSsoAttempts.delete(input.ssoId);
    },

    /**
     * Thin pass-through: WorkOS creates and emails the code, and the account
     * service already reduced its answer to the address echo and expiry —
     * there is nothing to interpret here.
     */
    async sendOtp(input) {
      const client = clientFor(configuredUrl);
      return client.sendOtp(input);
    },

    /**
     * In-app email OTP sign-in. The emailed code is forwarded to the account
     * service, which proxies it to WorkOS, and is referenced nowhere after
     * this call returns — not in the credential file, not in a log, not in a
     * retry. What is persisted is the resulting token pair, exactly as for SSO.
     */
    authenticateOtp(input) {
      const timing = createSignInTiming(credentialDir, "otp");
      const result = signInWithRecovery(async () => {
        const accountUrl = configuredUrl;
        const client = clientFor(accountUrl);
        // Sequenced, not raced: the instance metadata is non-secret and does
        // not depend on the grant, so it is fetched BEFORE the code is spent.
        // In a Promise.all an /instance failure would discard a successful
        // redemption — the user's single-use code, gone with nothing stored.
        const instance = await timing.measure("instance", () => client.instance());
        const token = await timing.measure("code_exchange", () => client.authenticateOtp(input));
        return establishSession(token, { accountUrl, client, instance, timing });
      });
      return timing.settle(result);
    },

    /**
     * Writes the profile, then renames the workspace when it differs.
     *
     * The profile goes FIRST because it is where the user-recoverable
     * conflict surfaces: `handle_taken` must leave everything unchanged, and
     * renaming first would make a handle conflict a permanent partial rename
     * (the org renamed, the dialog still open asking for another handle).
     * With the rename second, a handle conflict changes nothing; a rename
     * failure after a saved profile costs only re-submitting the same form,
     * which upserts the identical profile and retries the rename. The rename
     * answers with the same `/me` body, so whichever call ran last provides
     * the current answer.
     */
    saveInboxRecap(input) {
      requireInboxRecaps();
      return withSession(async (token, client) => {
        const me = await client.me(token);
        if (me.id !== input.expectedUserId || me.organization.id !== input.expectedOrganizationId) {
          throw new WsRpcError({
            message: "Your account changed. Reload the recap before saving it.",
            code: "INVALID_INPUT",
          });
        }
        return client.saveInboxRecap(token, input.request);
      });
    },
    listInboxRecaps(input) {
      requireInboxRecaps();
      return withSession((token, client) => client.listInboxRecaps(token, input));
    },
    deleteInboxRecap(input) {
      requireInboxRecaps();
      return withSession((token, client) => client.deleteInboxRecap(token, input.id));
    },

    async updateProfile(input) {
      requireAccountProfileSync();
      const { workspaceName, ...profile } = input;
      return withSession(async (token, client) => {
        const written = await client.updateProfile(token, profile);
        if (workspaceName !== undefined && written.organization.name !== workspaceName) {
          return client.updateOrganization(token, { name: workspaceName });
        }
        return written;
      });
    },

    async uploadAvatar(input) {
      requireAccountProfileSync();
      // Base64 → bytes here, not in the shared client: the wire format is a
      // WS-protocol concern, and the client's contract is plain bytes.
      const bytes = Uint8Array.from(Buffer.from(input.bytes, "base64"));
      return withSession((token, client) => client.uploadAvatar(token, bytes, input.contentType));
    },

    async deleteAvatar() {
      requireAccountProfileSync();
      return withSession((token, client) => client.deleteAvatar(token));
    },

    async usageSummary(input) {
      requireAccountProfileSync();
      return withSession((token, client) => client.getUsageSummary(token, input.utcOffsetMinutes));
    },

    async billingStatus() {
      const status = await withBillingSession((token, client) => client.billingStatus(token));
      // A host refused for lack of access may retry its own authorization now.
      if (status.access === "granted") noteRemoteAccessGranted();
      return status;
    },
    billingCheckout(input) {
      return withBillingSession((token, client) => client.billingCheckout(token, input));
    },
    billingPortal() {
      return withBillingSession((token, client) => client.billingPortal(token));
    },

    async listHosts() {
      await afterSignInEnrollment();
      return withSession((token, client) => client.listHosts(token));
    },

    async updateHost(input) {
      const { hostId, ...update } = input;
      const host = await withSession((token, client) => client.updateHost(token, hostId, update));
      if (input.discoverable !== undefined) {
        await withLockedAccountFile(credentialDir, async () => {
          const stored = await readAccountFile(credentialDir);
          if (!stored) return;
          // Local persistence is intentionally keyed per host. A future slice
          // may move this answer to the account service so a second owner
          // device does not re-ask; until then it must survive local restarts.
          await writeAccountCredentials(credentialDir, {
            ...stored,
            discoverabilityAcknowledgedByHostId: {
              ...stored.discoverabilityAcknowledgedByHostId,
              [hostId]: true,
            },
          });
        });
      }
      return host;
    },

    deleteHost(input) {
      return withSession((token, client) => client.deleteHost(token, input.hostId));
    },

    async listDevices() {
      await afterSignInEnrollment();
      return withSession((token, client) => client.listDevices(token));
    },

    revokeDeviceAccountSessions(input) {
      return withSession((token, client) =>
        client.revokeDeviceAccountSessions(token, input.deviceId),
      );
    },

    async revokeDevice(input) {
      await withSession((token, client) => client.revokeDevice(token, input.deviceId));
      // An idle host would otherwise apply and confirm this on its slow poll.
      nudgeHostAuthorization();
      await withLockedAccountFile(credentialDir, async () => {
        const stored = await readAccountFile(credentialDir);
        if (!stored || stored.deviceId !== input.deviceId) return;
        const { deviceId: _deviceId, deviceJkt: _deviceJkt, ...remaining } = stored;
        await writeAccountCredentials(credentialDir, remaining);
        deviceRegistrationAttempt = undefined;
      });
    },

    approveDeviceLink(input) {
      return withSession((token, client) => client.approveDeviceHostLink(token, input));
    },

    async requestGrant(input) {
      const registration = await ensureShellDevice();
      return withRegisteredAccount(registration, (token, client) =>
        client.requestGrant(token, input.hostId, registration.jkt),
      );
    },

    async enrollment() {
      await afterSignInEnrollment();
      const stored = await readAccountFile(credentialDir);
      const { hosts, organizationMemberCount } = await withSession(async (token, client) => {
        const [listed, memberCount] = await Promise.all([
          client.listHosts(token),
          client.countOrganizationMembers(token).catch(() => null),
        ]);
        return { hosts: listed.hosts, organizationMemberCount: memberCount };
      });
      const host = stored?.hostId
        ? (hosts.find((candidate) => candidate.id === stored.hostId) ?? null)
        : null;
      return {
        host,
        organizationMemberCount,
        discoverabilityAcknowledged:
          (stored?.hostId !== undefined &&
            stored.discoverabilityAcknowledgedByHostId?.[stored.hostId] === true) ||
          false,
      };
    },

    unlinkLocalHost() {
      return unlinkLocalAccountHost({
        baseDir,
        devUrl: options.devUrl,
        ...(options.client ? { client: options.client } : {}),
      });
    },

    async beginSyncKeyPairing() {
      return withHostSecretsCoordinator((coordinator) => coordinator.beginPairing());
    },

    async offerSyncKey(input) {
      return withHostSecretsCoordinator((coordinator) => coordinator.offerSyncKey(input));
    },

    async receiveSyncKey() {
      return withHostSecretsCoordinator((coordinator) => coordinator.receiveSyncKey());
    },

    async dialIdentity(input) {
      const registration = await ensureShellDevice(undefined, input);
      const { secretsDir } = await Effect.runPromise(
        deriveServerPaths(baseDir, options.devUrl).pipe(Effect.provide(EffectPath.layer)),
      );
      const identity = await loadOrCreateDeviceIdentity(deviceIdentityPath(secretsDir));
      if (identity.jkt !== registration.jkt) {
        throw new Error("This shell's device key does not match its registered device");
      }
      await readRegisteredAccount(registration);
      return {
        userId: registration.account.userId,
        accountUrl: registration.account.accountUrl,
        key: identity.key,
        publicJwk: identity.publicJwk,
        jkt: identity.jkt,
      };
    },

    async recoverDeviceRegistration({ expectedAccount, revokedJkt }) {
      deviceRegistrationAttempt = undefined;
      hostSecretsCoordinator = undefined;
      try {
        return await recoverAccountDeviceRegistration(
          { ...deviceRegistrationOptions(expectedAccount.accountUrl), expectedAccount },
          revokedJkt,
        );
      } finally {
        deviceRegistrationAttempt = undefined;
        hostSecretsCoordinator = undefined;
      }
    },

    async confirmSyncKey(input) {
      return withHostSecretsCoordinator((coordinator) => coordinator.confirmSyncKey(input));
    },

    // Pin irreversible erasure to the authority and user the caller confirmed.
    async deleteAccount(input) {
      const expected = await readAccountCredentials(credentialDir);
      if (
        !expected ||
        expected.userId !== input.userId ||
        accountApiIssuer(expected.accountUrl) !== input.accountAuthority
      )
        throw new WorkspaceAccessChangedError();
      const client = clientFor(expected.accountUrl);
      await withFreshAccessToken(
        { baseDir: credentialDir, client, expectedIdentity: expected },
        (token) =>
          client.deleteAccount(token, { confirmation: input.confirmation, email: input.email }),
      );
      // Erasure already revoked every cloud host. Only clear this matching local
      // identity, under the same lock used by login/refresh; never a replacement account.
      await withLockedAccountFile(credentialDir, async () => {
        const current = await readAccountFile(credentialDir);
        if (
          !current ||
          current.accountUrl !== expected.accountUrl ||
          current.userId !== expected.userId
        )
          return;
        await deleteAccountCredentials(credentialDir);
        const { hostIdentityPath } = await Effect.runPromise(
          deriveServerPaths(baseDir, options.devUrl).pipe(Effect.provide(EffectPath.layer)),
        );
        await deleteHostIdentity(hostIdentityPath);
        deviceRegistrationAttempt = undefined;
        hostSecretsCoordinator = undefined;
      });
    },

    async signOut() {
      await runAuthLogout({
        baseDir,
        devUrl: options.devUrl,
        ...(options.client ? { client: options.client } : {}),
        stdout: () => {},
      });
      deviceRegistrationAttempt = undefined;
      hostSecretsCoordinator = undefined;
    },

    isVerificationUrlAllowed(url) {
      // Allowed only if this server issued it. An allowlist of hosts would be
      // the obvious alternative, but the authorize page lives on whatever
      // domain the identity provider chose — a hosted AuthKit domain, a custom
      // one, a self-hoster's stand-in — so any host list would be either wrong
      // for someone or wide enough to be no check at all. What is *not*
      // ambiguous is whether this URL came out of a sign-in attempt this
      // process just started.
      for (const attempt of pendingSsoAttempts.values()) {
        if (attempt.authorizeUrl === url) return Promise.resolve(true);
      }
      return Promise.resolve(false);
    },
  };
}
