// FILE: runtime.ts
// Purpose: Owns connector state: the persisted document, pending sign-ins, token
//   refresh, and per-request proxying. Wrapped by the McpConnectors Effect layer.
// Layer: Connectors runtime (promise-based)
// Exports: McpConnectorRuntime, McpConnectorFailure, decodeConnectorsDocument,
//   encodeConnectorsDocument

import { randomBytes, randomUUID } from "node:crypto";
import { Schema } from "effect";

import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE,
  McpConnectorProposal,
  McpConnectorConnectInput as ConnectInputSchema,
  type McpConnectorResolveProposalInput,
  type McpConnectorResolveProposalResult,
  McpConnector,
  type McpConnectorConnectInput,
  type McpConnectorConnectResult,
} from "@synara/contracts";
import {
  defaultMcpConnectorName,
  findMcpConnectorPreset,
  MCP_CONNECTOR_PRESETS,
  type McpConnectorPreset,
  mcpConnectorServerName,
  mcpConnectorSlug,
  normalizeMcpConnectorUrl,
} from "@synara/shared/mcpConnectors";

import type { AgentGatewayConnectorRegistration } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { normalizeConnectorInput } from "./config.ts";
import { StdioConnectorSessions } from "./stdio.ts";
import {
  type ConnectorAuthorizationState,
  connectorOAuthFetch,
  isOAuthGrantFailure,
  loadMcpAuth,
  makeConnectorOAuthProvider,
  revokeConnectorTokens,
  tokenExpiryMs,
} from "./oauth.ts";
import {
  forwardMcpConnectorRequest,
  jsonRpcErrorResult,
  jsonRpcRequestIds,
  type McpConnectorProxyResult,
  probeMcpConnector,
} from "./proxy.ts";

export const MCP_CONNECTORS_MAX_COUNT = 30;
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;
const MAX_PENDING_AUTHORIZATIONS = 16;
// Refresh a little early so a token does not expire between check and use.
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

/** A failure whose message is written for the person connecting. */
export class McpConnectorFailure extends Error {
  override readonly name = "McpConnectorFailure";

  constructor(
    message: string,
    /** Machine-readable reason the UI acts on, e.g. asking for an OAuth app. */
    readonly code?: string,
  ) {
    super(message);
  }
}

class McpConnectorNeedsAuth extends Error {
  override readonly name = "McpConnectorNeedsAuth";
}

interface StoredConnectorOAuth {
  readonly clientInformation: OAuthClientInformationMixed;
  readonly tokens: OAuthTokens;
  readonly expiresAtMs: number | null;
  readonly discovery: OAuthDiscoveryState;
  /** RFC 8707 resource indicator chosen at sign-in, reused on refresh. */
  readonly resource: string | null;
  /** The client is the user's own OAuth app (Slack, Google), reused on reconnect. */
  readonly userClient: boolean;
}

interface StoredConnector {
  readonly connectorId: string;
  readonly presetId: string | null;
  readonly name: string;
  readonly url: string;
  readonly serverName: string;
  readonly authKind: "oauth" | "none";
  readonly status: "connected" | "unreachable" | "needs-auth";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly oauth: StoredConnectorOAuth | null;
}

type StoredStdioConnector = Extract<McpConnector, { transport: "stdio" }> & {
  readonly env?: Readonly<Record<string, string>> | undefined;
};
interface StoredProposal {
  readonly proposal: McpConnectorProposal;
  readonly input?: McpConnectorConnectInput | undefined;
}

interface ConnectorsDocument {
  readonly version: 1;
  readonly connectors: ReadonlyArray<StoredConnector>;
  readonly stdio: ReadonlyArray<StoredStdioConnector>;
  readonly proposals: ReadonlyArray<StoredProposal>;
  /** Saved entries this build cannot read; written back untouched. */
  readonly unreadable: ReadonlyArray<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeOAuth(value: unknown): StoredConnectorOAuth | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  const { clientInformation, tokens, discovery } = value;
  if (
    !isRecord(clientInformation) ||
    typeof clientInformation.client_id !== "string" ||
    !isRecord(tokens) ||
    typeof tokens.access_token !== "string" ||
    !isRecord(discovery) ||
    typeof discovery.authorizationServerUrl !== "string"
  ) {
    return undefined;
  }
  return {
    clientInformation: clientInformation as OAuthClientInformationMixed,
    tokens: tokens as OAuthTokens,
    expiresAtMs: typeof value.expiresAtMs === "number" ? value.expiresAtMs : null,
    discovery: discovery as unknown as OAuthDiscoveryState,
    resource: typeof value.resource === "string" ? value.resource : null,
    userClient: value.userClient === true,
  };
}

