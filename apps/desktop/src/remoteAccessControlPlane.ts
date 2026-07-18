// FILE: remoteAccessControlPlane.ts
// Purpose: Keeps the desktop owner credential in main-process memory and calls auth control APIs.
// Layer: Desktop main-process integration

export interface DesktopPairingLink {
  readonly id: string;
  readonly credential: string;
  readonly pairingUrl: string;
  readonly expiresAt: string;
}

export interface DesktopPairedDevice {
  readonly sessionId: string;
  readonly subject: string;
  readonly role: string;
  readonly accessProfile: string;
  readonly label: string | null;
  readonly deviceType: string;
  readonly os: string | null;
  readonly browser: string | null;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
}

export interface RemoteConnectionTestResult {
  readonly reachable: boolean;
  readonly status: number | null;
  readonly message: string;
}

export class RemoteAccessControlPlaneError extends Error {
  override readonly name = "RemoteAccessControlPlaneError";
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

interface OwnerContext {
  readonly backendHttpUrl: string;
  readonly bootstrapCredential: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function safeServerError(payload: unknown, fallback: string): string {
  if (isPlainRecord(payload) && typeof payload.error === "string") {
    const message = payload.error.trim();
    if (message.length > 0 && message.length <= 300) return message;
  }
  return fallback;
}

export class DesktopRemoteAccessControlPlane {
  private context: OwnerContext | null = null;
  private ownerBearerToken: string | null = null;
  private bootstrapInFlight: Promise<string> | null = null;
  private contextGeneration = 0;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  configure(context: OwnerContext): void {
    const changed =
      this.context?.backendHttpUrl !== context.backendHttpUrl ||
      this.context?.bootstrapCredential !== context.bootstrapCredential;
    this.context = context;
    if (changed) {
      this.resetOwnerSession();
    }
  }

  clear(): void {
    this.context = null;
    this.resetOwnerSession();
  }

  /** Invalidates in-memory owner auth before a newly spawned backend becomes ready. */
  resetOwnerSession(): void {
    this.contextGeneration += 1;
    this.ownerBearerToken = null;
    this.bootstrapInFlight = null;
  }

  /**
   * Eagerly exchanges the process-local desktop bootstrap credential without
   * exposing the resulting owner bearer token outside this main-process object.
   * Normal requests still call the same initializer as a retry fallback.
   */
  async initializeOwnerSession(): Promise<void> {
    await this.bootstrapOwnerSession();
  }

