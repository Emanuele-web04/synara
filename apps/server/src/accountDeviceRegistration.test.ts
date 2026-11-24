import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AccountDevice, DevicePublicKeyJwk } from "@synara/contracts";
import { createAccountSession } from "./accountSession";
import { AccountApiError, type AccountClient } from "@synara/shared/account";
import { deviceThumbprint } from "@synara/shared/deviceKey";
import { decodeJwt } from "jose";
import { generatePairingKeyPair, generateSyncKey } from "@synara/shared/hostSecrets";
import * as remoteFeaturePolicy from "./remoteFeaturePolicy";
import * as syncKeyStore from "./hostSecrets/syncKeyStore";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountDeviceKeyRevokedError,
  ensureAccountDeviceRegistration,
  recoverAccountDeviceRegistration,
} from "./accountDeviceRegistration";
import {
  readAccountFile,
  withLockedAccountFile,
  WorkspaceAccessChangedError,
  writeAccountCredentials,
} from "./accountAuth";

const scope = {
  accountUrl: "https://accounts.example.com",
  organizationId: "org_1",
  userId: "user_1",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function harness() {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-device-registration-"));
  directories.push(baseDir);
  const credentials = {
    ...scope,
    workosClientId: "client_1",
    workosApiUrl: "https://api.workos.example",
    accessToken: "access-token",
    refreshToken: "refresh-token",
  };
  await writeAccountCredentials(baseDir, credentials);

  const devices = new Map<string, AccountDevice>();
  const registerDevice = vi.fn(async (_token: string, proof: string) => {
    const claims = decodeJwt(proof) as {
      publicKeyJwk: DevicePublicKeyJwk;
      displayName: string;
      platform: "darwin";
    };
    const jkt = await deviceThumbprint(claims.publicKeyJwk);
    const existing = devices.get(jkt);
    if (existing?.revokedAt) {
      throw new AccountApiError({
        status: 403,
        code: "device_not_registered",
        message: "This device key was revoked.",
      });
    }
    const device: AccountDevice = existing ?? {
      id: `00000000-0000-4000-8000-${String(devices.size + 1).padStart(12, "0")}`,
      publicKeyJwk: claims.publicKeyJwk,
      jkt,
      displayName: claims.displayName,
      platform: claims.platform,
      createdAt: "2026-08-14T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    };
    devices.set(jkt, device);
    return { device };
  });
  const refreshAccessToken = vi.fn(async () => {
    throw new Error("Account provider unavailable");
  });
  const requestGrant = vi.fn<AccountClient["requestGrant"]>();
  const me = vi.fn<AccountClient["me"]>(async () => ({
    id: scope.userId,
    email: "ada@example.com",
    name: "Ada",
    organization: { id: scope.organizationId, name: "Personal" },
    profile: null,
  }));
  const putSyncKeyWrap = vi.fn<AccountClient["putSyncKeyWrap"]>(async (_token, request) => ({
    recipientDeviceId: request.recipientDeviceId,
    createdAt: "2026-08-14T12:00:00.000Z",
    expiresAt: "2026-08-14T12:10:00.000Z",
  }));
  const client = {
    putSyncKeyWrap,
    registerDevice,
    refreshAccessToken,
    requestGrant,
    me,
  } as unknown as AccountClient;
  const options = {
    baseDir,
    accountUrl: scope.accountUrl,
    client,
    displayName: "Ada's Mac",
    platform: "darwin" as const,
  };
  return {
    baseDir,
    credentials,
    devices,
    registerDevice,
    refreshAccessToken,
    requestGrant,
    putSyncKeyWrap,
    session: createAccountSession({ baseDir, client, platform: "darwin" }),
    enroll: () => ensureAccountDeviceRegistration(options),
    recover: (jkt: string) =>
      recoverAccountDeviceRegistration({ ...options, expectedAccount: scope }, jkt),
    revoke(jkt: string) {
      const device = devices.get(jkt);
      if (!device) throw new Error("Device was not registered");
      devices.set(jkt, { ...device, revokedAt: "2026-08-15T12:00:00.000Z" });
    },
  };
}

describe("account device registration", () => {
  it("reuses a registered shell key and preserves the account session when the key is revoked", async () => {
    const h = await harness();
    const first = await h.enroll();
    expect(await h.enroll()).toEqual(first);
    const registered = await readAccountFile(h.baseDir);
    expect(registered).toMatchObject({ deviceId: first.deviceId, deviceJkt: first.jkt });

    h.revoke(first.jkt);
    await expect(h.enroll()).rejects.toMatchObject({
      status: 403,
      code: "device_not_registered",
      jkt: first.jkt,
    });
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
    expect(await readAccountFile(h.baseDir)).toEqual(registered);
  });

  it("preserves a valid account session when the service rejects its device proof", async () => {
    const h = await harness();
    const refusal = new AccountApiError({
      status: 401,
      code: "bad_proof",
      message: "Invalid proof",
    });
    h.registerDevice.mockRejectedValueOnce(refusal);

    await expect(h.enroll()).rejects.toBe(refusal);
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
    expect(await readAccountFile(h.baseDir)).toEqual(h.credentials);
  });

  it("surfaces a host permission refusal without rotating the account token", async () => {
    const h = await harness();
    const refusal = new AccountApiError({
      status: 403,
      code: "not_host_owner",
      message: "Host owner only",
    });
    h.requestGrant.mockRejectedValueOnce(refusal);

    await expect(h.session.requestGrant({ hostId: "host-1" })).rejects.toBe(refusal);
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
    expect(h.requestGrant).toHaveBeenCalledTimes(1);
  });

  it("backfills a legacy user from its scoped session before requesting a grant", async () => {
    const h = await harness();
    const { userId, ...legacy } = h.credentials;
    await writeAccountCredentials(h.baseDir, legacy);
    h.requestGrant.mockResolvedValueOnce({ grant: "fixture-grant" });

    await expect(h.session.requestGrant({ hostId: "host-1" })).resolves.toEqual({
      grant: "fixture-grant",
    });
    const current = await readAccountFile(h.baseDir);
    expect(current).toMatchObject({ userId });
    expect(h.requestGrant).toHaveBeenCalledWith(legacy.accessToken, "host-1", current?.deviceJkt);
  });

  it("does not return a grant after the local account changes during the request", async () => {
    const h = await harness();
    h.requestGrant.mockImplementationOnce(async () => {
      await writeAccountCredentials(h.baseDir, {
        ...h.credentials,
        userId: "user_2",
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
      });
      return { grant: "fixture-grant" };
    });

    await expect(h.session.requestGrant({ hostId: "host-1" })).rejects.toThrow(
      /workspace access changed/i,
    );
    expect(h.requestGrant).toHaveBeenCalledTimes(1);
    expect(h.refreshAccessToken).not.toHaveBeenCalled();
    expect(await readAccountFile(h.baseDir)).toMatchObject({ userId: "user_2" });
  });

  it("does not upload a stale Host Secrets key or overwrite the replacement account's key", async () => {
    const h = await harness();
    const pairing = await generatePairingKeyPair();
    const replacement = {
      ...h.credentials,
      userId: "user_2",
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    };
    const replacementKey = await generateSyncKey();
    // Exercise the real coordinator while keeping its production feature gate closed.
    const gate = vi
      .spyOn(remoteFeaturePolicy, "requireHostSecretsSync")
      .mockImplementation(() => {});
    const read = syncKeyStore.readHostSecretsSyncKey;
    const intercepted = vi
      .spyOn(syncKeyStore, "readHostSecretsSyncKey")
      .mockImplementationOnce(async (input) => {
        const original = await read(input);
        await withLockedAccountFile(h.baseDir, () =>
          writeAccountCredentials(h.baseDir, replacement),
        );
        await syncKeyStore.writeHostSecretsSyncKey({
          filePath: input.filePath,
          accountUrl: replacement.accountUrl,
          userId: replacement.userId,
          syncKey: replacementKey,
        });
        return original;
      });
    try {
      await expect(
        h.session.offerSyncKey({
          recipientDeviceId: "00000000-0000-4000-8000-000000000099",
          recipientPublicJwk: pairing.publicJwk,
        }),
      ).rejects.toBeInstanceOf(WorkspaceAccessChangedError);
      expect(h.putSyncKeyWrap).not.toHaveBeenCalled();
      const current = await read({
        filePath: syncKeyStore.hostSecretsSyncKeyPath(path.join(h.baseDir, "userdata", "secrets")),
        accountUrl: replacement.accountUrl,
        userId: replacement.userId,
      });
      expect(current && (await crypto.subtle.exportKey("raw", current))).toEqual(
        await crypto.subtle.exportKey("raw", replacementKey),
      );
    } finally {
      intercepted.mockRestore();
      gate.mockRestore();
    }
  });

  it("explicitly replaces a revoked key once and reuses the durable replacement", async () => {
    const h = await harness();
    const original = await h.enroll();
    h.revoke(original.jkt);

    const results = await Promise.allSettled([h.recover(original.jkt), h.recover(original.jkt)]);
    const successful = results.filter((result) => result.status === "fulfilled");
    expect(successful).toHaveLength(1);
    const recovered = successful[0]!.value;
    expect(recovered.jkt).not.toBe(original.jkt);
    expect(recovered.deviceId).not.toBe(original.deviceId);
    expect(h.devices.get(original.jkt)?.revokedAt).not.toBeNull();
    expect(await h.enroll()).toEqual(recovered);
    expect(await readAccountFile(h.baseDir)).toMatchObject({
      ...h.credentials,
      deviceId: recovered.deviceId,
      deviceJkt: recovered.jkt,
    });
  });

  it("keeps a replacement key durable when its first registration fails", async () => {
    const h = await harness();
    const original = await h.enroll();
    h.revoke(original.jkt);
    const register = h.registerDevice.getMockImplementation()!;
    let pendingJkt: string | undefined;
    h.registerDevice.mockImplementation(async (token, proof) => {
      const { publicKeyJwk } = decodeJwt(proof) as { publicKeyJwk: DevicePublicKeyJwk };
      const jkt = await deviceThumbprint(publicKeyJwk);
      if (jkt !== original.jkt && !pendingJkt) {
        pendingJkt = jkt;
        throw new Error("Account API unavailable during replacement registration");
      }
      return register(token, proof);
    });

    await expect(h.recover(original.jkt)).rejects.toThrow("Account API unavailable");
    await expect(h.recover(original.jkt)).rejects.toThrow("device key changed");
    const recovered = await h.enroll();
    expect(recovered.jkt).toBe(pendingJkt);
    expect(await readAccountFile(h.baseDir)).toMatchObject({
      deviceId: recovered.deviceId,
      deviceJkt: recovered.jkt,
    });
  });

  it.each(["active", "unavailable"] as const)(
    "keeps the retained key if the old-key probe is %s",
    async (state) => {
      const h = await harness();
      const original = await h.enroll();
      if (state === "unavailable")
        h.registerDevice.mockRejectedValueOnce(new Error("Account API unavailable"));
      await expect(h.recover(original.jkt)).rejects.toThrow(
        state === "active" ? "still registered" : "Account API unavailable",
      );
      expect(await h.enroll()).toEqual(original);
      expect(h.devices.size).toBe(1);
    },
  );

  it("leaves the retained key untouched when the account changes during revocation verification", async () => {
    const h = await harness();
    const original = await h.enroll();
    h.revoke(original.jkt);
    const replacementAccount = {
      ...h.credentials,
      userId: "user_2",
      accessToken: "replacement-access",
      refreshToken: "replacement-refresh",
    };
    const register = h.registerDevice.getMockImplementation()!;
    h.registerDevice.mockImplementationOnce(async (token, proof) => {
      await withLockedAccountFile(h.baseDir, () =>
        writeAccountCredentials(h.baseDir, replacementAccount),
      );
      return register(token, proof);
    });

    await expect(h.recover(original.jkt)).rejects.toBeInstanceOf(WorkspaceAccessChangedError);
    expect(await readAccountFile(h.baseDir)).toEqual(replacementAccount);
    await writeAccountCredentials(h.baseDir, h.credentials);
    await expect(h.enroll()).rejects.toBeInstanceOf(AccountDeviceKeyRevokedError);
    expect(h.devices.size).toBe(1);
  });
});
