import { randomBytes } from "node:crypto";
import {
  DevicePublicKeyJwk,
  type RemotePairingDevice,
  type RemoteTrustScope,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { calculateJwkThumbprint, importJWK, jwtVerify } from "jose";
import type WebSocket from "ws";
import type { AuthControlPlaneShape } from "../auth/Services/AuthControlPlane";
import { HostMintError, type HostGrantVerifier } from "../hostAuth/grantVerifier";
import type { RemoteDeviceTrustRepositoryShape } from "../persistence/Services/RemoteDeviceTrust";

export const REMOTE_PAIRING_PROOF_TYPE = "synara-remote-pairing+jwt";

/** Spends the owner's account grant for this device key, or reports a generic refusal. */
async function acceptOwnerGrant(
  grants: HostGrantVerifier,
  grant: string,
  scope: RemoteTrustScope,
  deviceJkt: string,
): Promise<boolean> {
  try {
    grants.consume(await grants.verify(grant, { deviceJkt, subject: scope.userId }));
    return true;
  } catch (cause) {
    // The device falls back to owner approval; never reveal why to it or log grant details.
    const reason = cause instanceof HostMintError ? cause.code : "invalid_grant";
    console.warn(
      `[synara] Remote pairing grant not accepted (${reason}); owner approval required.`,
    );
    return false;
  }
}

/**
 * This gateway is only reachable inside authenticated host TLS; it exposes no coding RPC.
 * A `pairing_proof` may carry `grant`, the owner's account grant for the pairing key:
 * when it verifies and connections are allowed, the device is approved without a second step.
 */
export function acceptRemotePairing(
  socket: WebSocket,
  scope: RemoteTrustScope,
  pairing: AuthControlPlaneShape["remotePairing"],
  trust: RemoteDeviceTrustRepositoryShape,
  grants?: HostGrantVerifier,
): void {
  let context:
    | { inviteId: string; device: RemotePairingDevice; nonce: string; expiresAt: number }
    | undefined;
  let state: "begin" | "proof" | "pending" = "begin";
  let closed = false;
  let pendingBytes = 0;
  let pendingFrames = 0;
  let handling = Promise.resolve();
  let deadline = setTimeout(() => socket.close(1008, "Pairing timed out"), 15_000);
  const sendStatus = async () => {
    if (!context) throw new Error("Pairing not started");
    const current = context;
    const invitation = (await Effect.runPromise(pairing.list(scope))).find(
      (entry) => entry.inviteId === current.inviteId,
    );
    if (
      !invitation ||
      invitation.revoked ||
      (!invitation.approved && Date.parse(invitation.expiresAt) <= Date.now())
    )
      throw new Error("Invitation unavailable");
    const approved =
      invitation.approved &&
      (await Effect.runPromise(trust.authorize(scope, current.device.deviceJkt)));
    if (closed) return;
    socket.send(
      JSON.stringify({
        v: 2,
        type: "pairing_status",
        state: approved ? "approved" : "pending",
        deviceJkt: context.device.deviceJkt,
      }),
    );
  };
  socket.once("close", () => {
    closed = true;
    clearTimeout(deadline);
    context = undefined;
  });
  socket.on("message", (data, binary) => {
    if (closed) return;
    const raw = data.toString();
    pendingBytes += Buffer.byteLength(raw);
    pendingFrames += 1;
    if (binary || pendingBytes > 16 * 1024 || pendingFrames > 8) {
      socket.close(1009, "Pairing frame limit exceeded");
      return;
    }
    handling = handling.then(async () => {
      pendingBytes -= Buffer.byteLength(raw);
      pendingFrames -= 1;
      if (closed) return;
      try {
        const frame = JSON.parse(raw) as Record<string, unknown>;
        if (frame.v !== 2) throw new Error("Unsupported pairing protocol");
        if (state === "begin" && frame.type === "pairing_begin") {
          if (
            typeof frame.inviteId !== "string" ||
            typeof frame.secret !== "string" ||
            typeof frame.label !== "string" ||
            frame.label.length < 1 ||
            frame.label.length > 128
          )
            throw new Error("Invalid pairing request");
          const publicKey = Schema.decodeUnknownSync(DevicePublicKeyJwk)(frame.publicKey);
          const invitation = await Effect.runPromise(
            pairing.verifyInvitation(scope, frame.inviteId, frame.secret),
          );
          const deviceJkt = await calculateJwkThumbprint(publicKey);
          if (invitation.pendingDevice && invitation.pendingDevice.deviceJkt !== deviceJkt)
            throw new Error("Invitation already claimed by another key");
          if (closed) return;
          context = {
            inviteId: frame.inviteId,
            device: { deviceJkt, publicKey, label: frame.label },
            nonce: randomBytes(32).toString("base64url"),
            expiresAt: Date.parse(invitation.expiresAt),
          };
          state = "proof";
          socket.send(JSON.stringify({ v: 2, type: "pairing_challenge", nonce: context.nonce }));
          return;
        }
        if (
          state === "proof" &&
          context &&
          frame.type === "pairing_proof" &&
          typeof frame.proof === "string"
        ) {
          const algorithm = context.device.publicKey.kty === "EC" ? "ES256" : "EdDSA";
          const { payload } = await jwtVerify(
            frame.proof,
            await importJWK(context.device.publicKey, algorithm),
            {
              algorithms: [algorithm],
              typ: REMOTE_PAIRING_PROOF_TYPE,
              issuer: "synara-device",
              audience: `synara-host:${scope.environmentId}`,
              requiredClaims: ["exp", "iat", "jti"],
              maxTokenAge: "60s",
            },
          );
          if (
            payload.nonce !== context.nonce ||
            payload.inviteId !== context.inviteId ||
            payload.sub !== scope.userId ||
            typeof payload.exp !== "number" ||
            typeof payload.iat !== "number" ||
            payload.exp - payload.iat > 60
          )
            throw new Error("Invalid pairing proof");
          const ownerGrant =
            typeof frame.grant === "string" &&
            grants !== undefined &&
            (await Effect.runPromise(trust.allowsConnections(scope))) &&
            (await acceptOwnerGrant(grants, frame.grant, scope, context.device.deviceJkt));
          if (closed) return;
          const recorded = await Effect.runPromise(
            ownerGrant
              ? pairing.enroll(scope, context.inviteId, context.device)
              : pairing.requestApproval(scope, context.inviteId, context.device),
          );
          if (closed) return;
          if (!recorded) throw new Error("Invitation is no longer available");
          state = "pending";
          clearTimeout(deadline);
          deadline = setTimeout(
            () => socket.close(1008, "Pairing invitation expired"),
            Math.max(1, context.expiresAt - Date.now()),
          );
          await sendStatus();
          return;
        }
        if (state === "pending" && frame.type === "pairing_status") {
          await sendStatus();
          return;
        }
        throw new Error("Unexpected pairing message");
      } catch {
        // Never echo invitation secrets, proofs or key material in close reasons.
        socket.close(1008, "Pairing failed. Check the invitation on the host.");
      }
    });
  });
}
