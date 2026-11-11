// FILE: usagePricing.ts
// Purpose: API list prices per model, to estimate what Synara usage would cost
// for providers that report no cost of their own (Codex). Rates come from
// LiteLLM's model price table, the one t3code and ccusage use; it is downloaded
// at most once a day and kept in the state folder so prices still load offline.
// Layer: server usage pricing (pure pricing plus a small file-cached loader).

import fs from "node:fs/promises";
import nodePath from "node:path";

import type { StatsUsageAnalyticsPricingStatus } from "@synara/contracts";
import { Effect } from "effect";

import { writeFileStringAtomically } from "./atomicWrite";

export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;
// After a failed download, wait before trying again instead of on every request.
const RETRY_AFTER_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
// A real table has thousands of models; fewer means a broken download.
const MIN_PRICED_MODELS = 100;

/** USD per token. */
export interface ModelRate {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

/** Tokens of one model. The four parts are disjoint. */
export interface PricedTokens {
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function bareName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

function sameRate(left: ModelRate, right: ModelRate): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite
  );
}

/**
 * The LiteLLM document as a rate table. Keys are lowercased; a bare model name
 * (`gpt-5` for `openai/gpt-5`) is added only when no entry already uses it and
 * every qualified entry agrees on its price. A model without both an input and
 * an output price is left out: half a price would quietly under-report.
 */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;
  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const key = name.trim().toLowerCase();
    const input = finite(entry.input_cost_per_token);
    const output = finite(entry.output_cost_per_token);
    if (!key || input === null || output === null) continue;
    table.set(key, {
      input,
      output,
      // Cached input without its own price is priced as plain input, not as free.
      cacheRead: finite(entry.cache_read_input_token_cost) ?? input,
      cacheWrite: finite(entry.cache_creation_input_token_cost) ?? input,
    });
  }
  const aliases = new Map<string, ModelRate | null>();
  for (const [key, rate] of table) {
    const alias = bareName(key);
    if (!alias || alias === key || table.has(alias)) continue;
    const held = aliases.get(alias);
    if (held === undefined) aliases.set(alias, rate);
    else if (held !== null && !sameRate(held, rate)) aliases.set(alias, null);
  }
  for (const [alias, rate] of aliases) if (rate) table.set(alias, rate);
  return table;
}

// Never priced: locally generated messages, and bare family names that could
// be any generation.
const UNPRICEABLE = new Set(["<synthetic>", "synthetic", "opus", "sonnet", "haiku", "fable"]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  // `claude-sonnet-5[1m]` is a context variant of the same model.
  let key = model.trim().toLowerCase();
  const bracket = key.indexOf("[");
  if (bracket !== -1) key = key.slice(0, bracket);
  if (!key || UNPRICEABLE.has(bareName(key))) return null;
  // A dated snapshot (`…-20260101`) falls back to the undated name.
  return table.get(key) ?? table.get(key.replace(/-\d{8}$/u, "")) ?? null;
}

/** The tokens at list price, or null when the model has no price. */
export function priceTokens(table: RateTable, model: string, tokens: PricedTokens): number | null {
  const rate = lookupRate(table, model);
  if (!rate) return null;
  return (
    tokens.inputTokens * rate.input +
    tokens.cacheReadTokens * rate.cacheRead +
    tokens.cacheWriteTokens * rate.cacheWrite +
    tokens.outputTokens * rate.output
  );
}

// ── Loader ───────────────────────────────────────────────────────────────

export interface PriceTable {
  readonly table: RateTable;
  readonly status: StatsUsageAnalyticsPricingStatus;
  readonly fetchedAt: string | null;
}

export interface UsagePricingSource {
  readonly load: () => Promise<PriceTable>;
}

interface StoredPrices {
  readonly fetchedAt: string;
  readonly document: unknown;
}

const UNAVAILABLE: PriceTable = { table: new Map(), status: "unavailable", fetchedAt: null };

async function downloadPrices(): Promise<unknown> {
  const response = await fetch(LITELLM_PRICES_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Price table request failed: ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel();
    throw new Error("Price table is too large.");
  }
  const body = await response.text();
  if (body.length > MAX_DOCUMENT_BYTES) throw new Error("Price table is too large.");
  return JSON.parse(body) as unknown;
}

export function makeUsagePricingSource(options: {
  readonly stateDir: string;
  readonly fetchDocument?: () => Promise<unknown>;
  readonly now?: () => number;
}): UsagePricingSource {
  const filePath = nodePath.join(options.stateDir, "usage-pricing", "litellm-prices.json");
  const now = options.now ?? Date.now;
  const fetchDocument = options.fetchDocument ?? downloadPrices;

  let current: PriceTable | null = null;
  let currentFetchedMs = 0;
  let lastAttemptMs = Number.NEGATIVE_INFINITY;
  let storedRead = false;
  let inFlight: Promise<PriceTable> | null = null;

  const readStored = async (): Promise<void> => {
    storedRead = true;
    try {
      const stored = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<StoredPrices>;
      if (typeof stored.fetchedAt !== "string") return;
      const table = parseRateTable(stored.document);
      if (table.size < MIN_PRICED_MODELS) return;
      current = { table, status: "cached", fetchedAt: stored.fetchedAt };
      currentFetchedMs = Date.parse(stored.fetchedAt) || 0;
    } catch {
      // No saved prices yet.
    }
  };

  const refresh = async (): Promise<PriceTable> => {
    if (!storedRead) await readStored();
    const nowMs = now();
    const stale = current === null || nowMs - currentFetchedMs >= REFRESH_AFTER_MS;
    if (!stale || nowMs - lastAttemptMs < RETRY_AFTER_MS) return current ?? UNAVAILABLE;
    lastAttemptMs = nowMs;
    try {
      const document = await fetchDocument();
      const table = parseRateTable(document);
      if (table.size < MIN_PRICED_MODELS) throw new Error("Price table has too few models.");
      const fetchedAt = new Date(nowMs).toISOString();
      current = { table, status: "fresh", fetchedAt };
      currentFetchedMs = nowMs;
      await fs
        .mkdir(nodePath.dirname(filePath), { recursive: true })
        .then(() =>
          Effect.runPromise(
            writeFileStringAtomically({
              filePath,
              contents: JSON.stringify({ fetchedAt, document } satisfies StoredPrices),
            }),
          ),
        )
        // Not saving only means downloading again after a restart.
        .catch(() => undefined);
    } catch {
      // Offline or the table moved: keep the last good prices, marked as cached.
      if (current) current = { ...current, status: "cached" };
    }
    return current ?? UNAVAILABLE;
  };

  const startRefresh = () => {
    inFlight ??= refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return {
    // Old prices are returned at once while newer ones download, so a request
    // waits on the network only when no prices were ever saved.
    load: async () => {
      if (!storedRead) await readStored();
      if (current) {
        void startRefresh();
        return current;
      }
      return startRefresh();
    },
  };
}
