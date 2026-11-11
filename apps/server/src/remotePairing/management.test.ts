import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { generateKeyPair, exportJWK, calculateJwkThumbprint } from "jose";
import { beforeEach, expect, it, vi } from "vitest";
import { EnvironmentId, type RemotePairingBundle } from "@synara/contracts";
import { AccountApiError } from "@synara/shared/account";
import { AccountDeviceKeyRevokedError } from "../accountDeviceRegistration";
import {
  initializeRemoteTlsIdentity,
  remoteTlsIdentityPath,
} from "../remoteTransport/certificates";
import type { pairRemoteHost } from "./client";
import { makeRemoteAccessManagement, type RemoteAccessManagementOptions } from "./management";

const mocks = vi.hoisted(() => ({
  readAccount: vi.fn(),
  redeem: vi.fn(),
  pair: vi.fn(),
}));
vi.mock("../accountAuth", async (original) => ({
  ...(await original<typeof import("../accountAuth")>()),
  readAccountFile: mocks.readAccount,
  withFreshAccessToken: (_options: unknown, action: (token: string) => unknown) => action("token"),
}));
vi.mock("@synara/shared/account", async (original) => ({
  ...(await original<typeof import("@synara/shared/account")>()),
  createAccountClient: () => ({ redeemRemotePairingCode: mocks.redeem }),
}));
vi.mock("../remoteFeaturePolicy", () => ({ requireRemoteConnections: () => {} }));
vi.mock("./client", () => ({ pairRemoteHost: mocks.pair }));

beforeEach(() => vi.resetAllMocks());

async function harness() {
  const key = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(key.publicKey);
  const jkt = await calculateJwkThumbprint(publicJwk);
  let revoked = false;
  const account = {
    accountUrl: "https://account.example.test",
    userId: "owner",
    organizationId: "org",
  };
  mocks.readAccount.mockResolvedValue(account);
  const bundle = {
    v: 2,
    accountAuthority: `${account.accountUrl}/api/v1`,
    userId: account.userId,
    organizationId: account.organizationId,
    environmentId: EnvironmentId.makeUnsafe("remote-environment"),
    hostId: "remote-host",
    label: "Mac Mini",
    channel: "dev",
    rootCertificate: "test-root",
    rootFingerprint: "a".repeat(64),
    inviteId: randomUUID(),
    secret: "s".repeat(43),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  } satisfies RemotePairingBundle;
  mocks.redeem.mockImplementation(async () => ({ ...bundle }));
  const hosts = {
    importInvitation: vi.fn(() => Effect.void),
    confirm: vi.fn(() => Effect.succeed(true)),
    get: vi.fn(() => Effect.succeed(undefined)),
    forget: vi.fn(() => Effect.void),
  };
  const listHosts = vi.fn(async () => ({
    hosts: [{ id: bundle.hostId, environmentId: bundle.environmentId }],
  }));
  const recoverDeviceRegistration = vi.fn(async () => ({
    deviceId: randomUUID(),
    jkt: "replacement-device",
  }));
  const closeAll = vi.fn();
  const manage = makeRemoteAccessManagement({
    config: { baseDir: "/unused", stateDir: "/unused" },
    environment: {
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.makeUnsafe("controller"),
        label: "MacBook",
      }),
    },
    hosts,
    account: {
      listHosts,
      dialIdentity: async () => {
        if (revoked) {
          throw new AccountDeviceKeyRevokedError(
            jkt,
            new AccountApiError({
              status: 403,
              code: "device_not_registered",
              message: "This device key was revoked.",
            }),
          );
        }
        return { key: key.privateKey, publicJwk, jkt, userId: account.userId };
      },
      recoverDeviceRegistration,
    },
    connections: { remove: vi.fn(), closeAll },
  } as unknown as RemoteAccessManagementOptions);
  const signal = new AbortController().signal;
  const redeem = () => manage({ operation: "redeem-code", code: "ABCD-2345" }, signal);
  const confirm = (fingerprint = bundle.rootFingerprint) =>
    manage(
      { operation: "confirm-code", inviteId: bundle.inviteId, rootFingerprint: fingerprint },
      signal,
    );
  const forget = () =>
    manage({ operation: "forget-host", environmentId: bundle.environmentId }, signal);
  return {
    bundle,
    account,
    hosts,
    listHosts,
    redeem,
    confirm,
    forget,
    jkt,
    closeAll,
    recoverDeviceRegistration,
    revoke: () => {
      revoked = true;
    },
    deviceInfo: () => manage({ operation: "device-info" }, signal),
    recover: (recoveryId: string) =>
      manage({ operation: "re-register-device", recoveryId }, signal),
  };
}