function decodeConnector(value: unknown): StoredConnector | undefined {
  if (!isRecord(value)) return undefined;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "");
  const oauth = decodeOAuth(value.oauth ?? null);
  const authKind = value.authKind === "oauth" || value.authKind === "none" ? value.authKind : null;
  const status =
    value.status === "connected" || value.status === "needs-auth" || value.status === "unreachable"
      ? value.status
      : null;
  if (
    !text("connectorId") ||
    !text("name") ||
    !normalizeMcpConnectorUrl(text("url")).ok ||
    !text("serverName") ||
    !text("createdAt") ||
    !text("updatedAt") ||
    authKind === null ||
    status === null ||
    oauth === undefined ||
    (authKind === "oauth") !== (oauth !== null)
  ) {
    return undefined;
  }
  return {
    connectorId: text("connectorId"),
    presetId: typeof value.presetId === "string" ? value.presetId : null,
    name: text("name"),
    url: text("url"),
    serverName: text("serverName"),
    authKind,
    status,
    createdAt: text("createdAt"),
    updatedAt: text("updatedAt"),
    oauth,
  };
}

const EMPTY_DOCUMENT: ConnectorsDocument = {
  version: 1,
  connectors: [],
  stdio: [],
  proposals: [],
  unreadable: [],
};

/**
 * Reads the stored document. Entries this build cannot read are kept aside
 * and saved back as they were, so one bad entry never erases itself.
 */
export function decodeConnectorsDocument(raw: string | null): ConnectorsDocument {
  if (!raw) return EMPTY_DOCUMENT;
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.connectors)) {
    throw new Error("Unrecognized connectors document.");
  }
  const connectors: StoredConnector[] = [];
  const stdio: StoredStdioConnector[] = [];
  const unreadable: unknown[] = [];
  for (const entry of parsed.connectors) {
    if (isRecord(entry) && entry.transport === "stdio") {
      try {
        const input = normalizeConnectorInput({
          name: entry.name,
          command: entry.command,
          args: entry.args,
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...(entry.env ? { env: entry.env } : {}),
        });
        const publicEntry = Schema.decodeUnknownSync(McpConnector)(entry);
        if (publicEntry.transport === "stdio" && "command" in input)
          stdio.push({ ...publicEntry, ...(input.env ? { env: input.env } : {}) });
      } catch {
        unreadable.push(entry);
      }
      continue;
    }
    const connector = decodeConnector(entry);
    if (connector) connectors.push(connector);
    else unreadable.push(entry);
  }
  const proposals = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        proposal: McpConnectorProposal,
        input: Schema.optional(ConnectInputSchema),
      }),
    ),
  )(parsed.proposals ?? []);
  return { version: 1, connectors, stdio, proposals, unreadable };
}

export function encodeConnectorsDocument(document: ConnectorsDocument): string {
  return JSON.stringify({
    version: document.version,
    connectors: [...document.connectors, ...document.stdio, ...document.unreadable],
    proposals: document.proposals,
  });
}

function toContract(connector: StoredConnector): McpConnector {
  return {
    connectorId: connector.connectorId,
    presetId: connector.presetId,
    name: connector.name,
    url: connector.url,
    transport: new URL(connector.url).protocol === "http:" ? "local-http" : "remote-http",
    serverName: connector.serverName,
    authKind: connector.authKind,
    usesOwnOAuthApp: connector.oauth?.userClient === true,
    status: connector.status,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
  };
}

function publicStdio(connector: StoredStdioConnector): McpConnector {
  const { env: _env, ...safe } = connector;
  return safe;
}

interface ConnectorTarget {
  readonly presetId: string | null;
  readonly name: string;
  readonly url: string;
  readonly slug: string;
  readonly requiresOwnApp: boolean;
}

interface PendingAuthorization {
  readonly target: ConnectorTarget;
  readonly authorization: ConnectorAuthorizationState;
  readonly userClient: boolean;
  readonly createdAtMs: number;
  readonly existingConnectorId?: string;
  claimed?: boolean;
}

export type McpConnectorCallbackOutcome =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly title: string; readonly message: string };

