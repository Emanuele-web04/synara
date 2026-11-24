import { Schema } from "effect";
import { version as controllerBuild } from "../../package.json" with { type: "json" };
import {
  HOST_SESSION_CLOSE_AUTH_FAILED,
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
import { decodeJwtPayloadUnsafe } from "../lazyJose";
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
const CACHED_CREDENTIAL_MIN_TTL_MS = 60_000;
const RECENTLY_TIMED_OUT_PROBE_TTL_MS = 60_000;
const RECENTLY_TIMED_OUT_PROBE_BUDGET_MS = 300;
const MAX_TIMED_OUT_PROBE_CACHE_ENTRIES = 256;

// Tracks candidate URLs whose /health probe timed out (e.g. a phone on cellular
// trying a non-routable home LAN IP). Subsequent connects within 60s still probe
// them so returning to Wi-Fi switches back to LAN immediately, but cap the probe
// wait to 300ms instead of burning 1.5s on every reconnect.
const recentlyTimedOutProbeUrls = new Map<string, number>();

function recordTimedOutProbeUrl(url: string, now = Date.now()): void {
  recentlyTimedOutProbeUrls.delete(url);
  if (recentlyTimedOutProbeUrls.size >= MAX_TIMED_OUT_PROBE_CACHE_ENTRIES) {
    const oldest = recentlyTimedOutProbeUrls.keys().next().value;
    if (oldest !== undefined) recentlyTimedOutProbeUrls.delete(oldest);
  }
  recentlyTimedOutProbeUrls.set(url, now + RECENTLY_TIMED_OUT_PROBE_TTL_MS);
}

function isRecentlyTimedOutProbeUrl(url: string, now = Date.now()): boolean {
  const expiresAt = recentlyTimedOutProbeUrls.get(url);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    recentlyTimedOutProbeUrls.delete(url);
    return false;
  }
  return true;
}

export interface CachedSessionCredential {
  readonly credential: string;
  readonly expiresAtSeconds: number;
}

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
  /** Valid host-minted session credential from a recent dial; skips grant + mint RTTs when accepted. */
  readonly cachedCredential?: CachedSessionCredential | undefined;
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
    const fastCap = isRecentlyTimedOutProbeUrl(candidate.url);
    const probeSignal = fastCap
      ? AbortSignal.any([signal, AbortSignal.timeout(RECENTLY_TIMED_OUT_PROBE_BUDGET_MS)])
      : signal;
    try {
      const response = await fetch(url, { signal: probeSignal, redirect: "error" });
      await response.body?.cancel();
      if (response.ok) {
        recentlyTimedOutProbeUrls.delete(candidate.url);
      }
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

function requestGrantWithSignal(
  requestGrant: () => Promise<string>,
  signal: AbortSignal,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const abort = () => reject(new Error("Grant request timed out"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => requestGrant())
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  }).catch((cause) => {
    throw new HostDialError("Could not obtain a connection grant", { stage: "grant" }, { cause });
  });
}

/** Health chooses preference; the actual upgrade and TLS handshake decide reachability. */
async function openRemoteTransport<Socket>(
  input: RemoteChannelInput,
  authenticate: (outer: WebSocket, signal: AbortSignal) => Promise<Socket>,
  options: { readonly skipGrant?: boolean } = {},
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
  const skipGrant = options.skipGrant === true;

  // Overlap the first connection grant fetch with transport racing and outer
  // socket/TLS establishment so the account API RTT does not sit serially on
  // the critical path. Attach a no-op rejection handler so an earlier transport
  // error never triggers an unhandled rejection.
  const firstGrantPromise = skipGrant
    ? Promise.resolve("")
    : requestGrantWithSignal(input.requestGrant, signal);
  void firstGrantPromise.catch(() => {});

  // When a host advertises only one endpoint (and no custom probe was injected),
  // there is no transport preference decision to make: skip the extra /health
  // RTT and let the real WS upgrade + TLS handshake determine reachability.
  const singleDirectCandidate =
    candidates.length === 1 && !input.probe ? candidates[0] : undefined;
  let race: TransportRaceResult;
  let ordered: readonly TransportCandidate[];
  if (singleDirectCandidate) {
    ordered = [singleDirectCandidate];
    race = {
      outcome: "reachable",
      candidate: singleDirectCandidate,
      attempts: [{ candidate: singleDirectCandidate, status: "reachable" }],
    };
  } else {
    race = await raceTransports(candidates, input.probe ?? defaultProbe());
    if (!input.probe) {
      const now = Date.now();
      for (const attempt of race.attempts) {
        if (attempt.status === "timed-out") {
          recordTimedOutProbeUrl(attempt.candidate.url, now);
        } else if (attempt.status === "reachable") {
          recentlyTimedOutProbeUrls.delete(attempt.candidate.url);
        }
      }
    }
    ordered =
      race.outcome === "reachable"
        ? [
            race.candidate,
            ...sortByTransportPreference(candidates).filter(
              (candidate) => candidate !== race.candidate,
            ),
          ]
        : sortByTransportPreference(candidates);
  }

  let failure: unknown;
  for (let index = 0; index < ordered.length; index += 1) {
    const candidate = ordered[index]!;
    if (signal.aborted) break;
    // Each attempt consumes its own grant. Attempt 0 reuses the overlapped grant;
    // fallback attempts request a fresh grant in parallel with dialing.
    const grantPromise =
      index === 0
        ? firstGrantPromise
        : skipGrant
          ? Promise.resolve("")
          : requestGrantWithSignal(input.requestGrant, signal);
    void grantPromise.catch(() => {});

    let outer: WebSocket | undefined;
    try {
      const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
      outer = await openOuter(sessionUrl(candidate), attemptSignal);
      const socket = await authenticate(outer, attemptSignal);
      const grant = await grantPromise;
      return { socket, grant, candidate, race };
    } catch (cause) {
      outer?.terminate();
      if (cause instanceof HostDialError && cause.detail.stage === "grant") {
        throw cause;
      }
      failure = cause;
    }
  }
  const finalRace: TransportRaceResult = singleDirectCandidate
    ? {
        outcome: "unreachable",
        attempts: [{ candidate: singleDirectCandidate, status: "unreachable" }],
      }
    : race;
  throw new HostDialError(
    "No route completed the verified host handshake",
    { stage: "unreachable", race: finalRace },
    { cause: failure },
  );
}

