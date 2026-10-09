import {
  HOST_SESSION_CLOSE_REVOKED,
  type HostAuthorizationSnapshot,
  type HostSession,
} from "@synara/contracts";
import { Layer, ServiceMap } from "effect";

export interface RemoteSession {
  readonly id: string;
  readonly userId: string;
  readonly deviceJkt: string;
  readonly startedAt: string;
  readonly expiresAtSeconds: number;
  readonly via: "direct" | "relay" | "cloudflare" | "ssh-forward";
  readonly close: (code: number, reason: string) => void;
}

export const REMOTE_SESSION_REVOKED_CLOSE_CODE = HOST_SESSION_CLOSE_REVOKED;

export class RemoteSessionRegistry {
  readonly #sessions = new Map<string, RemoteSession>();

  add(session: RemoteSession): () => void {
    this.#sessions.set(session.id, session);
    return () => this.#sessions.delete(session.id);
  }

  get size(): number {
    return this.#sessions.size;
  }

  list(): readonly HostSession[] {
    return [...this.#sessions.values()]
      .map(({ id, userId, deviceJkt, via, startedAt }) => ({
        id,
        userId,
        deviceJkt,
        transport: via,
        startedAt,
      }))
      .toSorted((left, right) => left.startedAt.localeCompare(right.startedAt));
  }

  end(sessionId: string): boolean {
    const session = this.#sessions.get(sessionId);
    if (!session) return false;
    this.#sessions.delete(sessionId);
    session.close(REMOTE_SESSION_REVOKED_CLOSE_CODE, "ended by host owner");
    return true;
  }

  private dropWhere(predicate: (session: RemoteSession) => boolean, reason: string): void {
    for (const session of this.#sessions.values()) {
      if (!predicate(session)) continue;
      this.#sessions.delete(session.id);
      session.close(REMOTE_SESSION_REVOKED_CLOSE_CODE, reason);
    }
  }

  async reverify(authorization: HostAuthorizationSnapshot): Promise<void> {
    // The current account snapshot closes live sessions. Durable device trust
    // owns admission of every new connection, including after a restart.
    if (authorization.revokedDeviceJkts.length > 0) {
      const revoked = new Set(authorization.revokedDeviceJkts);
      this.dropWhere((session) => revoked.has(session.deviceJkt), "device revoked");
    }
    if (!authorization.discoverable || !authorization.ownerInOrg) {
      this.dropWhere(
        (session) => session.userId !== authorization.ownerUserId,
        "host authorization changed",
      );
    }
  }

  closeDevice(deviceJkt: string): void {
    this.dropWhere((session) => session.deviceJkt === deviceJkt, "device revoked on host");
  }

  closeAll(reason = "host connectivity stopped"): void {
    this.dropWhere(() => true, reason);
  }

  dropExpired(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    this.dropWhere((session) => session.expiresAtSeconds <= nowSeconds, "credential expired");
  }
}

/** One registry per server process, shared by host connectivity and owner RPCs. */
export class RemoteSessionRegistryService extends ServiceMap.Service<
  RemoteSessionRegistryService,
  RemoteSessionRegistry
>()("synara/RemoteSessionRegistry") {}

export const RemoteSessionRegistryLive = Layer.sync(
  RemoteSessionRegistryService,
  () => new RemoteSessionRegistry(),
);
