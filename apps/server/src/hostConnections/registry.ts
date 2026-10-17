import { remoteUnaryRpc } from "./unaryRpc";
import { classifyConnectionFailure } from "./failure";
import type { RemoteResourcePool } from "./resourcePool";
import { randomUUID } from "node:crypto";
import type {
  HostConnection,
  HostConnectionState,
  RemoteExecutionScope,
  WsBootstrapNegotiateInput,
  WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { Effect, Layer, ServiceMap } from "effect";
import WebSocket, { type RawData } from "ws";
import { sendBoundedRelayFrame, type RelaySocket } from "../relaySocket";
import type { DialedSession } from "./dialer";

export const HOST_CONNECTION_WS_PATH_PREFIX = "/ws/remote/";
export const REMOTE_ATTACHMENT_QUERY = "remoteAttachment";
type Connector = (client: WsBootstrapNegotiateInput, signal: AbortSignal) => Promise<DialedSession>;
interface DesiredConnection {
  readonly hostName: string;
  readonly connect: Connector;
  readonly lifetime: AbortController;
  readonly executionScope?: RemoteExecutionScope;
  resourceFactory?: (session: DialedSession) => Promise<RemoteResourcePool>;
  resource?: Promise<RemoteResourcePool> | undefined;
  state: HostConnectionState;
  failures: number;
  retryAt: number;
}
interface Attachment {
  readonly id: string;
  readonly hostId: string;
  readonly session: DialedSession;
  readonly timer: NodeJS.Timeout;
  readonly client?: WsBootstrapNegotiateInput;
  replacementFor?: string;
  local?: RelaySocket;
  detach?: () => void;
}
function closeCode(code: number): number {
  return [1005, 1006, 1015].includes(code) ? 1001 : code;
}
function frame(data: RawData, binary: boolean): string | Buffer {
  return binary
    ? Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data)
    : data.toString();
}

/** Desired host relationships outlive renderer streams; every HTTP negotiation
 * reserves a new authenticated RPC stream, consumed once by its renderer. */
export class HostConnectionRegistry {
  readonly #desired = new Map<string, DesiredConnection>();
  readonly #attachments = new Map<string, Attachment>();
  readonly #views = new Map<string, HostConnection>();
  readonly #listeners = new Set<() => void>();
  readonly #opening = new Map<string, number>();

  #lifecycleGeneration = 0;
  #accountBinding: string | undefined;
  get lifecycleGeneration(): number {
    return this.#lifecycleGeneration;
  }
  list(): readonly HostConnection[] {
    return [...this.#views.values()];
  }
  get(hostId: string): HostConnection | undefined {
    return this.#views.get(hostId);
  }
  status(hostId: string): { state: HostConnectionState; nextRetryAt?: string } {
    const desired = this.#desired.get(hostId);
    return {
      state: desired?.state ?? "stopped",
      ...(desired?.retryAt ? { nextRetryAt: new Date(desired.retryAt).toISOString() } : {}),
    };
  }
  /** Identity/lifetime fence also detects disconnect followed by re-pairing to the same environment. */
  connectionSignal(hostId: string): AbortSignal | undefined {
    return this.#desired.get(hostId)?.lifetime.signal;
  }
  hasConnector(hostId: string): boolean {
    return this.#desired.has(hostId);
  }
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  setConnector(
    hostId: string,
    hostName: string,
    connect: Connector,
    executionScope?: RemoteExecutionScope,
  ): void {
    if (this.#desired.has(hostId)) return;
    this.#desired.set(hostId, {
      hostName,
      connect,
      lifetime: new AbortController(),
      state: "connecting",
      failures: 0,
      retryAt: 0,
      ...(executionScope ? { executionScope } : {}),
    });
  }