export interface McpConnectorForwardRequest {
  /** Authenticated by the HTTP route, never accepted from JSON-RPC arguments. */
  readonly ownerToken?: string;
  readonly method: "POST" | "DELETE";
  readonly body?: unknown;
  readonly sessionId?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface McpConnectorRuntimeDeps {
  readonly ownerActive?: (token: string) => boolean;
  /** Raw stored document, or null when none was saved yet. */
  readonly load: () => Promise<string | null>;
  readonly save: (document: string) => Promise<void>;
  /** The OAuth redirect URL on this server's current port. */
  readonly redirectUrl: () => string;
  /** Hands the connected set to the agent gateway for new provider sessions. */
  readonly publish: (registrations: ReadonlyArray<AgentGatewayConnectorRegistration>) => void;
  readonly clientVersion: string;
  readonly logWarning: (message: string, fields?: Record<string, unknown>) => void;
  readonly now?: () => number;
}

const reconnectMessage = (name: string) =>
  `${name} needs to be reconnected. Ask the user to reconnect it in Synara under Settings → Connectors.`;

// Provider MCP clients read HTTP 401 as "sign in to this server" and would
// start OAuth against the gateway, so a lost sign-in answers each request
// with a JSON-RPC error and simply accepts notifications.
function reconnectResult(body: unknown, name: string): McpConnectorProxyResult {
  return jsonRpcRequestIds(body).length === 0
    ? { status: 202, sessionId: null, body: { kind: "empty" } }
    : jsonRpcErrorResult(body, reconnectMessage(name));
}

function presetTarget(preset: McpConnectorPreset): ConnectorTarget {
  return {
    presetId: preset.id,
    name: preset.name,
    url: preset.url,
    slug: preset.id,
    requiresOwnApp: preset.requiresOwnApp === true,
  };
}

const ownAppRequired = (name: string) =>
  new McpConnectorFailure(
    `${name} needs your own OAuth app. Enter its client ID and secret.`,
    MCP_CONNECTOR_CLIENT_REQUIRED_ERROR_CODE,
  );

function describeSignInStartError(name: string, error: unknown): McpConnectorFailure {
  const detail = error instanceof Error ? error.message : "";
  if (/dynamic client registration/iu.test(detail)) return ownAppRequired(name);
  if (/\b403\b/u.test(detail)) {
    return new McpConnectorFailure(
      `${name} did not let Synara register as an app (HTTP 403). It may only accept apps it has approved.`,
    );
  }
  return new McpConnectorFailure(`${name} did not accept Synara's sign-in request.`);
}

export class McpConnectorRuntime {
  private readonly stdio: StdioConnectorSessions;
  private readonly resolving = new Set<string>();
  private lastProbe = 0;
  private healthCheck: Promise<void> | undefined;
  private document: ConnectorsDocument = EMPTY_DOCUMENT;
  /** Set when the saved document could not be read: saving would erase it. */
  private loadFailed = false;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly refreshes = new Map<string, Promise<string>>();
  private writes: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly deps: McpConnectorRuntimeDeps) {
    this.now = deps.now ?? Date.now;
    this.stdio = new StdioConnectorSessions(deps.ownerActive ?? (() => false), (id, available) =>
      this.updateStdioStatus(id, available),
    );
  }

  async init(): Promise<void> {
    try {
      this.document = decodeConnectorsDocument(await this.deps.load());
    } catch {
      // Start empty rather than fail the server, but never save over the
      // document: it may be a newer version or a transient read failure.
      this.loadFailed = true;
      // Decoder errors may include private environment values from the document.
      this.deps.logWarning("Could not read saved connectors; starting with none.");
    }
    // A saved connected status is not evidence that a local server survived restart.
    this.document = {
      ...this.document,
      connectors: this.document.connectors.map((entry) =>
        entry.url.startsWith("http:") && entry.status === "connected"
          ? { ...entry, status: "unreachable" }
          : entry,
      ),
      stdio: this.document.stdio.map((entry) => ({ ...entry, status: "unreachable" })),
    };
    this.publish();
  }

  list(): McpConnector[] {
    return [...this.document.connectors.map(toContract), ...this.document.stdio.map(publicStdio)];
  }