it("retries a redeemed code after a temporary directory or connection failure, consuming it only on success", async () => {
  const h = await harness();
  const preview = await h.redeem();
  expect(preview).toMatchObject({ deviceJkt: h.jkt });
  expect(preview).not.toHaveProperty("secret");
  h.listHosts.mockRejectedValueOnce(new Error("Account API temporarily unavailable"));
  await expect(h.confirm()).rejects.toThrow("temporarily unavailable");
  mocks.pair.mockRejectedValueOnce(new Error("Tunnel temporarily unavailable"));
  await expect(h.confirm()).rejects.toThrow("Tunnel temporarily unavailable");
  await expect(h.confirm()).resolves.toMatchObject({ kind: "paired" });
  expect(h.hosts.confirm).toHaveBeenCalledTimes(1);
  await expect(h.confirm()).rejects.toThrow("fresh pairing code");
});

it("discards cancelled previews so repeated cancellation does not exhaust the pending limit", async () => {
  const h = await harness();
  for (let index = 0; index < 9; index++) {
    h.bundle.inviteId = randomUUID();
    await h.redeem();
    await h.forget();
    await expect(h.confirm()).rejects.toThrow("fresh pairing code");
  }
  expect(mocks.pair).not.toHaveBeenCalled();
});

it("keeps fingerprint verification and account/expiry fences on retry", async () => {
  const h = await harness();
  await h.redeem();
  await expect(h.confirm("b".repeat(64))).rejects.toThrow("fresh pairing code");
  expect(mocks.pair).not.toHaveBeenCalled();
  mocks.readAccount.mockResolvedValueOnce({ ...h.account, userId: "other" });
  await expect(h.confirm()).rejects.toThrow("fresh pairing code");
  h.bundle.expiresAt = new Date(Date.now() - 1).toISOString();
  await h.redeem();
  await expect(h.confirm()).rejects.toThrow("fresh pairing code");
  expect(mocks.pair).not.toHaveBeenCalled();
});

it("serializes pairing before async setup and waits for cancellation before forgetting trust", async () => {
  const h = await harness();
  await h.redeem();
  const directory = Promise.withResolvers<Awaited<ReturnType<typeof h.listHosts>>>();
  const handshake = Promise.withResolvers<AbortSignal>();
  const handshakeSettled = Promise.withResolvers<void>();
  h.listHosts.mockImplementationOnce(() => directory.promise);
  mocks.pair.mockImplementationOnce(({ signal }: Parameters<typeof pairRemoteHost>[0]) => {
    if (!signal) throw new Error("Pairing did not receive a cancellation signal");
    handshake.resolve(signal);
    return handshakeSettled.promise;
  });
  const first = h.confirm().catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.listHosts).toHaveBeenCalledTimes(1));
  await expect(h.confirm()).rejects.toThrow("already in progress");
  expect(h.hosts.importInvitation).toHaveBeenCalledTimes(1);
  directory.resolve({ hosts: [{ id: h.bundle.hostId, environmentId: h.bundle.environmentId }] });
  const signal = await handshake.promise;
  const forgotten = h.forget();
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(h.hosts.forget).not.toHaveBeenCalled();
  handshakeSettled.resolve();
  await forgotten;
  expect(await first).toBe(signal.reason);
  expect(h.hosts.confirm).not.toHaveBeenCalled();
  expect(h.hosts.forget).toHaveBeenCalledTimes(1);
});

