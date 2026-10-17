import type { NotionObject, NotionReadInput } from "@synara/contracts";
import { notionArray, notionObject, notionResourceId, notionString } from "@synara/shared/notion";

export const NOTION_VERSION = "2026-03-11";
const API_ORIGIN = "https://api.notion.com";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export class NotionFailure extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid"
      | "unauthorized"
      | "forbidden"
      | "missing"
      | "rate-limited"
      | "network"
      | "unknown-outcome"
      | "conflict"
      | "unavailable",
    readonly status = 0,
    readonly retryAfterMs = 0,
  ) {
    super(message);
    this.name = "NotionFailure";
  }
}
export async function readNotionJson(
  response: Response,
  limit = MAX_RESPONSE_BYTES,
): Promise<NotionObject> {
  if (Number(response.headers.get("content-length") ?? "0") > limit) {
    await response.body?.cancel();
    throw new NotionFailure("Notion returned too much data. Narrow the query.", "invalid");
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new NotionFailure("Notion returned too much data. Narrow the query.", "invalid");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (size === 0) return {};
  try {
    return notionObject(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new NotionFailure("Notion returned an invalid response.", "unavailable");
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
export interface NotionClientOptions {
  accessToken: () => string;
  refresh: () => Promise<void>;
  fetch?: typeof fetch | undefined;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}
export class NotionClient {
  private tail: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private refreshing: Promise<void> | null = null;
  constructor(private readonly options: NotionClientOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? delay;
    this.now = options.now ?? Date.now;
  }
  private async reserve(signal?: AbortSignal): Promise<void> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      signal?.throwIfAborted();
      const wait = this.nextRequestAt - this.now();
      if (wait > 0) await this.sleep(wait, signal);
      this.nextRequestAt = this.now() + 350;
    } finally {
      release();
    }
  }
  async request(
    path: string,
    input: {
      method?: "GET" | "POST" | "PATCH";
      body?: NotionObject;
      readOnly?: boolean;
      signal?: AbortSignal | undefined;
      beforeSend?: (() => Promise<void>) | undefined;
    } = {},
  ): Promise<NotionObject> {
    const url = new URL(path, API_ORIGIN);
    if (
      url.origin !== API_ORIGIN ||
      !url.pathname.startsWith("/v1/") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new NotionFailure("Invalid Notion API path.", "invalid");
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    if (body && Buffer.byteLength(body) > 480_000)
      throw new NotionFailure("This change exceeds the Notion request limit.", "invalid");
    const method = input.method ?? "GET";
    const readOnly = method === "GET" || input.readOnly === true;
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.reserve(input.signal);
      // Run outside the network catch: a revoked grant is not an uncertain write.
      // Recheck after every queue wait, token refresh and rate-limit retry.
      await input.beforeSend?.();
      input.signal?.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          redirect: "error",
          headers: {
            Authorization: `Bearer ${this.options.accessToken()}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body }),
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(20_000)])
            : AbortSignal.timeout(20_000),
        });
      } catch {
        if (readOnly && attempt < 2 && !input.signal?.aborted) {
          await this.sleep(500 * 2 ** attempt, input.signal);
          continue;
        }
        throw new NotionFailure(
          readOnly
            ? "Notion is unreachable. Try again when the connection is restored."
            : "Delivery to Notion is uncertain. Inspect the retained change before retrying.",
          readOnly ? "network" : "unknown-outcome",
        );
      }
      if (response.status === 401 && !refreshed) {
        await response.body?.cancel();
        refreshed = true;
        this.refreshing ??= this.options.refresh().finally(() => {
          this.refreshing = null;
        });
        await this.refreshing;
        continue;
      }
      if (response.status === 429) {
        const header = response.headers.get("retry-after");
        const seconds = Number(header);
        const wait =
          header && Number.isFinite(seconds)
            ? Math.max(1_000, seconds * 1_000)
            : header && Number.isFinite(Date.parse(header))
              ? Math.max(1_000, Date.parse(header) - this.now())
              : 1_000;
        this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + wait);
        await response.body?.cancel();
        if (attempt < 3 && wait <= 5_000) continue;
        throw new NotionFailure(
          "Notion is rate limiting this connection. Changes are retained for retry.",
          "rate-limited",
          429,
          wait,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          throw new NotionFailure(
            "Reconnect this Notion workspace to restore access.",
            "unauthorized",
            401,
          );
        if (response.status === 403)
          throw new NotionFailure(
            "Notion denied this operation. Check capabilities and workspace policy.",
            "forbidden",
            403,
          );
        if (response.status === 404)
          throw new NotionFailure(
            "This Notion resource is unavailable or is no longer shared.",
            "missing",
            404,
          );
        if (response.status >= 500) {
          if (readOnly && attempt < 2) {
            await this.sleep(500 * 2 ** attempt, input.signal);
            continue;
          }
          throw new NotionFailure(
            readOnly
              ? "Notion is temporarily unavailable."
              : "The server did not confirm this write. Delivery must be reconciled.",
            readOnly ? "unavailable" : "unknown-outcome",
            response.status,
          );
        }
        throw new NotionFailure(
          "Notion refused this request. Review the actual source schema and supported fields.",
          "invalid",
          response.status,
        );
      }
      try {
        return await readNotionJson(response);
      } catch (error) {
        if (!readOnly)
          throw new NotionFailure(
            "Notion accepted the request but its response was incomplete. Inspect the result before retrying.",
            "unknown-outcome",
          );
        throw error;
      }
    }
    throw new NotionFailure(
      "Notion could not complete the request within its retry budget.",
      "unavailable",
    );
  }
  read(input: NotionReadInput, signal?: AbortSignal): Promise<NotionObject> {
    const id = input.id ? notionResourceId(input.id) : null;
    const requireId = () => {
      if (!id) throw new NotionFailure("A resource ID is required.", "invalid");
      return id;
    };
    const params = new URLSearchParams({ page_size: String(input.pageSize ?? 100) });
    if (input.cursor) params.set("start_cursor", input.cursor);
    const cursorBody = {
      page_size: input.pageSize ?? 100,
      ...(input.cursor ? { start_cursor: input.cursor } : {}),
    };
    switch (input.kind) {
      case "search":
        return this.request("/v1/search", {
          method: "POST",
          readOnly: true,
          body: {
            ...cursorBody,
            ...(input.query ? { query: input.query } : {}),
            ...(input.filter ? { filter: input.filter } : {}),
          },
          signal,
        });
      case "query":
        return this.request(`/v1/data_sources/${requireId()}/query`, {
          method: "POST",
          readOnly: true,
          body: {
            ...cursorBody,
            ...(input.filter ? { filter: input.filter } : {}),
            ...(input.sorts ? { sorts: input.sorts } : {}),
          },
          signal,
        });
      case "page":
        return this.request(`/v1/pages/${requireId()}`, { signal });
      case "block":
        return this.request(`/v1/blocks/${requireId()}`, { signal });
      case "children":
        return this.request(`/v1/blocks/${requireId()}/children?${params}`, { signal });
      case "dataSource":
        return this.request(`/v1/data_sources/${requireId()}`, { signal });
      case "database":
        return this.request(`/v1/databases/${requireId()}`, { signal });
      case "comments":
        params.set("block_id", requireId());
        return this.request(`/v1/comments?${params}`, { signal });
      case "users":
        return this.request(`/v1/users?${params}`, { signal });
      case "property":
        if (!input.propertyId) throw new NotionFailure("A property ID is required.", "invalid");
        return this.request(
          `/v1/pages/${requireId()}/properties/${encodeURIComponent(input.propertyId)}?${params}`,
          { signal },
        );
      case "views":
        params.set("data_source_id", requireId());
        return this.request(`/v1/views?${params}`, { signal });
    }
  }
  async *pages(input: NotionReadInput, signal?: AbortSignal): AsyncGenerator<NotionObject> {
    let cursor = input.cursor;
    const cursors = new Set<string>();
    for (let count = 0; count < 100; count += 1) {
      const page = await this.read({ ...input, ...(cursor ? { cursor } : {}) }, signal);
      if (
        !Array.isArray(page.results) ||
        typeof page.has_more !== "boolean" ||
        (page.has_more && !notionString(page.next_cursor))
      )
        throw new NotionFailure(
          "Notion returned an incomplete collection. Existing records were retained.",
          "unavailable",
        );
      for (const result of page.results) yield notionObject(result);
      if (page.has_more !== true) return;
      const next = notionString(page.next_cursor);
      if (!next || cursors.has(next))
        throw new NotionFailure(
          "Notion returned an incomplete pagination cursor. Retry the sync.",
          "unavailable",
        );
      cursors.add(next);
      cursor = next;
    }
    throw new NotionFailure(
      "This data source exceeds the current sync batch limit. Narrow its scope before importing.",
      "invalid",
    );
  }
}
