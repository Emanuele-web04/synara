import { accountStateDirectory } from "../accountAuth";
import { createAccountClient } from "@synara/shared/account";
import { mintHostProof, readHostIdentity } from "../hostIdentity";
import { randomUUID } from "node:crypto";
import { calculateJwkThumbprint, SignJWT } from "jose";
import { X509Certificate } from "node:crypto";
import {
  EnvironmentId,
  type RemoteAccessRequest,
  type RemoteAccessResult,
  type RemotePairingBundle,
} from "@synara/contracts";
import { desktopFlavorFromBundleId } from "@synara/shared/betaFeatures";
import { Effect } from "effect";
import { accountApiIssuer, readAccountFile, withFreshAccessToken } from "../accountAuth";
import type { HostsAccountSession } from "../accountSession";
import type { AuthControlPlaneShape } from "../auth/Services/AuthControlPlane";
import type { ServerConfigShape } from "../config";
import type { ServerEnvironmentShape } from "../environment/Services/ServerEnvironment";
import type { HostConnectionRegistry } from "../hostConnections/registry";
import type { RemoteDeviceTrustRepositoryShape } from "../persistence/Services/RemoteDeviceTrust";
import type {
  RemoteAccountBinding,
  RemoteHostTrustRepositoryShape,
} from "../persistence/Services/RemoteHostTrust";
import { requireRemoteConnections } from "../remoteFeaturePolicy";
import {
  initializeRemoteTlsIdentity,
  loadRemoteTlsIdentity,
  remoteTlsAnchor,
  remoteTlsIdentityPath,
  remoteTlsRootNeedsRepair,
  resetRemoteTlsIdentity,
} from "../remoteTransport/certificates";
import { pairRemoteHost } from "./client";

export interface RemoteAccessManagementOptions {
  readonly config: ServerConfigShape;
  readonly environment: ServerEnvironmentShape;
  readonly control: AuthControlPlaneShape;
  readonly devices: RemoteDeviceTrustRepositoryShape;
  readonly hosts: RemoteHostTrustRepositoryShape;
  readonly account: HostsAccountSession;
  readonly connections: HostConnectionRegistry;
}
export type RemoteAccessManagement = (
  request: RemoteAccessRequest,
  signal: AbortSignal,
) => Promise<RemoteAccessResult>;