it("accepts one confirmed recovery and cancels any pairing tied to the revoked key", async () => {
  const h = await harness();
  await h.redeem();
  const directory = Promise.withResolvers<Awaited<ReturnType<typeof h.listHosts>>>();
  h.listHosts.mockImplementationOnce(() => directory.promise);
  const pairing = h.confirm().catch((error: unknown) => error);
  await vi.waitFor(() => expect(h.listHosts).toHaveBeenCalledTimes(1));

  h.revoke();
  const revoked = await h.deviceInfo();
  if (revoked.kind !== "device-registration-revoked") throw new Error("Recovery was not offered");
  const recovery = h.recover(revoked.recoveryId);
  await vi.waitFor(() => expect(h.closeAll).toHaveBeenCalledTimes(1));
  expect(h.recoverDeviceRegistration).not.toHaveBeenCalled();
  directory.resolve({ hosts: [{ id: h.bundle.hostId, environmentId: h.bundle.environmentId }] });
  await expect(recovery).resolves.toMatchObject({
    kind: "device-info",
    deviceJkt: "replacement-device",
  });
  expect(await pairing).toBeInstanceOf(Error);
  expect(mocks.pair).not.toHaveBeenCalled();
  await expect(h.confirm()).rejects.toThrow("fresh pairing code");
  await expect(h.recover(revoked.recoveryId)).rejects.toMatchObject({
    code: "device_recovery_expired",
  });
  expect(h.recoverDeviceRegistration).toHaveBeenCalledExactlyOnceWith({
    expectedAccount: h.account,
    revokedJkt: h.jkt,
  });
});

it("rejects a recovery offer after the signed-in account changes", async () => {
  const h = await harness();
  h.revoke();
  const revoked = await h.deviceInfo();
  if (revoked.kind !== "device-registration-revoked") throw new Error("Recovery was not offered");
  mocks.readAccount.mockResolvedValue({ ...h.account, userId: "other-owner" });
  await expect(h.recover(revoked.recoveryId)).rejects.toMatchObject({
    code: "device_recovery_expired",
  });
  expect(h.recoverDeviceRegistration).not.toHaveBeenCalled();
  expect(h.closeAll).not.toHaveBeenCalled();
});

it("rejects an old revoked-key check that finishes after a replacement is registered", async () => {
  const h = await harness();
  h.revoke();
  const revoked = await h.deviceInfo();
  if (revoked.kind !== "device-registration-revoked") throw new Error("Recovery was not offered");

  const readStarted = Promise.withResolvers<void>();
  const accountRead = Promise.withResolvers<typeof h.account>();
  mocks.readAccount.mockResolvedValueOnce(h.account).mockImplementationOnce(() => {
    readStarted.resolve();
    return accountRead.promise;
  });
  const oldCheck = h.deviceInfo();
  await readStarted.promise;
  await expect(h.recover(revoked.recoveryId)).resolves.toMatchObject({ kind: "device-info" });
  accountRead.resolve(h.account);
  await expect(oldCheck).rejects.toThrow("Select Find computer to check again");
});

it("reports and switches the owner's Allow connections setting without touching devices", async () => {
  const secretsDir = await mkdtemp(path.join(tmpdir(), "synara-allow-"));
  try {
    await initializeRemoteTlsIdentity(remoteTlsIdentityPath(secretsDir), "controller");
    mocks.readAccount.mockResolvedValue({
      accountUrl: "https://account.example.test",
      userId: "owner",
      organizationId: "org",
      hostId: "host",
      hostOwnerUserId: "owner",
    });
    let allowed = true;
    const devices = {
      list: vi.fn(() => Effect.succeed([])),
      allowsConnections: vi.fn(() => Effect.sync(() => allowed)),
      setAllowConnections: vi.fn((_scope: unknown, enabled: boolean) =>
        Effect.sync(() => {
          allowed = enabled;
        }),
      ),
      revoke: vi.fn(() => Effect.void),
    };
    const manage = makeRemoteAccessManagement({
      config: { baseDir: "/unused", stateDir: "/unused", secretsDir },
      environment: {
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.makeUnsafe("controller"),
          label: "Mac Mini",
        }),
      },
      control: { remotePairing: { list: () => Effect.succeed([]) } },
      devices,
    } as unknown as RemoteAccessManagementOptions);
    const signal = new AbortController().signal;
    await expect(manage({ operation: "list" }, signal)).resolves.toMatchObject({
      kind: "host-state",
      allowConnections: true,
    });
    await expect(
      manage({ operation: "set-allow-connections", enabled: false }, signal),
    ).resolves.toEqual({ kind: "done" });
    await expect(manage({ operation: "list" }, signal)).resolves.toMatchObject({
      allowConnections: false,
    });
    expect(devices.revoke).not.toHaveBeenCalled();
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
});