  private async bootstrapOwnerSession(): Promise<string> {
    if (this.ownerBearerToken) return this.ownerBearerToken;
    if (this.bootstrapInFlight) return this.bootstrapInFlight;
    const context = this.context;
    if (!context) {
      throw new RemoteAccessControlPlaneError("The Synara backend is not ready.");
    }
    const contextGeneration = this.contextGeneration;

    const bootstrap = (async () => {
      let response: Response;
      try {
        response = await this.fetchImpl(`${context.backendHttpUrl}/api/auth/bootstrap/bearer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ credential: context.bootstrapCredential }),
        });
      } catch {
        throw new RemoteAccessControlPlaneError("Could not reach the Synara backend.");
      }
      const payload = await readResponseJson(response);
      if (!response.ok || !isPlainRecord(payload)) {
        throw new RemoteAccessControlPlaneError(
          safeServerError(payload, "Desktop owner authentication is not available yet."),
          response.status,
        );
      }
      const token = readString(payload, "sessionToken");
      if (!token) {
        throw new RemoteAccessControlPlaneError(
          "The Synara backend returned an invalid owner session.",
          response.status,
        );
      }
      if (this.contextGeneration !== contextGeneration) {
        throw new RemoteAccessControlPlaneError(
          "The Synara backend changed while owner authentication was initializing.",
        );
      }
      this.ownerBearerToken = token;
      return token;
    });
    const trackedBootstrap = bootstrap().finally(() => {
      if (this.bootstrapInFlight === trackedBootstrap) {
        this.bootstrapInFlight = null;
      }
    });
    this.bootstrapInFlight = trackedBootstrap;
    return trackedBootstrap;
  }

  private async request(
    pathname: string,
    init: RequestInit = {},
    retryAuthentication = true,
  ): Promise<unknown> {
    const context = this.context;
    if (!context) {
      throw new RemoteAccessControlPlaneError("The Synara backend is not ready.");
    }
    const token = await this.bootstrapOwnerSession();
    let response: Response;
    try {
      response = await this.fetchImpl(`${context.backendHttpUrl}${pathname}`, {
        ...init,
        headers: {
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new RemoteAccessControlPlaneError("Could not reach the Synara backend.");
    }
    const payload = await readResponseJson(response);
    if (response.status === 401 && retryAuthentication) {
      this.ownerBearerToken = null;
      return this.request(pathname, init, false);
    }
    if (!response.ok) {
      throw new RemoteAccessControlPlaneError(
        safeServerError(payload, `Synara control request failed (${response.status}).`),
        response.status,
      );
    }
    return payload;
  }

  async createPairingLink(input: {
    readonly trustedOrigin: string | null;
    readonly privateRouteVerified: boolean;
    readonly label?: string;
  }): Promise<DesktopPairingLink> {
    if (input.privateRouteVerified !== true) {
      throw new RemoteAccessControlPlaneError(
        "Verify the private Tailscale Serve route before pairing a device.",
      );
    }
    if (!input.trustedOrigin) {
      throw new RemoteAccessControlPlaneError(
        "Verify and save the Tailnet HTTPS origin before pairing a device.",
      );
    }
    const payload = await this.request("/api/auth/pairing-token", {
      method: "POST",
      body: JSON.stringify({
        accessProfile: "companion",
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      }),
    });
    if (!isPlainRecord(payload)) {
      throw new RemoteAccessControlPlaneError("The backend returned an invalid pairing link.");
    }
    const id = readString(payload, "id");
    const credential = readString(payload, "credential");
    const expiresAt = readString(payload, "expiresAt");
    if (!id || !credential || !expiresAt) {
      throw new RemoteAccessControlPlaneError("The backend returned an invalid pairing link.");
    }
    return {
      id,
      credential,
      expiresAt,
      pairingUrl: `${input.trustedOrigin}/mobile/pair#token=${encodeURIComponent(credential)}`,
    };
  }

  async listDevices(): Promise<ReadonlyArray<DesktopPairedDevice>> {
    const payload = await this.request("/api/auth/clients", { method: "GET" });
    if (!Array.isArray(payload)) {
      throw new RemoteAccessControlPlaneError("The backend returned an invalid device list.");
    }
    return payload.flatMap((entry): DesktopPairedDevice[] => {
      if (!isPlainRecord(entry) || !isPlainRecord(entry.client)) return [];
      const sessionId = readString(entry, "sessionId");
      const subject = readString(entry, "subject");
      const issuedAt = readString(entry, "issuedAt");
      const expiresAt = readString(entry, "expiresAt");
      if (!sessionId || !subject || !issuedAt || !expiresAt) return [];
      return [
        {
          sessionId,
          subject,
          role: readString(entry, "role") ?? "client",
          accessProfile: readString(entry, "accessProfile") ?? "companion",
          label: readString(entry.client, "label"),
          deviceType: readString(entry.client, "deviceType") ?? "unknown",
          os: readString(entry.client, "os"),
          browser: readString(entry.client, "browser"),
          issuedAt,
          expiresAt,
          lastConnectedAt: readString(entry, "lastConnectedAt"),
          connected: entry.connected === true,
        },
      ];
    });
  }

  async revokeDevice(sessionId: string): Promise<boolean> {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      throw new RemoteAccessControlPlaneError("Missing device session id.");
    }
    const payload = await this.request("/api/auth/clients/revoke", {
      method: "POST",
      body: JSON.stringify({ sessionId: sessionId.trim() }),
    });
    return isPlainRecord(payload) && payload.revoked === true;
  }

  async revokeAllDevices(): Promise<number> {
    const payload = await this.request("/api/auth/clients/revoke-companion", { method: "POST" });
    return isPlainRecord(payload) &&
      typeof payload.revokedCount === "number" &&
      Number.isInteger(payload.revokedCount)
      ? payload.revokedCount
      : 0;
  }
}

export async function testRemoteCompanionConnection(
  trustedOrigin: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteConnectionTestResult> {
  if (!trustedOrigin) {
    return {
      reachable: false,
      status: null,
      message: "Save the verified Tailnet HTTPS origin first.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7_500);
  try {
    const response = await fetchImpl(`${trustedOrigin}/api/companion/v1/info`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        reachable: false,
        status: response.status,
        message: `The Tailnet URL responded with HTTP ${response.status}.`,
      };
    }
    const payload = await readResponseJson(response);
    if (
      !isPlainRecord(payload) ||
      payload.enabled !== true ||
      payload.protocolVersion !== 1 ||
      !readString(payload, "serverVersion")
    ) {
      return {
        reachable: false,
        status: response.status,
        message: "The Tailnet URL did not return a valid enabled Synara Companion service.",
      };
    }
    return { reachable: true, status: response.status, message: "Synara is reachable over HTTPS." };
  } catch {
    return {
      reachable: false,
      status: null,
      message: "Could not reach Synara through the configured Tailnet URL.",
    };
  } finally {
    clearTimeout(timeout);
  }
}
