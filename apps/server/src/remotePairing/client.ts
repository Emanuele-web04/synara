import { randomUUID } from "node:crypto";
import type { RemotePairingBundle } from "@synara/contracts";
import { calculateJwkThumbprint, SignJWT } from "jose";
import {
  exchangeRemoteFrame,
  openRemoteChannel,
  type DialIdentity,
  type RemoteChannelInput,
} from "../hostConnections/dialer";
import { REMOTE_INNER_PAIRING_PATH } from "../remoteTransport/tunnel";
import { REMOTE_PAIRING_PROOF_TYPE } from "./gateway";

function waitForApprovalPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Pairing cancelled or expired"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** The owner RPC awaits this operation; interruption closes the TLS channel. */
export async function pairRemoteHost(
  input: RemoteChannelInput & {
    bundle: RemotePairingBundle;
    identity: DialIdentity;
    label: string;
  },
): Promise<void> {
  const { bundle, identity } = input;
  if (identity.userId !== bundle.userId)
    throw new Error("Pairing invitation belongs to another account");
  const deadline = AbortSignal.timeout(Math.max(1, Date.parse(bundle.expiresAt) - Date.now()));
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const { socket } = await openRemoteChannel({ ...input, signal, path: REMOTE_INNER_PAIRING_PATH });
  const abort = () => socket.terminate();
  signal.addEventListener("abort", abort, { once: true });
  try {
    const challenge = await exchangeRemoteFrame(
      socket,
      {
        v: 2,
        type: "pairing_begin",
        inviteId: bundle.inviteId,
        secret: bundle.secret,
        publicKey: identity.publicJwk,
        label: input.label,
      },
      "pairing_challenge",
      signal,
    );
    if (typeof challenge.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(challenge.nonce))
      throw new Error("Invalid host pairing challenge");
    // The owner's account grant for this key lets the host approve without a second step;
    // without one the host falls back to manual owner approval.
    const grant = await input.requestGrant().catch(() => undefined);
    signal.throwIfAborted();
    const proof = await new SignJWT({ nonce: challenge.nonce, inviteId: bundle.inviteId })
      .setProtectedHeader({ alg: "ES256", typ: REMOTE_PAIRING_PROOF_TYPE })
      .setIssuer("synara-device")
      .setSubject(identity.userId)
      .setAudience(`synara-host:${bundle.environmentId}`)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign("privateKey" in identity.key ? identity.key.privateKey : identity.key);
    let status = await exchangeRemoteFrame(
      socket,
      { v: 2, type: "pairing_proof", proof, ...(grant ? { grant } : {}) },
      "pairing_status",
      signal,
    );
    const jkt = await calculateJwkThumbprint(identity.publicJwk);
    for (;;) {
      if (status.deviceJkt !== jkt) throw new Error("Host approved a different device");
      if (status.state === "approved") return;
      if (status.state !== "pending") throw new Error("Host denied this device");
      await waitForApprovalPoll(signal);
      status = await exchangeRemoteFrame(
        socket,
        { v: 2, type: "pairing_status" },
        "pairing_status",
        signal,
      );
    }
  } finally {
    signal.removeEventListener("abort", abort);
    socket.terminate();
  }
}
