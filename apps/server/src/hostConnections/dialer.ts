import { Schema } from "effect";
import { version as controllerBuild } from "../../package.json" with { type: "json" };
import {
  WsBootstrapNegotiateResult,
  WsCompatibilityError,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MIN_REVISION,
  WS_PROTOCOL_MAX_REVISION,
  WS_CLIENT_REQUIRED_CAPABILITIES,
  type WsBootstrapNegotiateInput,
  type AccountHost,
  type Es256PublicKeyJwk,
} from "@synara/contracts";
import { signDpopProof, signMintRequest, type DeviceSigningKey } from "@synara/shared/deviceKey";
import {
  raceTransports,
  sortByTransportPreference,
  type TransportCandidate,
  type TransportKind,
  type TransportRaceResult,
} from "@synara/shared/transportRace";
import { decodeJwt } from "jose";
import WebSocket from "ws";
import type { RemoteTlsAnchor } from "../remoteTransport/certificates";
import {
  connectRemoteTls,
  connectRemoteWebSocket,
  REMOTE_INNER_RPC_PATH,
  REMOTE_OUTER_PATH,
} from "../remoteTransport/tunnel";

const SESSION_PRESENTATION_HTU = "synara://remote/session";
const HANDSHAKE_TIMEOUT_MS = 15_000;

export interface DialIdentity {
  readonly userId: string;
  readonly key: DeviceSigningKey;
  readonly publicJwk: Es256PublicKeyJwk;
}
export interface RemoteChannelInput {
  readonly host: Pick<AccountHost, "id" | "environmentId" | "endpoints">;
  readonly anchor: RemoteTlsAnchor;
  readonly requestGrant: () => Promise<string>;
  readonly signal?: AbortSignal | undefined;
  readonly path?: string;
  readonly probe?: (candidate: TransportCandidate, signal: AbortSignal) => Promise<boolean>;
}
export const controllerProtocol: WsBootstrapNegotiateInput = {
  protocolEpoch: WS_PROTOCOL_EPOCH,
  minRevision: WS_PROTOCOL_MIN_REVISION,
  maxRevision: WS_PROTOCOL_MAX_REVISION,
  clientBuild: controllerBuild,
  requiredCapabilities: [...WS_CLIENT_REQUIRED_CAPABILITIES],
};
export interface DialInput extends RemoteChannelInput {
  readonly identity: DialIdentity;
  readonly client?: WsBootstrapNegotiateInput;
}
export interface DialedSession {
  readonly compatibility: WsBootstrapNegotiateResult;
  readonly environmentId: string;
  readonly socket: WebSocket;
  readonly transport: TransportKind;
  readonly credential: string;
  readonly credentialExpiresAtSeconds: number;
  readonly race: TransportRaceResult;
}
export class HostDialError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly stage: "no-route" | "unreachable" | "grant" | "handshake";
      readonly race?: TransportRaceResult;
      readonly closeCode?: number;
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HostDialError";
  }
}
function sessionUrl(candidate: TransportCandidate): string {
  const url = new URL(candidate.url);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || url.username || url.password)
    throw new Error("Invalid remote endpoint");
  url.pathname = REMOTE_OUTER_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}
function defaultProbe() {
  return async (candidate: TransportCandidate, signal: AbortSignal): Promise<boolean> => {
    const url = new URL(candidate.url);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    url.pathname = "/health";
    try {
      const response = await fetch(url, { signal, redirect: "error" });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };
}
export function buildDialCandidates(
  host: Pick<AccountHost, "id" | "endpoints">,
): readonly TransportCandidate[] {
  const candidates: TransportCandidate[] = host.endpoints.map((endpoint) => ({
    kind: endpoint.transport,
    url: endpoint.url,
    label: endpoint.transport,
  }));
  return candidates;
}
function openOuter(url: string, signal: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      perMessageDeflate: false,
      maxPayload: 2 * 1024 * 1024,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("open", opened);
      socket.off("close", closed);
      socket.off("unexpected-response", refused);
    };
    const fail = (cause: unknown) => {
      cleanup();
      socket.terminate();
      reject(
        new HostDialError("Could not open the remote socket", { stage: "handshake" }, { cause }),
      );
    };
    const abort = () => fail(new Error("Remote connection cancelled"));
    const opened = () => {
      cleanup();
      resolve(socket);
    };
    const closed = () => fail(new Error("Peer closed during upgrade"));
    const refused = (_request: unknown, response: import("node:http").IncomingMessage) => {
      response.resume();
      fail(new Error(`Upgrade refused (${response.statusCode})`));
    };
    socket.once("open", opened);
    socket.once("close", closed);
    socket.once("unexpected-response", refused);
    // Retain an error boundary after terminal cancellation of CONNECTING sockets.
    socket.on("error", fail);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Health chooses preference; the actual upgrade and TLS handshake decide reachability. */
async function openRemoteTransport<Socket>(
  input: RemoteChannelInput,
  authenticate: (outer: WebSocket, signal: AbortSignal) => Promise<Socket>,
): Promise<{
  socket: Socket;
  grant: string;
  candidate: TransportCandidate;
  race: TransportRaceResult;
}> {
  const candidates = buildDialCandidates(input.host);
  if (candidates.length === 0)
    throw new HostDialError("That host has no published route", { stage: "no-route" });
  if (input.anchor.environmentId !== input.host.environmentId)
    throw new HostDialError("The paired identity does not match this host", { stage: "handshake" });
  const deadline = AbortSignal.timeout(30_000);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const race = await raceTransports(candidates, input.probe ?? defaultProbe());
  const ordered =
    race.outcome === "reachable"
      ? [
          race.candidate,
          ...sortByTransportPreference(candidates).filter(
            (candidate) => candidate !== race.candidate,
          ),
        ]
      : sortByTransportPreference(candidates);
  let failure: unknown;
  for (const candidate of ordered) {
    if (signal.aborted) break;
    let grant: string;
    try {
      grant = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error("Grant request timed out"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
          .then(() => input.requestGrant())
          .then(resolve, reject)
          .finally(() => signal.removeEventListener("abort", abort));
        if (signal.aborted) abort();
      });
    } catch (cause) {
      throw new HostDialError("Could not obtain a connection grant", { stage: "grant" }, { cause });
    }
    let outer: WebSocket | undefined;
    try {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      outer = await openOuter(sessionUrl(candidate), attemptSignal);
      const socket = await authenticate(outer, attemptSignal);
      return { socket, grant, candidate, race };
    } catch (cause) {
      failure = cause;
      outer?.terminate();
    }
    // Each attempt consumes its own grant. No plaintext or stale-grant fallback.
  }
  throw new HostDialError(
    "No route completed the verified host handshake",
    { stage: "unreachable", race },
    { cause: failure },
  );
}

