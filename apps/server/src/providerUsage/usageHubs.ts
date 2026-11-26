// FILE: providerUsage/usageHubs.ts
// Purpose: Usage hubs. A CLIProxyAPI hub pools several Codex/Claude subscription accounts;
// this module stores hubs (URL, label, management key) in the server secret store and reads
// each pooled account's quota through the hub's management API. The hub makes the provider
// call with the account's own token (`/v0/management/api-call`), so no provider credential
// ever reaches Synara. Responses go through the same parsers as local accounts.

import * as NodeCrypto from "node:crypto";

import {
  ProviderInstanceId,
  WsRpcError,
  type ProviderKind,
  type ServerAddUsageHubInput,
  type ServerListUsageHubsInput,
  type ServerProviderUsageSnapshot,
  type ServerRemoveUsageHubInput,
  type ServerUsageHub,
  type ServerUsageHubAccount,
} from "@synara/contracts";
import { normalizeOutboundOrigin } from "@synara/shared/outboundHttpPolicy";
import { Effect, Schema, Semaphore } from "effect";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import { createLogger } from "../logger";
import { fetchJson, type FetchJsonResult } from "./http";
import { asRecord, asString, errorSnapshot } from "./parse";
import { parseClaudeUsage } from "./providers/claude";
import { parseCodexUsage } from "./providers/codex";

const log = createLogger("provider-usage:hubs");

const SECRET_NAME = "usage-hubs";
const SOURCE = "usage-hub";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const HUB_TIMEOUT_MS = 15_000;
// Matches the provider usage cache: opening Settings twice should not re-poll every account.
const CACHE_TTL_MS = 60_000;
const ACCOUNT_CONCURRENCY = 4;

const StoredHub = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  label: Schema.optional(Schema.String),
  managementKey: Schema.String,
});
type StoredHub = typeof StoredHub.Type;
const StoredHubsJson = Schema.fromJsonString(Schema.Struct({ hubs: Schema.Array(StoredHub) }));
const decodeStoredHubs = Schema.decodeUnknownEffect(StoredHubsJson);
const encodeStoredHubs = Schema.encodeEffect(StoredHubsJson);

interface HubAccount {
  readonly id: string;
  readonly authIndex: string;
  readonly provider: "codex" | "claude";
  readonly email: string | undefined;
  readonly chatgptAccountId: string | undefined;
}

/** Slug-safe and stable: the same hub account keeps its sidebar ring across reads. */
export function usageHubAccountKey(hubId: string, accountId: string): ProviderInstanceId {
  const digest = NodeCrypto.createHash("sha256").update(`${hubId}\0${accountId}`).digest("hex");
  return ProviderInstanceId.makeUnsafe(`hub_${digest.slice(0, 24)}`);
}

export function usageHubLabel(hub: Pick<StoredHub, "url" | "label">): string {
  if (hub.label?.trim()) return hub.label.trim();
  try {
    return new URL(hub.url).host;
  } catch {
    return hub.url;
  }
}

/** Throws a user-facing message when the URL is not one the outbound policy can reach. */
export function normalizeUsageHubUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter the hub's full URL, for example https://hub.example.ts.net:8318.");
  }
  try {
    normalizeOutboundOrigin(url, { allowLoopbackHttp: true });
  } catch {
    throw new Error("Use an https:// URL. Plain http:// works only for localhost.");
  }
  // The management API lives at the origin root; drop any path the user pasted.
  return url.origin;
}