export function openRemoteChannel(
  input: RemoteChannelInput,
  options?: { readonly skipGrant?: boolean },
) {
  return openRemoteTransport(
    input,
    (outer, signal) =>
      connectRemoteWebSocket(outer, input.anchor, input.path ?? REMOTE_INNER_RPC_PATH, signal),
    options,
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

async function authorizeDialedChannel(input: {
  readonly socket: WebSocket;
  readonly credential: string;
  readonly identity: DialIdentity;
  readonly anchor: RemoteTlsAnchor;
  readonly client: WsBootstrapNegotiateInput;
  readonly transport: TransportKind;
  readonly race: TransportRaceResult;
  readonly signal?: AbortSignal | undefined;
}): Promise<DialedSession> {
  const dpop = await signDpopProof({
    key: input.identity.key,
    publicJwk: input.identity.publicJwk,
    method: "CONNECT",
    url: SESSION_PRESENTATION_HTU,
    accessToken: input.credential,
  });
  const ready = await exchangeRemoteFrame(
    input.socket,
    {
      v: 1,
      type: "session_authorize",
      credential: input.credential,
      dpop,
      client: input.client,
    },
    "session_ready",
    input.signal,
  );
  const compatibility = Schema.decodeUnknownSync(WsBootstrapNegotiateResult)(ready.compatibility);
  if (ready.environmentId !== input.anchor.environmentId)
    throw new Error("Host protocol identity does not match its paired root");
  const exp = decodeJwtPayloadUnsafe(input.credential).exp;
  if (typeof exp !== "number" || exp <= Date.now() / 1000)
    throw new Error("Host returned an expired credential");
  return {
    socket: input.socket,
    compatibility,
    environmentId: input.anchor.environmentId,
    transport: input.transport,
    credential: input.credential,
    credentialExpiresAtSeconds: exp,
    race: input.race,
  };
}

export async function dialHost(input: DialInput): Promise<DialedSession> {
  const cached = input.cachedCredential;
  const canReuseCachedCredential =
    cached !== undefined &&
    cached.credential.length > 0 &&
    cached.expiresAtSeconds * 1000 > Date.now() + CACHED_CREDENTIAL_MIN_TTL_MS;

  if (canReuseCachedCredential) {
    const { socket, candidate, race } = await openRemoteChannel(input, { skipGrant: true });
    try {
      return await authorizeDialedChannel({
        socket,
        credential: cached.credential,
        identity: input.identity,
        anchor: input.anchor,
        client: input.client ?? controllerProtocol,
        transport: candidate.kind,
        race,
        signal: input.signal,
      });
    } catch (cause) {
      socket.terminate();
      if (Schema.is(WsCompatibilityError)(cause)) throw cause;
      // Only fall back to a fresh grant+mint when the host rejected the cached
      // credential (for example after a key rotation or trust generation bump).
      const isAuthRejection =
        cause instanceof HostDialError && cause.detail.closeCode === HOST_SESSION_CLOSE_AUTH_FAILED;
      if (!isAuthRejection) {
        throw new HostDialError("Host authentication failed", { stage: "handshake" }, { cause });
      }
    }
  }

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
    return await authorizeDialedChannel({
      socket,
      credential: minted.credential,
      identity: input.identity,
      anchor: input.anchor,
      client: input.client ?? controllerProtocol,
      transport: candidate.kind,
      race,
      signal: input.signal,
    });
  } catch (cause) {
    socket.terminate();
    if (Schema.is(WsCompatibilityError)(cause)) throw cause;
    throw new HostDialError("Host authentication failed", { stage: "handshake" }, { cause });
  }
}