export function makeRemoteAccessManagement(
  options: RemoteAccessManagementOptions,
): RemoteAccessManagement {
  const pairing = new Map<string, { lifetime: AbortController; settled: Promise<void> }>();
  const previews = new Map<string, { bundle: RemotePairingBundle; binding: string }>();
  const readContext = async () => {
    const account = await readAccountFile(
      accountStateDirectory(options.config.baseDir, options.config.devUrl),
    );
    if (!account?.userId || !account.organizationId)
      throw new Error("Sign in to manage remote access");
    const local = await Effect.runPromise(options.environment.getDescriptor);
    const binding: RemoteAccountBinding = {
      controllerEnvironmentId: local.environmentId,
      accountAuthority: accountApiIssuer(account.accountUrl),
      userId: account.userId,
      organizationId: account.organizationId,
    };
    return { account, local, binding };
  };
  return async (request, signal) => {
    requireRemoteConnections(options.config.stateDir);
    const { account, local, binding } = await readContext();
    const client = createAccountClient({ baseUrl: account.accountUrl });
    const hostProof = async () => {
      const identity = await readHostIdentity(options.config.hostIdentityPath);
      if (!identity || !account.hostId || account.hostKeyGeneration === undefined)
        throw new Error("Link this computer first");
      return mintHostProof({
        identity,
        apiIssuer: binding.accountAuthority,
        environmentId: local.environmentId,
        hostId: account.hostId,
        keyGeneration: account.hostKeyGeneration,
      });
    };
    for (const [id, preview] of previews) {
      if (
        Date.parse(preview.bundle.expiresAt) <= Date.now() ||
        preview.binding !== JSON.stringify(binding)
      )
        previews.delete(id);
    }
    if (request.operation === "redeem-code") {
      if (previews.size >= 8) throw new Error("Finish or cancel the pending pairing first");
      const code = request.code
        .toUpperCase()
        .replace(/[^A-Z2-9]/g, "")
        .replace(/^(.{4})(.{4})$/, "$1-$2");
      const device = await options.account.dialIdentity();
      const proof = await new SignJWT({ code })
        .setProtectedHeader({ alg: "ES256", typ: "synara-pairing-code+jwt" })
        .setIssuer("synara-device")
        .setSubject(binding.userId)
        .setAudience(binding.accountAuthority)
        .setIssuedAt()
        .setExpirationTime("60s")
        .setJti(randomUUID())
        .sign(device.key);
      const bundle = await withFreshAccessToken(
        { baseDir: accountStateDirectory(options.config.baseDir, options.config.devUrl), client },
        (token) => client.redeemRemotePairingCode(token, { code, deviceJkt: device.jkt, proof }),
      );
      if (
        bundle.accountAuthority !== binding.accountAuthority ||
        bundle.userId !== binding.userId ||
        bundle.organizationId !== binding.organizationId
      )
        throw new Error("Pairing belongs to another account");
      if (JSON.stringify((await readContext()).binding) !== JSON.stringify(binding))
        throw new Error("Account changed during pairing");
      previews.set(bundle.inviteId, { bundle, binding: JSON.stringify(binding) });
      return {
        kind: "pairing-preview",
        inviteId: bundle.inviteId,
        environmentId: bundle.environmentId,
        label: bundle.label,
        rootFingerprint: bundle.rootFingerprint,
        expiresAt: bundle.expiresAt,
      };
    }
    if (request.operation === "revoke-account-sessions") {
      return {
        kind: "account-sessions-revoked",
        ...(await options.account.revokeDeviceAccountSessions({ deviceId: request.deviceId })),
      };
    }
    if (request.operation === "device-info") {
      const identity = await options.account.dialIdentity();
      return {
        kind: "device-info",
        deviceJkt: await calculateJwkThumbprint(identity.publicJwk),
        label: local.label,
      };
    }
    if (request.operation === "forget-host") {
      for (const [id, preview] of previews) {
        if (preview.bundle.environmentId === request.environmentId) previews.delete(id);
      }
      const pending = pairing.get(JSON.stringify([binding, request.environmentId]));
      pending?.lifetime.abort(new Error("Pairing cancelled"));
      // A cancelled setup must finish before deleting trust, or an in-flight
      // import/confirmation could recreate it after the user forgot the host.
      await pending?.settled;
      const trusted = await Effect.runPromise(options.hosts.get(binding, request.environmentId));
      if (trusted) options.connections.remove(trusted.hostId);
      await Effect.runPromise(options.hosts.forget(binding, request.environmentId));
      return { kind: "done" };
    }
    if (request.operation === "pair" || request.operation === "confirm-code") {
      const preview =
        request.operation === "confirm-code" ? previews.get(request.inviteId) : undefined;
      const bundle = request.operation === "pair" ? request.bundle : preview?.bundle;
      if (
        !bundle ||
        (request.operation === "confirm-code" &&
          (preview?.binding !== JSON.stringify(binding) ||
            request.rootFingerprint !== bundle.rootFingerprint))
      )
        throw new Error("Review a fresh pairing code and compare the host fingerprint");
      const key = JSON.stringify([binding, bundle.environmentId]);
      if (pairing.has(key)) throw new Error("Pairing is already in progress for this host");
      const lifetime = new AbortController();
      const pairSignal = AbortSignal.any([signal, lifetime.signal]);
      const settled = Promise.withResolvers<void>();
      const pending = { lifetime, settled: settled.promise };
      pairing.set(key, pending);
      try {
        pairSignal.throwIfAborted();
        await Effect.runPromise(options.hosts.importInvitation(binding, bundle));
        pairSignal.throwIfAborted();
        const { hosts } = await options.account.listHosts();
        pairSignal.throwIfAborted();
        const host = hosts.find(
          (candidate) =>
            candidate.id === bundle.hostId && candidate.environmentId === bundle.environmentId,
        );
        if (!host) throw new Error("The invitation host is not available in this account");
        const identity = await options.account.dialIdentity();
        pairSignal.throwIfAborted();
        await pairRemoteHost({
          host,
          anchor: bundle,
          bundle,
          identity,
          label: local.label,
          signal: pairSignal,
          requestGrant: async () => (await options.account.requestGrant({ hostId: host.id })).grant,
        });
        pairSignal.throwIfAborted();
        const current = await readContext();
        pairSignal.throwIfAborted();
        if (JSON.stringify(current.binding) !== JSON.stringify(binding))
          throw new Error("Account changed during pairing");
        const confirmed = await Effect.runPromise(
          options.hosts.confirm(
            binding,
            bundle.environmentId,
            bundle.rootFingerprint,
            new Date().toISOString(),
          ),
        );
        pairSignal.throwIfAborted();
        if (!confirmed) throw new Error("Local trust changed during pairing");
        // Keep the server-only bundle across transient failures. The public code
        // is still single-use; retries remain bound to this account and device.
        previews.delete(bundle.inviteId);
        return { kind: "paired", environmentId: bundle.environmentId, hostId: host.id };
      } finally {
        if (pairing.get(key) === pending) pairing.delete(key);
        settled.resolve();
      }
    }
    if (!account.hostId || account.hostOwnerUserId !== binding.userId)
      throw new Error("Link this host to your own account first");
    const identityPath = remoteTlsIdentityPath(options.config.secretsDir);
    if (request.operation === "reset-identity") {
      if (request.environmentId !== local.environmentId)
        throw new Error("The environment changed. Review the reset on this computer.");
      await Effect.runPromise(
        options.devices.resetEnvironment(local.environmentId, new Date().toISOString()),
      );
      await resetRemoteTlsIdentity(identityPath, local.environmentId);
      return { kind: "done" };
    }
    let identity;
    try {
      identity = await loadRemoteTlsIdentity(identityPath, local.environmentId);
    } catch (cause) {
      if (request.operation === "list")
        return {
          kind: "host-state",
          invitations: [],
          devices: [],
          rootExpiresAt: null,
          rootNeedsRepair: await Effect.runPromise(
            options.devices.hasIdentity(local.environmentId),
          ),
        };
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (
        (request.operation !== "create-invitation" && request.operation !== "create-code") ||
        (await Effect.runPromise(options.devices.hasIdentity(local.environmentId)))
      ) {
        throw new Error(
          "The host root is missing. Restore it or explicitly reset remote trust before pairing again.",
        );
      }
      identity = await initializeRemoteTlsIdentity(identityPath, local.environmentId);
    }
    const anchor = remoteTlsAnchor(identity);
    const scope = {
      environmentId: EnvironmentId.makeUnsafe(local.environmentId),
      rootFingerprint: anchor.rootFingerprint,
      accountAuthority: binding.accountAuthority,
      userId: binding.userId,
      organizationId: binding.organizationId,
    };
    switch (request.operation) {
      case "create-code":
      case "create-invitation": {
        if (request.operation === "create-code") {
          // Renewal also invalidates already-redeemed pending invitations locally.
          for (const old of await Effect.runPromise(options.control.remotePairing.list(scope))) {
            if (!old.approved && !old.revoked)
              await Effect.runPromise(options.control.remotePairing.revoke(scope, old.inviteId));
          }
        }
        const invitation = await Effect.runPromise(options.control.remotePairing.create(scope));
        const flavor = desktopFlavorFromBundleId(process.env.SYNARA_DESKTOP_BUNDLE_ID);
        const channel: RemotePairingBundle["channel"] =
          flavor === "beta"
            ? "beta"
            : flavor === "canary"
              ? "canary"
              : flavor === "production"
                ? "stable"
                : "dev";
        const bundle: RemotePairingBundle = {
          v: 2,
          ...anchor,
          ...scope,
          ...invitation,
          channel,
          hostId: account.hostId,
          label: local.label,
        };
        if (request.operation === "create-code") {
          try {
            const code = await client.publishRemotePairingCode(
              await hostProof(),
              account.hostId,
              bundle,
            );
            return { kind: "pairing-code", ...code, rootFingerprint: bundle.rootFingerprint };
          } catch (error) {
            await Effect.runPromise(
              options.control.remotePairing.revoke(scope, invitation.inviteId),
            );
            throw error;
          }
        }
        return { kind: "invitation", bundle };
      }
      case "list":
        return {
          kind: "host-state",
          invitations: await Effect.runPromise(options.control.remotePairing.list(scope)),
          devices: await Effect.runPromise(options.devices.list(scope)),
          rootFingerprint: anchor.rootFingerprint,
          rootExpiresAt: new Date(
            new X509Certificate(identity.rootCertificate).validTo,
          ).toISOString(),
          rootNeedsRepair: remoteTlsRootNeedsRepair(identity),
        };
      case "approve":
        if (
          !(await Effect.runPromise(
            options.control.remotePairing.approve(scope, request.inviteId, request.deviceJkt),
          ))
        )
          throw new Error(
            "The invitation or requested device changed. Review it again on this host.",
          );
        return { kind: "done" };
      case "cancel-invitation":
        await Effect.runPromise(options.control.remotePairing.revoke(scope, request.inviteId));
        await client
          .cancelRemotePairingCode(await hostProof(), account.hostId, request.inviteId)
          .catch(() => {});
        return { kind: "done" };
      case "revoke-device":
        await Effect.runPromise(
          options.devices.revoke(scope, request.deviceJkt, new Date().toISOString()),
        );
        return { kind: "done" };
    }
  };
}