export function openRemoteChannel(input: RemoteChannelInput) {
  return openRemoteTransport(input, (outer, signal) =>
    connectRemoteWebSocket(outer, input.anchor, input.path ?? REMOTE_INNER_RPC_PATH, signal),
  );
}
export function openRemoteTlsChannel(input: RemoteChannelInput) {
  return openRemoteTransport(input, (outer, signal) =>
    connectRemoteTls(outer, input.anchor, signal),
  );
}

/** Request/response handshake with one owned listener set and no orphan rejection on send failure. */
export function exchangeRemoteFrame(
  socket: WebSocket,
  request: unknown,
  responseType: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => fail(new Error("Remote handshake timed out")),
      HANDSHAKE_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", message);
      socket.off("close", close);
      socket.off("error", fail);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (cause: unknown) => {
      cleanup();
      reject(cause);
    };
    const abort = () => fail(new Error("Remote handshake cancelled"));
    const close = (code: number) =>
      fail(
        new HostDialError("Remote peer refused the session", {
          stage: "handshake",
          closeCode: code,
        }),
      );
    const message = (data: WebSocket.RawData, binary: boolean) => {
      try {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        if (!binary && frame.type === "session_incompatible")
          throw Schema.decodeUnknownSync(WsCompatibilityError)(frame.error);
        if (binary || frame.type !== responseType)
          throw new Error("Unexpected remote handshake response");
        cleanup();
        resolve(frame);
      } catch (cause) {
        fail(cause);
      }
    };
    socket.on("message", message);
    socket.once("close", close);
    socket.once("error", fail);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      close(1006);
      return;
    }
    socket.send(JSON.stringify(request), { binary: false }, (error) => {
      if (error) fail(error);
    });
  });
}

export async function dialHost(input: DialInput): Promise<DialedSession> {
  const { socket, grant, candidate, race } = await openRemoteChannel(input);
  try {
    const request = await signMintRequest({
      key: input.identity.key,
      publicJwk: input.identity.publicJwk,
      userId: input.identity.userId,
      grant,
      environmentId: input.host.environmentId,
    });
    const minted = await exchangeRemoteFrame(
      socket,
      { v: 1, type: "mint_request", request },
      "session_credential",
      input.signal,
    );
    if (typeof minted.credential !== "string")
      throw new Error("Host returned no session credential");
    const credential = minted.credential;
    const dpop = await signDpopProof({
      key: input.identity.key,
      publicJwk: input.identity.publicJwk,
      method: "CONNECT",
      url: SESSION_PRESENTATION_HTU,
      accessToken: credential,
    });
    const ready = await exchangeRemoteFrame(
      socket,
      {
        v: 1,
        type: "session_authorize",
        credential,
        dpop,
        client: input.client ?? controllerProtocol,
      },
      "session_ready",
      input.signal,
    );
    const compatibility = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(ready.compatibility);
    if (ready.environmentId !== input.anchor.environmentId)
      throw new Error("Host protocol identity does not match its paired root");
    const exp = decodeJwt(credential).exp;
    if (typeof exp !== "number" || exp <= Date.now() / 1000)
      throw new Error("Host returned an expired credential");
    return {
      socket,
      compatibility,
      environmentId: input.anchor.environmentId,
      transport: candidate.kind,
      credential,
      credentialExpiresAtSeconds: exp,
      race,
    };
  } catch (cause) {
    socket.terminate();
    if (Schema.is(WsCompatibilityError)(cause)) throw cause;
    throw new HostDialError("Host authentication failed", { stage: "handshake" }, { cause });
  }
}
