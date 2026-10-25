// FILE: oauth.ts
// Purpose: OAuth 2.1 for connectors through the MCP SDK (discovery, dynamic client
//   registration, PKCE, token exchange and refresh), with every request sent through
//   the origin-pinned outbound HTTP client.
// Layer: Connectors runtime (promise-based; driven by the McpConnectors layer)

import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { outboundHttp } from "@synara/shared/outboundHttp";

export const SYNARA_OAUTH_CLIENT_NAME = "Synara";
export const SYNARA_OAUTH_CLIENT_URI = "https://www.trysynara.com";
const OAUTH_TIMEOUT_MS = 20_000;
const OAUTH_MAX_RESPONSE_BYTES = 1024 * 1024;

type McpAuthModule = typeof import("@modelcontextprotocol/sdk/client/auth.js");
let mcpAuthModule: Promise<McpAuthModule> | undefined;

/** Loaded on first use so unused connectors do not load the OAuth client. */
export function loadMcpAuth(): Promise<McpAuthModule> {
  mcpAuthModule ??= import("@modelcontextprotocol/sdk/client/auth.js");
  return mcpAuthModule;
}

type OutboundMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
const OUTBOUND_METHODS = new Set<string>(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

function requestBodyText(body: RequestInit["body"]): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("Unsupported OAuth request body.");
}

/**
 * The SDK's `fetchFn`: each call may only reach the origin it names, must
 * resolve to a public address, and is bounded in time and size.
 */
export async function connectorOAuthFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!OUTBOUND_METHODS.has(method)) throw new Error(`Unsupported OAuth method ${method}.`);
  const body = requestBodyText(init?.body);
  const response = await outboundHttp.request({
    policy: {
      service: "mcp-connector-oauth",
      allowedOrigins: [url.origin],
      timeoutMs: OAUTH_TIMEOUT_MS,
      maxRequestBytes: 64 * 1024,
      maxResponseBytes: OAUTH_MAX_RESPONSE_BYTES,
      maxRedirects: 3,
      maxConcurrent: 4,
      maxQueued: 32,
      requirePublicAddress: true,
    },
    url,
    method: method as OutboundMethod,
    ...(init?.headers ? { headers: init.headers } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(init?.signal ? { signal: init.signal } : {}),
  });
  const status = response.status >= 200 && response.status <= 599 ? response.status : 502;
  const nullBody = status === 204 || status === 205 || status === 304;
  return new Response(nullBody ? null : response.body, { status, headers: response.headers });
}

export function connectorClientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: SYNARA_OAUTH_CLIENT_NAME,
    client_uri: SYNARA_OAUTH_CLIENT_URI,
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/** Mutable state of one sign-in, from the first redirect to the token exchange. */
export interface ConnectorAuthorizationState {
  readonly redirectUrl: string;
  readonly state: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;
}

/**
 * The SDK's provider interface over one sign-in. Each sign-in registers a
 * fresh client: the desktop picks a new port per launch (so the redirect URL
 * changes), and a stale cached registration would strand the user on the
 * vendor's error page with no way to recover from Synara.
 */
export function makeConnectorOAuthProvider(
  authorization: ConnectorAuthorizationState,
): OAuthClientProvider {
  return {
    get redirectUrl() {
      return authorization.redirectUrl;
    },
    get clientMetadata() {
      return connectorClientMetadata(authorization.redirectUrl);
    },
    state: () => authorization.state,
    clientInformation: () => authorization.clientInformation,
    saveClientInformation: (clientInformation) => {
      authorization.clientInformation = clientInformation;
    },
    tokens: () => authorization.tokens,
    saveTokens: (tokens) => {
      authorization.tokens = tokens;
    },
    redirectToAuthorization: (authorizationUrl) => {
      authorization.authorizationUrl = authorizationUrl;
    },
    saveCodeVerifier: (codeVerifier) => {
      authorization.codeVerifier = codeVerifier;
    },
    codeVerifier: () => {
      if (!authorization.codeVerifier) throw new Error("The sign-in has no PKCE verifier.");
      return authorization.codeVerifier;
    },
    saveDiscoveryState: (discovery) => {
      authorization.discovery = discovery;
    },
    discoveryState: () => authorization.discovery,
    invalidateCredentials: (scope) => {
      if (scope === "all" || scope === "client") delete authorization.clientInformation;
      if (scope === "all" || scope === "tokens") delete authorization.tokens;
      if (scope === "all" || scope === "verifier") delete authorization.codeVerifier;
      if (scope === "all" || scope === "discovery") delete authorization.discovery;
    },
  };
}

// RFC 6749 §5.2 errors that mean the refresh token or client will never work
// again. Everything else (rate limits, server errors, malformed requests)
// may clear up, so it must not cost the user their sign-in.
const LOST_GRANT_OAUTH_ERROR_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
]);

/** True when the token endpoint said the grant is gone for good. */
export function isOAuthGrantFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errorCode = (error as { readonly errorCode?: unknown }).errorCode;
  return typeof errorCode === "string" && LOST_GRANT_OAUTH_ERROR_CODES.has(errorCode);
}

export function tokenExpiryMs(tokens: OAuthTokens, nowMs: number): number | null {
  return typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
    ? nowMs + tokens.expires_in * 1000
    : null;
}

/**
 * Best-effort RFC 7009 revocation on disconnect. Failures are ignored: the
 * tokens are deleted locally either way, and the vendor's own settings can
 * still revoke the grant.
 */
export async function revokeConnectorTokens(input: {
  readonly discovery: OAuthDiscoveryState;
  readonly clientInformation: OAuthClientInformationMixed;
  readonly tokens: OAuthTokens;
}): Promise<void> {
  const metadata = input.discovery.authorizationServerMetadata as
    | { readonly revocation_endpoint?: unknown }
    | undefined;
  const endpoint = metadata?.revocation_endpoint;
  if (typeof endpoint !== "string") return;
  const candidates: Array<readonly [string | undefined, string]> = [
    [input.tokens.refresh_token, "refresh_token"],
    [input.tokens.access_token, "access_token"],
  ];
  for (const [token, hint] of candidates) {
    if (!token) continue;
    const body = new URLSearchParams({
      token,
      token_type_hint: hint,
      client_id: input.clientInformation.client_id,
    });
    if (input.clientInformation.client_secret) {
      body.set("client_secret", input.clientInformation.client_secret);
    }
    await connectorOAuthFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }).catch(() => undefined);
  }
}