  async connect(input: McpConnectorConnectInput): Promise<McpConnectorConnectResult> {
    try {
      input = normalizeConnectorInput(input);
    } catch (error) {
      throw new McpConnectorFailure(
        error instanceof Error ? error.message : "Invalid connector configuration.",
      );
    }
    if ("command" in input) return this.connectStdio(input);
    const target = this.resolveTarget(input);
    const existing = this.document.connectors.find((entry) => entry.url === target.url);
    if (!existing && this.list().length >= MCP_CONNECTORS_MAX_COUNT) {
      throw new McpConnectorFailure(
        `You can connect up to ${MCP_CONNECTORS_MAX_COUNT} connectors.`,
      );
    }

    const probe = await probeMcpConnector(target.url, target.name, this.deps.clientVersion);
    const local = new URL(target.url).protocol === "http:";
    if (probe.kind === "unavailable" && !local) throw new McpConnectorFailure(probe.message);
    if (probe.kind === "unavailable" && existing?.oauth) {
      await this.commit(() => ({
        ...this.document,
        connectors: this.document.connectors.map((entry) =>
          entry === existing ? { ...entry, status: "unreachable" } : entry,
        ),
      }));
      return {
        authorizationUrl: null,
        connector: toContract({ ...existing, status: "unreachable" }),
      };
    }
    if ((probe.kind === "open" || probe.kind === "unavailable") && !existing?.oauth) {
      let connector!: StoredConnector;
      await this.commit(() => {
        const upsert = this.withUpserted(
          target,
          null,
          probe.kind === "unavailable" ? "unreachable" : "connected",
        );
        connector = upsert.connector;
        return upsert.document;
      });
      return { authorizationUrl: null, connector: toContract(connector) };
    }

    this.prunePending();
    // The user's own app replaces dynamic registration; a reconnect reuses the
    // app the connector was first signed in with.
    const ownClient: OAuthClientInformationMixed | undefined = input.clientId
      ? {
          client_id: input.clientId,
          ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
        }
      : existing?.oauth?.userClient
        ? existing.oauth.clientInformation
        : undefined;
    if (target.requiresOwnApp && !ownClient) throw ownAppRequired(target.name);
    const authorization: ConnectorAuthorizationState = {
      redirectUrl: this.deps.redirectUrl(),
      state: randomBytes(32).toString("base64url"),
      ...(existing?.oauth ? { discovery: existing.oauth.discovery } : {}),
      ...(ownClient ? { clientInformation: ownClient } : {}),
    };
    const { auth } = await loadMcpAuth();
    // Vercel issues a refresh token only with offline_access. Preserve its
    // requested scopes so a saved connection can renew after the desktop restarts.
    const requestedScope = probe.kind === "oauth" ? probe.scope : undefined;
    const authorizationScope =
      new URL(target.url).origin === "https://mcp.vercel.com"
        ? [
            ...new Set([...(requestedScope?.trim() || "openid").split(/\s+/), "offline_access"]),
          ].join(" ")
        : requestedScope;
    let result: Awaited<ReturnType<typeof auth>>;
    try {
      result = await auth(makeConnectorOAuthProvider(authorization), {
        serverUrl: target.url,
        ...(authorizationScope ? { scope: authorizationScope } : {}),
        ...(probe.kind === "oauth" && probe.resourceMetadataUrl
          ? { resourceMetadataUrl: new URL(probe.resourceMetadataUrl) }
          : {}),
        fetchFn: (url, init) =>
          connectorOAuthFetch(url, init, local ? new URL(target.url).origin : undefined),
      });
    } catch (error) {
      this.deps.logWarning("Connector sign-in could not start.", {
        connector: target.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw describeSignInStartError(target.name, error);
    }
    if (result !== "REDIRECT" || !authorization.authorizationUrl) {
      throw new McpConnectorFailure(`${target.name} did not offer a sign-in page.`);
    }
    const authorizationUrl = authorization.authorizationUrl;
    if (
      authorizationUrl.protocol !== "https:" &&
      !(local && authorizationUrl.origin === new URL(target.url).origin)
    ) {
      throw new McpConnectorFailure(`${target.name} offered a sign-in page that is not HTTPS.`);
    }
    if (existing && this.find(existing.connectorId) === undefined) {
      throw new McpConnectorFailure("This connector was disconnected during sign-in.");
    }
    this.pending.set(authorization.state, {
      target,
      authorization,
      userClient: ownClient !== undefined,
      createdAtMs: this.now(),
      ...(existing ? { existingConnectorId: existing.connectorId } : {}),
    });
    return { authorizationUrl: authorizationUrl.href, connector: null };
  }

  async completeAuthorization(query: {
    readonly state: string | undefined;
    readonly code: string | undefined;
    readonly error: string | undefined;
    readonly errorDescription: string | undefined;
  }): Promise<McpConnectorCallbackOutcome> {
    const pending = query.state ? this.pending.get(query.state) : undefined;
    if (
      !pending ||
      pending.claimed ||
      this.now() - pending.createdAtMs > PENDING_AUTHORIZATION_TTL_MS
    ) {
      return {
        ok: false,
        title: "This sign-in link expired",
        message: "Start again from Synara under Settings → Connectors.",
      };
    }
    // Keep the claimed attempt reachable so Disconnect can fence an exchange
    // already awaiting the vendor; another callback cannot claim it twice.
    pending.claimed = true;
    try {
      const { target, authorization } = pending;
      if (query.error || !query.code) {
        const reason = query.errorDescription?.slice(0, 300) || query.error;
        return {
          ok: false,
          title: `${target.name} was not connected`,
          message: reason
            ? `${target.name} did not authorize Synara: ${reason}`
            : `${target.name} did not authorize Synara.`,
        };
      }

      const mcpAuth = await loadMcpAuth();
      const provider = makeConnectorOAuthProvider(authorization);
      try {
        await mcpAuth.auth(provider, {
          serverUrl: target.url,
          authorizationCode: query.code,
          fetchFn: (url, init) =>
            connectorOAuthFetch(
              url,
              init,
              new URL(target.url).protocol === "http:" ? new URL(target.url).origin : undefined,
            ),
        });
      } catch (error) {
        this.deps.logWarning("Connector token exchange failed.", {
          connector: target.name,
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          ok: false,
          title: `${target.name} was not connected`,
          message: `${target.name} did not issue access for Synara. Try connecting again.`,
        };
      }
      const { tokens, clientInformation, discovery } = authorization;
      if (!tokens || !clientInformation || !discovery) {
        return {
          ok: false,
          title: `${target.name} was not connected`,
          message: `${target.name} did not issue access for Synara. Try connecting again.`,
        };
      }
      // Concurrent sign-ins each passed the limit when they started.
      const isNew = !this.document.connectors.some((entry) => entry.url === target.url);
      if (isNew && this.list().length >= MCP_CONNECTORS_MAX_COUNT) {
        return {
          ok: false,
          title: `${target.name} was not connected`,
          message: `You can connect up to ${MCP_CONNECTORS_MAX_COUNT} connectors.`,
        };
      }
      const resource = await mcpAuth
        .selectResourceURL(target.url, provider, discovery.resourceMetadata)
        .catch(() => undefined);
      try {
        await this.commit(() => {
          if (
            this.pending.get(query.state!) !== pending ||
            (pending.existingConnectorId && !this.find(pending.existingConnectorId))
          ) {
            void revokeConnectorTokens({ discovery, clientInformation, tokens });
            throw new McpConnectorFailure("This sign-in was cancelled.");
          }
          return this.withUpserted(target, {
            clientInformation,
            tokens,
            expiresAtMs: tokenExpiryMs(tokens, this.now()),
            discovery,
            resource: resource?.href ?? null,
            userClient: pending.userClient,
          }).document;
        });
      } catch {
        return {
          ok: false,
          title: `${target.name} was not connected`,
          message: "Synara could not save the connection. Try again.",
        };
      }
      return { ok: true, name: target.name };
    } finally {
      if (this.pending.get(query.state!) === pending) this.pending.delete(query.state!);
    }
  }

  async disconnect(connectorId: string): Promise<boolean> {
    if (this.document.stdio.some((entry) => entry.connectorId === connectorId)) {
      // Stop owned processes before reporting removal; failed teardown remains retryable.
      await this.stdio.disconnect(connectorId);
      await this.commit(() => ({
        ...this.document,
        stdio: this.document.stdio.filter((entry) => entry.connectorId !== connectorId),
      }));
      return true;
    }
    const connector = this.find(connectorId);
    if (!connector) return false;
    for (const [state, pending] of this.pending) {
      if (pending.target.url === connector.url) this.pending.delete(state);
    }
    await this.commit(() => ({
      ...this.document,
      connectors: this.document.connectors.filter((entry) => entry.connectorId !== connectorId),
    }));
    // Revoke only once the removal is saved, so a failed save leaves it usable.
    const oauth = connector.oauth;
    if (oauth) {
      void revokeConnectorTokens({
        discovery: oauth.discovery,
        clientInformation: oauth.clientInformation,
        tokens: oauth.tokens,
      });
    }
    return true;
  }

  async forward(
    connectorId: string,
    request: McpConnectorForwardRequest,
  ): Promise<McpConnectorProxyResult> {
    const local = this.document.stdio.find((entry) => entry.connectorId === connectorId);
    if (local) return this.stdio.forward(connectorId, { ...local, env: local.env ?? {} }, request);
    const connector = this.find(connectorId);
    if (!connector) {
      return jsonRpcErrorResult(
        request.body,
        "This connector was disconnected in Synara. Its tools are no longer available.",
        404,
      );
    }
    if (connector.status === "needs-auth") return reconnectResult(request.body, connector.name);
    // The token the last request actually carried, which is the one a 401 rejected.
    let sentToken: string | undefined;
    const send = (accessToken: string | undefined) => {
      // Recheck ownership after token refresh: Disconnect or Reconnect may have finished.
      const current = this.find(connectorId);
      if (!current) {
        return Promise.resolve(
          jsonRpcErrorResult(
            request.body,
            "This connector was disconnected in Synara. Its tools are no longer available.",
            404,
          ),
        );
      }
      if (current.status === "needs-auth")
        return Promise.resolve(reconnectResult(request.body, current.name));
      sentToken = current.oauth?.tokens.access_token ?? accessToken;
      return forwardMcpConnectorRequest(
        {
          url: current.url,
          method: request.method,
          body: request.body,
          sessionId: request.sessionId,
          protocolVersion: request.protocolVersion,
          accessToken: sentToken,
          signal: request.signal,
        },
        current.name,
      );
    };
    if (connector.authKind === "none") {
      const result = await send(undefined);
      return result.status === 401 ? reconnectResult(request.body, connector.name) : result;
    }

    try {
      const first = await send(await this.accessToken(connectorId));
      if (first.status !== 401) return first;
      const retried = await send(await this.accessToken(connectorId, sentToken));
      if (retried.status !== 401) return retried;
      const current = this.find(connectorId)?.oauth;
      if (sentToken !== undefined && current?.tokens.access_token === sentToken) {
        await this.markNeedsAuth(connectorId, current);
      }
      return reconnectResult(request.body, connector.name);
    } catch (error) {
      if (error instanceof McpConnectorNeedsAuth) {
        return reconnectResult(request.body, connector.name);
      }
      this.deps.logWarning("Connector token refresh failed.", {
        connector: connector.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return jsonRpcErrorResult(
        request.body,
        `Synara could not refresh access to ${connector.name}. Try again shortly.`,
      );
    }
  }

  private find(connectorId: string): StoredConnector | undefined {
    return this.document.connectors.find((entry) => entry.connectorId === connectorId);
  }

  private resolveTarget(input: McpConnectorConnectInput): ConnectorTarget {
    if ("presetId" in input && "url" in input) {
      throw new McpConnectorFailure("Choose a connector or enter a URL, not both.");
    }
    if ("presetId" in input) {
      const preset = findMcpConnectorPreset(input.presetId);
      if (!preset) throw new McpConnectorFailure("This connector is not available.");
      return presetTarget(preset);
    }
    if (!("url" in input)) {
      throw new McpConnectorFailure("Choose a connector or enter a URL.");
    }
    const normalized = normalizeMcpConnectorUrl(input.url);
    if (!normalized.ok) throw new McpConnectorFailure(normalized.reason);
    const preset = MCP_CONNECTOR_PRESETS.find((entry) => entry.url === normalized.url);
    if (preset) return presetTarget(preset);
    const name = input.name?.trim() || defaultMcpConnectorName(normalized.url);
    return {
      presetId: null,
      name,
      url: normalized.url,
      slug: mcpConnectorSlug(name),
      requiresOwnApp: false,
    };
  }

  private uniqueServerName(slug: string): string {
    const taken = new Set(this.list().map((entry) => entry.serverName));
    let candidate = mcpConnectorServerName(slug);
    for (let suffix = 2; taken.has(candidate); suffix += 1) {
      candidate = mcpConnectorServerName(`${slug}_${suffix}`);
    }
    return candidate;
  }

  /** Creates or refreshes the connector for `target.url`; keeps its id and server name. */
  private withUpserted(
    target: ConnectorTarget,
    oauth: StoredConnectorOAuth | null,
    status: StoredConnector["status"] = "connected",
  ): { readonly document: ConnectorsDocument; readonly connector: StoredConnector } {
    const timestamp = new Date(this.now()).toISOString();
    const existing = this.document.connectors.find((entry) => entry.url === target.url);
    // A concurrent OAuth reconnect may have committed while the open probe ran.
    if (!oauth && existing?.oauth) return { document: this.document, connector: existing };
    if (!existing && this.list().length >= MCP_CONNECTORS_MAX_COUNT) {
      throw new McpConnectorFailure(
        `You can connect up to ${MCP_CONNECTORS_MAX_COUNT} connectors.`,
      );
    }
    const connector: StoredConnector = {
      connectorId: existing?.connectorId ?? `mcp_conn_${randomUUID()}`,
      presetId: target.presetId,
      name: target.name,
      url: target.url,
      serverName: existing?.serverName ?? this.uniqueServerName(target.slug),
      authKind: oauth ? "oauth" : "none",
      status,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      oauth,
    };
    return {
      connector,
      document: {
        ...this.document,
        connectors: existing
          ? this.document.connectors.map((entry) => (entry === existing ? connector : entry))
          : [...this.document.connectors, connector],
      },
    };
  }

  /**
   * Derives each mutation from committed state and saves it before publishing.
   * Serializing the whole transition prevents failed changes leaking into
   * another caller's write or new provider sessions.
   */
  private commit(
    change: () => ConnectorsDocument | undefined,
    retainRefreshedTokensOnSaveFailure = false,
  ): Promise<void> {
    const write = this.writes.then(async () => {
      if (this.loadFailed) {
        throw new McpConnectorFailure(
          "Synara could not read your saved connectors, so it won't change them. Restart Synara and try again.",
        );
      }
      const next = change();
      if (!next) return;
      try {
        await this.deps.save(encodeConnectorsDocument(next));
      } catch (error) {
        // A vendor may already have consumed the old refresh token. Keep its
        // replacement usable in memory; failed management changes stay invisible.
        if (retainRefreshedTokensOnSaveFailure) this.document = next;
        throw error;
      }
      this.document = next;
      this.publish();
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  /**
   * Flags the connector for a new sign-in, unless `failed` is no longer its
   * sign-in: a reconnect that finished meanwhile must stay connected.
   */
  private async markNeedsAuth(connectorId: string, failed: StoredConnectorOAuth): Promise<void> {
    await this.commit(() => {
      const connector = this.find(connectorId);
      if (!connector || connector.status === "needs-auth" || connector.oauth !== failed) return;
      return {
        ...this.document,
        connectors: this.document.connectors.map((entry) =>
          entry.connectorId === connectorId
            ? { ...entry, status: "needs-auth", updatedAt: new Date(this.now()).toISOString() }
            : entry,
        ),
      };
    }).catch((error: unknown) => {
      this.deps.logWarning("Could not save connector status.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Returns the token to send. Passing `rejected` (the token a 401 refused)
   * forces a refresh, unless another call already rotated to a fresh token.
   */
  private accessToken(connectorId: string, rejected?: string): Promise<string> {
    const oauth = this.find(connectorId)?.oauth;
    if (!oauth) return Promise.reject(new McpConnectorNeedsAuth());
    const force = rejected !== undefined;
    const fresh =
      oauth.expiresAtMs === null || oauth.expiresAtMs - TOKEN_REFRESH_LEEWAY_MS > this.now();
    // A refresh that finished after this call sent its request already replaced
    // the rejected token; reuse it unless that replacement also needs refreshing.
    if (force && fresh && oauth.tokens.access_token !== rejected) {
      return Promise.resolve(oauth.tokens.access_token);
    }
    if (!force && fresh) return Promise.resolve(oauth.tokens.access_token);
    const refreshToken = oauth.tokens.refresh_token;
    if (!refreshToken) {
      if (!force) return Promise.resolve(oauth.tokens.access_token);
      return this.markNeedsAuth(connectorId, oauth).then(() => {
        throw new McpConnectorNeedsAuth();
      });
    }
    // Concurrent tool calls share one refresh: refresh tokens may be single-use.
    const inFlight = this.refreshes.get(connectorId);
    if (inFlight) return inFlight;
    const refresh = this.refresh(connectorId, oauth, refreshToken).finally(() => {
      this.refreshes.delete(connectorId);
    });
    this.refreshes.set(connectorId, refresh);
    return refresh;
  }

  private async refresh(
    connectorId: string,
    oauth: StoredConnectorOAuth,
    refreshToken: string,
  ): Promise<string> {
    const { refreshAuthorization } = await loadMcpAuth();
    let refreshed: OAuthTokens;
    try {
      refreshed = await refreshAuthorization(oauth.discovery.authorizationServerUrl, {
        ...(oauth.discovery.authorizationServerMetadata
          ? { metadata: oauth.discovery.authorizationServerMetadata }
          : {}),
        clientInformation: oauth.clientInformation,
        refreshToken,
        ...(oauth.resource ? { resource: new URL(oauth.resource) } : {}),
        fetchFn: (url, init) =>
          connectorOAuthFetch(
            url,
            init,
            this.find(connectorId)?.url ? new URL(this.find(connectorId)!.url).origin : undefined,
          ),
      });
    } catch (error) {
      if (isOAuthGrantFailure(error)) {
        await this.markNeedsAuth(connectorId, oauth);
        throw new McpConnectorNeedsAuth();
      }
      throw error;
    }
    // Servers that do not rotate refresh tokens omit them from the response.
    const tokens: OAuthTokens = {
      ...refreshed,
      refresh_token: refreshed.refresh_token ?? refreshToken,
    };
    // A reconnect or disconnect during the refresh owns the record now.
    await this.commit(() => {
      if (this.find(connectorId)?.oauth !== oauth) return;
      const replacement = {
        ...oauth,
        tokens,
        expiresAtMs: tokenExpiryMs(tokens, this.now()),
      };
      return {
        ...this.document,
        // Refresh is not a user-visible reconnect: leave updatedAt unchanged.
        connectors: this.document.connectors.map((entry) =>
          entry.connectorId === connectorId ? { ...entry, oauth: replacement } : entry,
        ),
      };
    }, true).catch((error: unknown) => {
      this.deps.logWarning("Could not save refreshed connector tokens.", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    const current = this.find(connectorId);
    if (current?.status !== "connected" || !current.oauth) throw new McpConnectorNeedsAuth();
    return current.oauth.tokens.access_token;
  }

  private prunePending(): void {
    const now = this.now();
    for (const [state, entry] of this.pending) {
      if (now - entry.createdAtMs > PENDING_AUTHORIZATION_TTL_MS) this.pending.delete(state);
    }
    while (this.pending.size >= MAX_PENDING_AUTHORIZATIONS) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  private publish(): void {
    this.deps.publish(
      [...this.document.connectors, ...this.document.stdio]
        .filter((entry) => entry.status === "connected")
        .map((entry) => ({ name: entry.serverName, connectorId: entry.connectorId })),
    );
  }

  async refreshLocalStatus(): Promise<void> {
    if (this.healthCheck) return this.healthCheck;
    if (this.now() - this.lastProbe < 10_000) return;
    this.lastProbe = this.now();
    this.healthCheck = (async () => {
      const checks: Array<() => Promise<void>> = [];
      for (const connector of this.document.connectors) {
        if (!connector.url.startsWith("http:")) continue;
        checks.push(async () => {
          const result = await probeMcpConnector(
            connector.url,
            connector.name,
            this.deps.clientVersion,
          );
          const status =
            result.kind === "unavailable"
              ? "unreachable"
              : connector.status === "needs-auth"
                ? "needs-auth"
                : result.kind === "open" || connector.oauth
                  ? "connected"
                  : "needs-auth";
          if (status === connector.status) return;
          await this.commit(
            () => ({
              ...this.document,
              connectors: this.document.connectors.map((entry) =>
                entry === connector ? { ...entry, status } : entry,
              ),
            }),
            true,
          );
        });
      }
      for (const connector of this.document.stdio) {
        if (connector.status !== "unreachable") continue;
        checks.push(async () => {
          const available = await this.stdio.probe(
            { ...connector, env: connector.env ?? {} },
            connector.connectorId,
          );
          await this.updateStdioStatus(connector.connectorId, available);
        });
      }
      // Bound simultaneous process launches and DNS probes, without serial startup delays.
      for (let offset = 0; offset < checks.length; offset += 4) {
        const outcomes = await Promise.allSettled(
          checks.slice(offset, offset + 4).map((check) => check()),
        );
        if (outcomes.some((outcome) => outcome.status === "rejected"))
          this.deps.logWarning("Could not check or clean up a local connector.");
      }
      this.publish();
    })().finally(() => {
      this.healthCheck = undefined;
    });
    return this.healthCheck;
  }

  private async updateStdioStatus(connectorId: string, available: boolean): Promise<void> {
    const status = available ? "connected" : "unreachable";
    await this.commit(() => {
      if (
        !this.document.stdio.some(
          (entry) => entry.connectorId === connectorId && entry.status !== status,
        )
      )
        return;
      return {
        ...this.document,
        stdio: this.document.stdio.map((entry) =>
          entry.connectorId === connectorId ? { ...entry, status } : entry,
        ),
      };
    }, true).catch(() => this.deps.logWarning("Could not save local connector status."));
    this.publish();
  }

  private async connectStdio(
    input: Extract<McpConnectorConnectInput, { command: string }>,
  ): Promise<McpConnectorConnectResult> {
    const status = (await this.stdio.probe({ transport: "stdio", ...input }))
      ? "connected"
      : "unreachable";
    let saved!: StoredStdioConnector;
    await this.commit(() => {
      const existing = this.document.stdio.find(
        (entry) =>
          entry.command === input.command &&
          entry.cwd === input.cwd &&
          JSON.stringify(entry.args) === JSON.stringify(input.args),
      );
      if (!existing && this.list().length >= MCP_CONNECTORS_MAX_COUNT)
        throw new McpConnectorFailure("Too many connectors.");
      const now = new Date(this.now()).toISOString();
      saved = {
        ...input,
        transport: "stdio",
        connectorId: existing?.connectorId ?? `mcp_conn_${randomUUID()}`,
        presetId: null,
        serverName: existing?.serverName ?? this.uniqueServerName(mcpConnectorSlug(input.name)),
        authKind: "none",
        status,
        envKeys: Object.keys(input.env ?? {}).sort(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      return {
        ...this.document,
        stdio: [...this.document.stdio.filter((entry) => entry !== existing), saved],
      };
    });
    return { authorizationUrl: null, connector: publicStdio(saved) };
  }

  listProposals(): McpConnectorProposal[] {
    return this.document.proposals.map((entry) => entry.proposal);
  }

  async proposeAdd(
    raw: unknown,
    threadId: string,
    cwd?: string,
    source?: string,
  ): Promise<McpConnectorProposal> {
    const input = normalizeConnectorInput(raw, cwd);
    const now = new Date(this.now()).toISOString();
    const common = {
      connectorId: `proposal_${randomUUID()}`,
      presetId: null,
      name: input.name ?? "Connector",
      serverName: "pending_connector",
      authKind: "none" as const,
      status: "unreachable" as const,
      createdAt: now,
      updatedAt: now,
    };
    let connector: McpConnector;
    if ("command" in input) {
      const { env: _env, ...safe } = input;
      connector = {
        ...common,
        ...safe,
        transport: "stdio",
        envKeys: Object.keys(input.env ?? {}).sort(),
      };
    } else {
      const target = this.resolveTarget(input);
      connector = {
        ...common,
        name: target.name,
        presetId: target.presetId,
        url: target.url,
        transport: new URL(target.url).protocol === "http:" ? "local-http" : "remote-http",
      };
    }
    return this.saveProposal({
      proposal: {
        proposalId: randomUUID(),
        threadId,
        action: "add",
        state: "pending",
        connector,
        ...(source ? { source } : {}),
      },
      input,
    });
  }

  async proposeRemove(connectorId: string, threadId: string): Promise<McpConnectorProposal> {
    const connector = this.list().find((entry) => entry.connectorId === connectorId);
    if (!connector) throw new McpConnectorFailure("Connector not found.");
    return this.saveProposal({
      proposal: {
        proposalId: randomUUID(),
        threadId,
        action: "remove",
        state: "pending",
        connector,
      },
    });
  }

  private async saveProposal(entry: StoredProposal): Promise<McpConnectorProposal> {
    await this.commit(() => {
      if (this.document.proposals.filter((item) => item.proposal.state === "pending").length >= 100)
        throw new McpConnectorFailure("Dismiss pending connector proposals before adding more.");
      return { ...this.document, proposals: [...this.document.proposals, entry] };
    });
    return entry.proposal;
  }

  async resolveProposal(
    input: McpConnectorResolveProposalInput,
  ): Promise<McpConnectorResolveProposalResult> {
    const entry = this.document.proposals.find(
      (item) => item.proposal.proposalId === input.proposalId,
    );
    if (!entry) throw new McpConnectorFailure("Proposal not found.");
    if (entry.proposal.state !== "pending")
      return { proposal: entry.proposal, authorizationUrl: null };
    if (this.resolving.has(input.proposalId))
      throw new McpConnectorFailure("This proposal is already being applied.");
    this.resolving.add(input.proposalId);
    try {
      let authorizationUrl: string | null = null;
      if (input.resolution === "accepted") {
        if (entry.proposal.action === "remove")
          await this.disconnect(entry.proposal.connector.connectorId);
        else if (entry.input) authorizationUrl = (await this.connect(entry.input)).authorizationUrl;
        else throw new McpConnectorFailure("This proposal cannot be applied.");
      }
      const proposal = { ...entry.proposal, state: input.resolution };
      await this.commit(() => ({
        ...this.document,
        proposals: this.document.proposals.map((item) => (item === entry ? { proposal } : item)),
      }));
      return { proposal, authorizationUrl };
    } finally {
      this.resolving.delete(input.proposalId);
    }
  }

  sweepStdio(ownerActive: (token: string) => boolean): Promise<void> {
    return this.stdio.sweep(ownerActive);
  }
  dispose(): Promise<void> {
    return this.stdio.dispose();
  }
}
