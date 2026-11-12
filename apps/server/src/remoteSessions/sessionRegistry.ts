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

interface GlobalBillingPolicy {
  readonly authority: string;
  readonly enforced: () => boolean;
  /** Brings an idle policy up to its polling freshness; never rejects. */
  readonly ensureFresh?: () => Promise<void>;
}

interface AdmissionGuard {
  readonly authority?: string;
  readonly available: () => boolean;
  /** Fetches an authorization snapshot when the last one is older than its poll; never rejects. */
  readonly prepare?: () => Promise<void>;
}

export class RemoteSessionRegistry {
  readonly #sessions = new Map<string, RemoteSession>();
  readonly #legacyConnections = new Set<() => void>();
  readonly #openedListeners = new Set<() => void>();
  #remoteBillingEnforced = false;
  #billingPolicyRevision = 0;
  #globalBillingPolicy: GlobalBillingPolicy | undefined;
  #admissionGuard: AdmissionGuard | undefined;

  /** Only authenticated account snapshots/refusals establish this policy. */
  setRemoteBillingEnforced(enforced: boolean): void {
    // New proof must fence older responses even when its boolean value is unchanged.
    this.#billingPolicyRevision += 1;
    this.#remoteBillingEnforced = enforced;
  }

  get remoteBillingEnforced(): boolean {
    return this.#remoteBillingEnforced || this.#globalBillingPolicy?.enforced() === true;
  }

  get billingPolicyRevision(): number {
    return this.#billingPolicyRevision;
  }

  /** The deployment policy remains independent of a user's account/host credentials. */
  registerGlobalBillingPolicy(policy: GlobalBillingPolicy): () => void {
    this.#globalBillingPolicy = policy;
    return () => {
      if (this.#globalBillingPolicy !== policy) return;
      const enforced = this.remoteBillingEnforced;
      this.#globalBillingPolicy = undefined;
      if (enforced) {
        this.setRemoteBillingEnforced(true);
        this.closeAll("Remote authorization unavailable");
      }
    };
  }

  registerAdmissionGuard(guard: AdmissionGuard): () => void {
    this.#admissionGuard = guard;
    return () => {
      if (this.#admissionGuard !== guard) return;
      this.#admissionGuard = undefined;
      if (this.remoteBillingEnforced) this.closeLegacyConnections();
    };
  }

  /** Open sessions or legacy sockets: what a policy change or revocation must reach in time. */
  get remoteConnectionsOpen(): boolean {
    return this.#sessions.size > 0 || this.#legacyConnections.size > 0;
  }

  /** Runs on every session or legacy socket registration; returns the unsubscribe. */
  onRemoteConnectionOpened(listener: () => void): () => void {
    this.#openedListeners.add(listener);
    return () => this.#openedListeners.delete(listener);
  }

  /** Await before a decision that reads only the billing policy; it never rejects. */
  async prepareBillingPolicy(): Promise<void> {
    await this.#globalBillingPolicy?.ensureFresh?.();
  }

  /**
   * Await before admitting a remote session or socket; it never rejects. A
   * fresh authorization snapshot also refreshes the billing policy it carries.
   */
  async prepareRemoteAdmission(): Promise<void> {
    await this.#admissionGuard?.prepare?.();
    await this.#globalBillingPolicy?.ensureFresh?.();
  }

  #connectionOpened(): void {
    for (const listener of this.#openedListeners) {
      try {
        listener();
      } catch {
        /* Bookkeeping survives observers. */
      }
    }
  }

  canAdmitRemoteSession(): boolean {
    return (
      !this.remoteBillingEnforced ||
      (this.#admissionGuard?.available() === true &&
        (!this.#globalBillingPolicy ||
          this.#admissionGuard.authority === this.#globalBillingPolicy.authority))
    );
  }

  /** Legacy sockets have no device thumbprint; never fabricate one for accounting. */
  registerLegacyConnection(close: () => void): (() => void) | undefined {
    if (!this.canAdmitRemoteSession()) return undefined;
    this.#legacyConnections.add(close);
    this.#connectionOpened();
    return () => this.#legacyConnections.delete(close);
  }

  private closeLegacyConnections(): void {
    for (const close of this.#legacyConnections) {
      this.#legacyConnections.delete(close);
      close();
    }
  }

  add(session: RemoteSession): () => void {
    this.#sessions.set(session.id, session);
    this.#connectionOpened();
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

  private dropWhere(
    predicate: (session: RemoteSession) => boolean,
    reason: string,
    code: number = REMOTE_SESSION_REVOKED_CLOSE_CODE,
  ): void {
    for (const session of this.#sessions.values()) {
      if (!predicate(session)) continue;
      this.#sessions.delete(session.id);
      session.close(code, reason);
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

  // A service interruption needs a fresh authenticated session, not new device trust.
  // Definitive scope retirement explicitly retains the revocation close code.
  closeAll(
    reason = "host connectivity stopped",
    code: 1012 | typeof REMOTE_SESSION_REVOKED_CLOSE_CODE = 1012,
  ): void {
    this.dropWhere(() => true, reason, code);
    if (this.remoteBillingEnforced) this.closeLegacyConnections();
  }

  dropExpired(nowSeconds = Math.floor(Date.now() / 1_000)): void {
    this.dropWhere((session) => session.expiresAtSeconds <= nowSeconds, "credential expired", 1012);
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