  setResourceFactory(
    hostId: string,
    factory: (session: DialedSession) => Promise<RemoteResourcePool>,
  ): void {
    const desired = this.#desired.get(hostId);
    if (desired) desired.resourceFactory = factory;
  }
  async resourcePool(hostId: string): Promise<RemoteResourcePool> {
    const desired = this.#desired.get(hostId);
    if (
      !desired ||
      !desired.resourceFactory ||
      desired.lifetime.signal.aborted ||
      ["revoked", "incompatible", "needs-sign-in", "stopped"].includes(desired.state)
    )
      throw new Error("Remote resource connection is unavailable");
    if (desired.resource) {
      const previous = desired.resource;
      const pool = await previous;
      if (!pool.closed) return pool;
      if (desired.resource !== previous) return this.resourcePool(hostId);
      desired.resource = undefined;
    }
    const session = [...this.#attachments.values()].find(
      (item) =>
        item.hostId === hostId &&
        item.session.credentialExpiresAtSeconds * 1000 > Date.now() + 30_000,
    )?.session;
    if (!session) throw new Error("Open a fresh execution connection before requesting resources");
    const pending = desired.resourceFactory(session).then((pool) => {
      if (desired.lifetime.signal.aborted) {
        pool.close();
        throw new Error("Remote resource connection cancelled");
      }
      return pool;
    });
    desired.resource = pending;
    try {
      return await pending;
    } catch (error) {
      if (desired.resource === pending) desired.resource = undefined;
      throw error;
    }
  }
  async prepare(
    hostId: string,
    client: WsBootstrapNegotiateInput,
    signal?: AbortSignal,
  ): Promise<WsBootstrapNegotiateResult> {
    const desired = this.#desired.get(hostId);
    if (!desired) throw new Error("Connect to this host from the local controller first");
    if (["needs-sign-in", "revoked", "incompatible", "stopped"].includes(desired.state))
      throw new Error(`Remote connection requires attention: ${desired.state}`);
    if (desired.retryAt > Date.now())
      throw new Error("Remote reconnect is waiting for its retry deadline");
    const replacement = [...this.#attachments.values()].find(
      (entry) =>
        entry.hostId === hostId &&
        entry.replacementFor === JSON.stringify(client) &&
        entry.session.socket.readyState === WebSocket.OPEN,
    );
    if (replacement) {
      delete replacement.replacementFor;
      return { ...replacement.session.compatibility, remoteAttachmentId: replacement.id };
    }
    const opening = this.#opening.get(hostId) ?? 0;
    const count = [...this.#attachments.values()].filter((entry) => entry.hostId === hostId).length;
    if (
      opening + count >= 8 ||
      this.#attachments.size + [...this.#opening.values()].reduce((sum, value) => sum + value, 0) >=
        32
    )
      throw new Error("Remote renderer connection limit reached");
    this.#opening.set(hostId, opening + 1);
    try {
      const session = await desired.connect(
        client,
        signal ? AbortSignal.any([desired.lifetime.signal, signal]) : desired.lifetime.signal,
      );
      if (
        desired.lifetime.signal.aborted ||
        signal?.aborted ||
        this.#desired.get(hostId) !== desired
      ) {
        session.socket.terminate();
        throw new Error("Remote connection cancelled");
      }
      desired.state = "connected";
      desired.failures = 0;
      desired.retryAt = 0;
      const id = this.add({ hostId, hostName: desired.hostName, session, client });
      return { ...session.compatibility, remoteAttachmentId: id };
    } catch (error) {
      if (this.#desired.get(hostId) === desired && !desired.lifetime.signal.aborted) {
        desired.state = classifyConnectionFailure(error);
        if (desired.state !== "reconnecting")
          void desired.resource?.then(
            (pool) => pool.close(),
            () => {},
          );
        desired.failures++;
        desired.retryAt =
          desired.state === "reconnecting"
            ? Date.now() + Math.min(30_000, 500 * 2 ** Math.min(desired.failures, 6))
            : 0;
        const view = this.#views.get(hostId);
        if (view) this.#views.set(hostId, { ...view, state: desired.state });
        this.notify();
      }
      throw error;
    } finally {
      const remaining = (this.#opening.get(hostId) ?? 1) - 1;
      if (remaining > 0) this.#opening.set(hostId, remaining);
      else this.#opening.delete(hostId);
    }
  }

  /** A tool owns its own authenticated stream, never a renderer's mutable selection. */
  async call(
    hostId: string,
    client: WsBootstrapNegotiateInput,
    tag: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const ready = await this.prepare(hostId, client, signal);
    const id = ready.remoteAttachmentId;
    const entry = id ? this.#attachments.get(id) : undefined;
    if (!entry) throw new Error("Remote tool connection is unavailable");
    clearTimeout(entry.timer);
    try {
      return await remoteUnaryRpc(entry.session.socket, tag, payload, signal);
    } finally {
      this.closeAttachment(entry.id, 1000, "Tool call finished");
    }
  }

  /** A reachability check must not occupy an unused renderer lease for 30s. */
  async probe(hostId: string, client: WsBootstrapNegotiateInput): Promise<void> {
    const result = await this.prepare(hostId, client);
    if (result.remoteAttachmentId)
      this.closeAttachment(result.remoteAttachmentId, 1000, "Connection verified");
  }

  /** Records a stream, never making it reusable after a local detach. */
  add(input: {
    readonly hostId: string;
    readonly hostName: string;
    readonly session: DialedSession;
    readonly client?: WsBootstrapNegotiateInput;
  }): string {
    const id = randomUUID();
    // Prepared but abandoned navigations cannot hold host leases indefinitely.
    const timer = setTimeout(
      () => this.closeAttachment(id, 1001, "Renderer did not attach"),
      30_000,
    );
    timer.unref();
    const entry: Attachment = {
      id,
      hostId: input.hostId,
      session: input.session,
      timer,
      ...(input.client ? { client: input.client } : {}),
    };
    this.#attachments.set(id, entry);
    input.session.socket.once("close", (code, reason) =>
      this.closeAttachment(id, closeCode(code), reason.toString()),
    );
    this.#views.set(input.hostId, {
      hostId: input.hostId,
      hostName: input.hostName,
      transport: input.session.transport,
      startedAt: new Date().toISOString(),
      credentialExpiresAt: new Date(input.session.credentialExpiresAtSeconds * 1000).toISOString(),
      wsPath: `${HOST_CONNECTION_WS_PATH_PREFIX}${encodeURIComponent(input.hostId)}`,
      ...(this.#desired.get(input.hostId)?.executionScope
        ? { executionScope: this.#desired.get(input.hostId)!.executionScope! }
        : {}),
      state: "connected",
      environmentId: input.session.environmentId,
    });
    this.notify();
    return id;
  }

  attach(
    hostId: string,
    id: string,
    local: RelaySocket,
    expectedInstanceId: string | null,
  ): boolean {
    const entry = this.#attachments.get(id);
    if (
      !entry ||
      entry.hostId !== hostId ||
      entry.session.compatibility.serverInstanceId !== expectedInstanceId
    ) {
      local.close(4404, "Remote stream negotiation expired");
      return false;
    }
    if (entry.local) {
      local.close(4409, "Remote stream already attached");
      return false;
    }
    const remote = entry.session.socket;
    if (remote.readyState !== WebSocket.OPEN || local.readyState !== WebSocket.OPEN) {
      this.closeAttachment(id, 1001, "Remote stream closed");
      return false;
    }
    clearTimeout(entry.timer);
    const toRemote = (data: RawData, binary: boolean) => {
      if (remote.readyState === WebSocket.OPEN) sendBoundedRelayFrame(remote, frame(data, binary));
    };
    const toLocal = (data: RawData, binary: boolean) => {
      if (local.readyState === WebSocket.OPEN) sendBoundedRelayFrame(local, frame(data, binary));
    };
    const localClosed = () => this.closeAttachment(id, 1000, "Renderer detached");
    // Renewal replaces the stream and forces resubscription. In-flight commands
    // fail with an uncertain outcome; nothing in this layer replays their bytes.
    const renewal = setTimeout(
      () => {
        void this.replaceAuthorization(entry);
      },
      Math.max(1, entry.session.credentialExpiresAtSeconds * 1000 - Date.now() - 45_000),
    );
    renewal.unref();
    entry.local = local;
    entry.detach = () => {
      clearTimeout(renewal);
      local.off("message", toRemote);
      local.off("close", localClosed);
      remote.off("message", toLocal);
    };
    local.on("message", toRemote);
    local.on("close", localClosed);
    remote.on("message", toLocal);
    return true;
  }

  private async replaceAuthorization(entry: Attachment): Promise<void> {
    if (!entry.client || !this.#attachments.has(entry.id)) return;
    // Prepare a completely fresh RPC stream while the previous presentation is
    // still usable. The renderer must negotiate again before consuming it.
    try {
      const ready = await this.prepare(entry.hostId, entry.client);
      const replacement = ready.remoteAttachmentId
        ? this.#attachments.get(ready.remoteAttachmentId)
        : undefined;
      if (replacement) {
        if (!this.#attachments.has(entry.id))
          this.closeAttachment(replacement.id, 1000, "Renderer detached during renewal");
        else replacement.replacementFor = JSON.stringify(entry.client);
      }
    } catch {
      /* The reconnect path classifies the failure; no command is replayed. */
    } finally {
      this.closeAttachment(entry.id, 1012, "Renewing remote authorization");
    }
  }

  remove(hostId: string, code = 1000, reason = "disconnected"): boolean {
    const existed = this.#desired.has(hostId) || this.#views.has(hostId);
    const desired = this.#desired.get(hostId);
    desired?.lifetime.abort();
    void desired?.resource?.then(
      (pool) => pool.close(),
      () => {},
    );
    this.#desired.delete(hostId);
    for (const entry of [...this.#attachments.values()])
      if (entry.hostId === hostId) this.closeAttachment(entry.id, code, reason);
    this.#views.delete(hostId);
    this.notify();
    return existed;
  }
  invalidateAccount(
    binding:
      | Pick<RemoteExecutionScope, "accountAuthority" | "userId" | "organizationId">
      | undefined,
  ): void {
    const nextBinding = JSON.stringify(binding ?? null);
    if (nextBinding !== this.#accountBinding) {
      this.#accountBinding = nextBinding;
      this.#lifecycleGeneration++;
    }
    for (const [hostId, desired] of this.#desired) {
      const scope = desired.executionScope;
      if (
        scope &&
        (!binding ||
          scope.accountAuthority !== binding.accountAuthority ||
          scope.userId !== binding.userId ||
          scope.organizationId !== binding.organizationId)
      )
        this.remove(hostId, 4403, "Controller account changed");
    }
  }
  closeAll(): void {
    this.#lifecycleGeneration++;
    for (const hostId of new Set([...this.#desired.keys(), ...this.#views.keys()]))
      this.remove(hostId, 1001, "shutting down");
  }
  private closeAttachment(id: string, code: number, reason: string): void {
    const entry = this.#attachments.get(id);
    if (!entry) return;
    this.#attachments.delete(id);
    clearTimeout(entry.timer);
    entry.detach?.();
    if (code === 4503 || code === 4403 || code === 1008)
      void this.#desired.get(entry.hostId)?.resource?.then(
        (pool) => pool.close(),
        () => {},
      );
    if (entry.local?.readyState === WebSocket.OPEN) entry.local.close(closeCode(code), reason);
    if (entry.session.socket.readyState === WebSocket.OPEN)
      entry.session.socket.close(closeCode(code), reason);
    if (![...this.#attachments.values()].some((item) => item.hostId === entry.hostId)) {
      const view = this.#views.get(entry.hostId);
      const desired = this.#desired.get(entry.hostId);
      if (view && desired) {
        if (!["revoked", "incompatible", "needs-sign-in", "stopped"].includes(desired.state)) {
          desired.state =
            code === 4503 || code === 4403 || code === 1008
              ? "revoked"
              : code === 1000 || code === 1001
                ? "idle"
                : "reconnecting";
        }
        this.#views.set(entry.hostId, { ...view, state: desired.state });
      } else this.#views.delete(entry.hostId);
    }
    this.notify();
  }
  private notify(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        /* bookkeeping survives observers */
      }
    }
  }
}
export class HostConnectionRegistryService extends ServiceMap.Service<
  HostConnectionRegistryService,
  HostConnectionRegistry
>()("synara/HostConnectionRegistry") {}
export const HostConnectionRegistryLive = Layer.effect(
  HostConnectionRegistryService,
  Effect.gen(function* () {
    const registry = new HostConnectionRegistry();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.closeAll()));
    return registry;
  }),
);
