import type { AccountDevicePlatform } from "@synara/contracts";
import { AccountApiError, type AccountClient } from "@synara/shared/account";
import { signDeviceRegistration } from "@synara/shared/deviceKey";
import { Effect, Path as EffectPath } from "effect";

import {
  accountApiIssuer,
  accountStateDirectory,
  readAccountCredentials,
  SessionExpiredError,
  withFreshAccessToken,
  withLockedAccountFile,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth";
import { deriveServerPaths } from "./config";
import { reportReliabilityIssue } from "./reliability";
import { deviceIdentityPath, type DeviceIdentity, withDeviceIdentityFile } from "./deviceIdentity";

export interface AccountDeviceRegistrationScope {
  readonly accountUrl: string;
  readonly organizationId: string;
  readonly userId: string;
}

export interface EnsureAccountDeviceRegistrationOptions {
  readonly baseDir: string;
  readonly accountUrl: string;
  readonly client: AccountClient;
  readonly displayName: string;
  readonly platform: AccountDevicePlatform;
  readonly devUrl?: URL;
  /** Supplied by a fresh `/me` read when upgrading a file that predates userId. */
  readonly userId?: string;
  readonly expectedAccount?: AccountDeviceRegistrationScope;
  /** A legacy account file may only be identified by the credential that produced its /me. */
  readonly legacyRefreshToken?: string;
}

export interface RegisteredAccountDeviceIdentity {
  readonly deviceId: string;
  readonly jkt: string;
}

export class AccountDeviceKeyRevokedError extends AccountApiError {
  constructor(
    readonly jkt: string,
    cause: AccountApiError,
  ) {
    super(cause);
  }
}

function isRevokedDeviceKey(error: unknown): error is AccountApiError {
  return (
    error instanceof AccountApiError &&
    error.status === 403 &&
    error.code === "device_not_registered"
  );
}

const runWithPath = <A, E>(effect: Effect.Effect<A, E, EffectPath.Path>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(EffectPath.layer)));

/**
 * Registers the durable shell key with the active user session.
 *
 * POST /devices is intentionally called on every cold-launch enrollment:
 * the account service upserts an active (user,jkt) row, while a revoked row
 * refuses re-enrollment of that same machine-retained key.
 */
export async function ensureAccountDeviceRegistration(
  options: EnsureAccountDeviceRegistrationOptions,
): Promise<RegisteredAccountDeviceIdentity> {
  return registerAccountDevice(options);
}

export async function recoverAccountDeviceRegistration(
  options: EnsureAccountDeviceRegistrationOptions & {
    expectedAccount: AccountDeviceRegistrationScope;
  },
  revokedJkt: string,
): Promise<RegisteredAccountDeviceIdentity> {
  return registerAccountDevice(options, revokedJkt);
}

async function registerAccountDevice(
  options: EnsureAccountDeviceRegistrationOptions,
  revokedJkt?: string,
): Promise<RegisteredAccountDeviceIdentity> {
  const credentialDir = accountStateDirectory(options.baseDir, options.devUrl);
  const { secretsDir } = await runWithPath(deriveServerPaths(options.baseDir, options.devUrl));
  return withDeviceIdentityFile(deviceIdentityPath(secretsDir), async (file) => {
    const stored = await readAccountCredentials(credentialDir);
    if (!stored) throw new SessionExpiredError();
    const userId = options.expectedAccount?.userId ?? options.userId ?? stored.userId;
    if (!userId) throw new Error("The signed-in account is missing its user id");
    const organizationId = options.expectedAccount?.organizationId ?? stored.organizationId;
    const expectedUrl = options.expectedAccount?.accountUrl ?? options.accountUrl;
    const legacyRefreshToken = options.expectedAccount
      ? options.legacyRefreshToken
      : stored.refreshToken;
    const readCurrentAccount = async () => {
      const current = await readAccountCredentials(credentialDir);
      if (!current) throw new SessionExpiredError();
      if (
        current.accountUrl !== expectedUrl ||
        current.accountUrl !== options.accountUrl ||
        current.organizationId !== organizationId ||
        (current.userId !== userId &&
          (current.userId !== undefined || current.refreshToken !== legacyRefreshToken))
      ) {
        throw new WorkspaceAccessChangedError();
      }
      return current;
    };

    const register = async (identity: DeviceIdentity): Promise<RegisteredAccountDeviceIdentity> => {
      const credentials = await readCurrentAccount();
      const response = await withFreshAccessToken(
        {
          baseDir: credentialDir,
          client: options.client,
          credentials,
        },
        async (accessToken) => {
          const proof = await signDeviceRegistration({
            key: identity.key,
            publicJwk: identity.publicJwk,
            userId,
            displayName: options.displayName,
            platform: options.platform,
            audience: accountApiIssuer(options.accountUrl),
          });
          await readCurrentAccount();
          return options.client.registerDevice(accessToken, proof);
        },
      );
      if (response.device.jkt !== identity.jkt || response.device.revokedAt !== null) {
        throw new Error("The account did not register this shell's device key");
      }
      return { deviceId: response.device.id, jkt: identity.jkt };
    };

    await readCurrentAccount();
    let identity = await file.read();
    if (revokedJkt !== undefined) {
      if (identity?.jkt !== revokedJkt) throw new Error("The shell's device key changed");
      // Re-check the revocation with the account service using proof of the
      // retained key. Network errors and expired sessions cannot authorize rotation.
      const revoked = await register(identity).then(
        () => false,
        (error: unknown) => {
          if (isRevokedDeviceKey(error)) return true;
          throw error;
        },
      );
      if (!revoked) throw new Error("The shell's device key is still registered");

      // This lock is nested only inside the device lock. No remote call runs
      // under it. Persist the new key before enrollment so an interrupted
      // recovery can retry that same key without restoring the revoked key.
      identity = await withLockedAccountFile(credentialDir, async () => {
        const current = await readCurrentAccount();
        const { deviceId, deviceJkt, ...account } = current;
        if (deviceId !== undefined || deviceJkt !== undefined) {
          await writeAccountCredentials(credentialDir, account);
        }
        return file.writeNew();
      });
    }
    const registeredIdentity = identity ?? (await file.writeNew());
    const registration = await register(registeredIdentity).catch((error: unknown) => {
      if (isRevokedDeviceKey(error)) {
        reportReliabilityIssue("remote.device_revoked");
        throw new AccountDeviceKeyRevokedError(registeredIdentity.jkt, error);
      }
      throw error;
    });
    await withLockedAccountFile(credentialDir, async () => {
      const current = await readCurrentAccount();
      await writeAccountCredentials(credentialDir, {
        ...current,
        userId,
        deviceId: registration.deviceId,
        deviceJkt: registration.jkt,
      });
    });
    return registration;
  });
}