function management(hub: StoredHub, path: string, body?: unknown): Promise<FetchJsonResult> {
  const url = new URL(`/v0/management/${path}`, hub.url);
  return fetchJson({
    service: "provider-usage-hub",
    url: url.toString(),
    allowedOrigins: [url.origin],
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${hub.managementKey}`, Accept: "application/json" },
    ...(body === undefined ? {} : { body }),
    timeoutMs: HUB_TIMEOUT_MS,
    allowLoopbackHttp: true,
    allowPrivateAddress: true,
  });
}

export function parseHubAccounts(json: unknown): HubAccount[] {
  const files = asRecord(json)?.files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((value): HubAccount[] => {
    const file = asRecord(value);
    const provider = asString(file?.provider);
    const id = asString(file?.id);
    const rawIndex = file?.auth_index;
    const authIndex =
      typeof rawIndex === "number" && Number.isFinite(rawIndex)
        ? String(rawIndex)
        : asString(rawIndex);
    if (!file || !id || !authIndex || file.disabled === true) return [];
    if (provider !== "codex" && provider !== "claude") return [];
    return [
      {
        id,
        authIndex,
        provider,
        email: asString(file.email)?.trim() || undefined,
        chatgptAccountId: asString(asRecord(file.id_token)?.chatgpt_account_id),
      },
    ];
  });
}

async function readAccount(
  hub: StoredHub,
  account: HubAccount,
  nowMs: number,
): Promise<ServerUsageHubAccount> {
  const provider: ProviderKind = account.provider === "codex" ? "codex" : "claudeAgent";
  const key = usageHubAccountKey(hub.id, account.id);
  const base = { id: account.id, key, ...(account.email ? { email: account.email } : {}) };
  const failed = (detail: string) => ({
    ...base,
    usage: { ...errorSnapshot(provider, nowMs, SOURCE, detail), instanceId: key },
  });
  // `$TOKEN$` is the hub's placeholder for the pooled account's own access token.
  const header =
    account.provider === "codex"
      ? {
          Authorization: "Bearer $TOKEN$",
          Accept: "application/json",
          "User-Agent": "Synara",
          ...(account.chatgptAccountId ? { "ChatGPT-Account-Id": account.chatgptAccountId } : {}),
        }
      : {
          Authorization: "Bearer $TOKEN$",
          Accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": "claude-code/2.1.69",
        };
  let result: FetchJsonResult;
  try {
    result = await management(hub, "api-call", {
      auth_index: account.authIndex,
      method: "GET",
      url: account.provider === "codex" ? CODEX_USAGE_URL : CLAUDE_USAGE_URL,
      header,
    });
  } catch (cause) {
    log.warn("usage hub account read failed", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return failed("Could not reach the hub.");
  }
  const response = asRecord(result.json);
  const status = response?.status_code;
  const body = asString(response?.body);
  if (!result.ok || typeof status !== "number" || body === undefined) {
    return failed(`The hub could not read this account's usage (HTTP ${result.status}).`);
  }
  if (status < 200 || status >= 300) {
    return failed(`The provider refused the hub's usage request (HTTP ${status}).`);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return failed("The provider returned an unreadable usage response.");
  }
  const usage: ServerProviderUsageSnapshot =
    account.provider === "codex"
      ? parseCodexUsage({ json, nowMs })
      : parseClaudeUsage({ json, nowMs });
  return { ...base, usage: { ...usage, instanceId: key } };
}

async function mapWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Reads every pooled Codex/Claude account. Never throws; hub failures land on `error`. */
export async function readUsageHub(hub: StoredHub, nowMs = Date.now()): Promise<ServerUsageHub> {
  const base = {
    id: hub.id,
    label: usageHubLabel(hub),
    url: hub.url,
    checkedAt: new Date(nowMs).toISOString(),
  };
  let result: FetchJsonResult;
  try {
    result = await management(hub, "auth-files");
  } catch (cause) {
    log.warn("usage hub unreachable", {
      message: cause instanceof Error ? cause.message : String(cause),
    });
    return { ...base, accounts: [], error: "Could not reach the hub." };
  }
  if (result.status === 401 || result.status === 403) {
    return { ...base, accounts: [], error: "The hub rejected the management key." };
  }
  if (!result.ok) {
    return { ...base, accounts: [], error: `The hub answered HTTP ${result.status}.` };
  }
  const accounts = parseHubAccounts(result.json);
  return {
    ...base,
    accounts: await mapWithConcurrency(accounts, ACCOUNT_CONCURRENCY, (account) =>
      readAccount(hub, account, nowMs),
    ),
  };
}

// Keyed by everything a read depends on, so an edited or re-added hub never serves old data.
const readCache = new Map<
  string,
  { readonly at: number; readonly value: Promise<ServerUsageHub> }
>();

function cacheKey(hub: StoredHub): string {
  const keyHash = NodeCrypto.createHash("sha256").update(hub.managementKey).digest("hex");
  return `${hub.id}\0${hub.url}\0${hub.label ?? ""}\0${keyHash}`;
}

function readUsageHubCached(hub: StoredHub, forceRefresh: boolean): Promise<ServerUsageHub> {
  const key = cacheKey(hub);
  const cached = readCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = readUsageHub(hub);
  readCache.set(key, { at: Date.now(), value });
  return value;
}

function forgetHub(id: string): void {
  for (const key of readCache.keys()) {
    if (key.startsWith(`${id}\0`)) readCache.delete(key);
  }
}

export function __resetUsageHubCacheForTests(): void {
  readCache.clear();
}

// One writer at a time: two adds racing would each save a list missing the other's hub.
const storeLock = Semaphore.makeUnsafe(1);

const userError = (message: string) => new WsRpcError({ message });

export const makeUsageHubs = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;

  const load = secrets.get(SECRET_NAME).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? decodeStoredHubs(new TextDecoder().decode(bytes)).pipe(Effect.map((file) => file.hubs))
        : Effect.succeed([] as ReadonlyArray<StoredHub>),
    ),
    Effect.mapError(() => userError("Could not read the saved usage hubs.")),
  );

  const save = (hubs: ReadonlyArray<StoredHub>) =>
    encodeStoredHubs({ hubs }).pipe(
      Effect.flatMap((text) => secrets.set(SECRET_NAME, new TextEncoder().encode(text))),
      Effect.mapError(() => userError("Could not save the usage hubs.")),
    );

  const list = (input: ServerListUsageHubsInput) =>
    load.pipe(
      Effect.flatMap((hubs) =>
        Effect.promise(() =>
          Promise.all(hubs.map((hub) => readUsageHubCached(hub, input.forceRefresh === true))),
        ),
      ),
    );

  const add = (input: ServerAddUsageHubInput) =>
    Effect.gen(function* () {
      const url = yield* Effect.try({
        try: () => normalizeUsageHubUrl(input.url),
        catch: (cause) => userError(cause instanceof Error ? cause.message : "Invalid hub URL."),
      });
      const hub: StoredHub = {
        id: `hub-${NodeCrypto.randomUUID()}`,
        url,
        managementKey: input.managementKey,
        ...(input.label ? { label: input.label } : {}),
      };
      yield* storeLock.withPermits(1)(
        Effect.gen(function* () {
          const hubs = yield* load;
          if (hubs.some((existing) => existing.url === url)) {
            return yield* userError("This hub is already added.");
          }
          yield* save([...hubs, hub]);
        }),
      );
      return yield* Effect.promise(() => readUsageHubCached(hub, true));
    });

  const remove = (input: ServerRemoveUsageHubInput) =>
    storeLock.withPermits(1)(
      Effect.gen(function* () {
        const hubs = yield* load;
        yield* save(hubs.filter((hub) => hub.id !== input.id));
        forgetHub(input.id);
      }),
    );

  return { list, add, remove };
});
