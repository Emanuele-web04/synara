// FILE: providerHistory/devinCloudHistory.ts
// Purpose: Read-only Devin Cloud v3 client: session catalog + message pages.
// GET requests only — never POST, never sends prompts, never wakes a session.
// Layer: Provider history import.
// Exports: listDevinCloudSessions, readDevinCloudMessages,
// DevinCloudSession, DevinCloudMessage, DevinCloudPage.

import { ProviderHistoryError } from "@synara/contracts";

const OPERATION = "DevinCloudHistory";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PAGE_SIZE = 200;

export interface DevinCloudSession {
  readonly sessionId: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly statusDetail: string | null;
  readonly url: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly origin: string | null;
  readonly devinMode: string | null;
}

export interface DevinCloudMessage {
  readonly eventId: string;
  readonly source: "user" | "devin";
  readonly message: string;
  readonly createdAt: string | null;
}

export interface DevinCloudPage<T> {
  readonly items: ReadonlyArray<T>;
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

export interface DevinCloudIdentityOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly timeoutMs?: number;
}

export interface DevinCloudClientOptions extends DevinCloudIdentityOptions {
  readonly orgId: string;
}

function fail(
  code: ProviderHistoryError["code"],
  detail: string,
  retryable: boolean,
  cause?: unknown,
): never {
  throw new ProviderHistoryError({ operation: OPERATION, code, detail, retryable, cause });
}

function epochSecondsToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function cloudGet(
  options: DevinCloudIdentityOptions,
  path: string,
  query: Record<string, string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.apiUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${options.token}` },
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted === true) {
      fail("busy", `Devin Cloud request cancelled: ${path}`, true, error);
    }
    fail("busy", `Devin Cloud request failed or timed out: ${path}`, true, error);
  }
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      fail("auth-failed", `Devin Cloud rejected the configured credential (${status}).`, false);
    }
    if (status === 404) {
      fail("not-found", `Devin Cloud resource not found: ${path}`, false);
    }
    if (status === 429) {
      fail("rate-limited", "Devin Cloud rate limit hit; retry after backoff.", true);
    }
    fail("read-failed", `Devin Cloud responded with status ${status}.`, status >= 500);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    fail("read-failed", "Devin Cloud returned a non-JSON body.", false, error);
  }
  const record = asRecord(body);
  if (record === null || !Array.isArray(record.items)) {
    fail(
      "unsupported-version",
      `Devin Cloud response for ${path} is not a paginated items payload.`,
      false,
    );
  }
  return record;
}

function parsePage<T>(
  record: Record<string, unknown>,
  mapItem: (item: Record<string, unknown>) => T | null,
): DevinCloudPage<T> {
  const items = (record.items as ReadonlyArray<unknown>).flatMap((raw) => {
    const item = asRecord(raw);
    if (item === null) return [];
    const mapped = mapItem(item);
    return mapped === null ? [] : [mapped];
  });
  return {
    items,
    endCursor: asText(record.end_cursor),
    hasNextPage: record.has_next_page === true,
  };
}

export interface DevinCloudOrganization {
  readonly orgId: string;
  readonly name: string | null;
}

/**
 * Resolve the organization a token can read. Uses the first page of
 * /v3/enterprise/organizations; history reads then scope every call to that
 * org so the caller never has to know or configure the org id.
 */
export async function listDevinCloudOrganizations(
  options: DevinCloudIdentityOptions,
  input: { first?: number; signal?: AbortSignal } = {},
): Promise<DevinCloudPage<DevinCloudOrganization>> {
  const first = Math.min(Math.max(input.first ?? 100, 1), MAX_PAGE_SIZE);
  const record = await cloudGet(
    options,
    "/v3/enterprise/organizations",
    { first: String(first) },
    input.signal,
  );
  return parsePage(record, (item) => {
    const orgId = asText(item.org_id);
    if (orgId === null) return null;
    return { orgId, name: asText(item.name) };
  });
}

export async function listDevinCloudSessions(
  options: DevinCloudClientOptions,
  input: { first?: number; after?: string | null; signal?: AbortSignal } = {},
): Promise<DevinCloudPage<DevinCloudSession>> {
  const first = Math.min(Math.max(input.first ?? 100, 1), MAX_PAGE_SIZE);
  const qs: Record<string, unknown> = { first };
  if (input.after) qs.after = input.after;
  const record = await cloudGet(
    options,
    `/v3/organizations/${encodeURIComponent(options.orgId)}/sessions`,
    { qs: JSON.stringify(qs) },
    input.signal,
  );
  return parsePage(record, (item) => {
    // Cloud returns the bare uuid; the canonical external id keeps the
    // "devin-" prefix the webapp and messages endpoint use.
    const rawId = asText(item.session_id) ?? asText(item.devin_id);
    if (rawId === null) return null;
    return {
      sessionId: rawId.startsWith("devin-") ? rawId : `devin-${rawId}`,
      title: asText(item.title),
      status: asText(item.status),
      statusDetail: asText(item.status_detail),
      url: asText(item.url),
      createdAt: epochSecondsToIso(item.created_at),
      updatedAt: epochSecondsToIso(item.updated_at),
      origin: asText(item.origin),
      devinMode: asText(item.devin_mode),
    };
  });
}

export async function readDevinCloudMessages(
  options: DevinCloudClientOptions,
  input: { sessionId: string; first?: number; after?: string | null; signal?: AbortSignal },
): Promise<DevinCloudPage<DevinCloudMessage>> {
  const first = Math.min(Math.max(input.first ?? 100, 1), MAX_PAGE_SIZE);
  const query: Record<string, string> = { first: String(first) };
  if (input.after) query.after = input.after;
  const record = await cloudGet(
    options,
    `/v3/organizations/${encodeURIComponent(options.orgId)}/sessions/${encodeURIComponent(
      input.sessionId,
    )}/messages`,
    query,
    input.signal,
  );
  return parsePage(record, (item) => {
    const eventId = asText(item.event_id);
    const source = asText(item.source);
    if (eventId === null || (source !== "user" && source !== "devin")) return null;
    return {
      eventId,
      source,
      message: typeof item.message === "string" ? item.message : "",
      createdAt: epochSecondsToIso(item.created_at),
    };
  });
}
