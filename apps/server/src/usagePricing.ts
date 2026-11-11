// FILE: usagePricing.ts
// Purpose: API list prices per model, to estimate what Synara usage would cost
// for providers that report no cost of their own (Codex). Rates come from
// LiteLLM's public model price table; it is downloaded
// at most once a day and kept in the state folder so prices still load offline.
// Layer: server usage pricing (pure pricing plus a small file-cached loader).

import fs from "node:fs/promises";
import nodePath from "node:path";

import type { StatsUsageAnalyticsPricingStatus } from "@synara/contracts";
import { Effect } from "effect";

import { writeFileStringAtomically } from "./atomicWrite";
import { type TranscriptUsageRecord, transcriptPromptTokens } from "./transcriptUsageParsers";

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
export interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 5-minute cache writes, the default lifetime. */
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
}

export interface ModelRate extends Rates {
  /** Higher rates for prompts above `aboveTokens`, smallest threshold first. */
  readonly tiers: ReadonlyArray<{ readonly aboveTokens: number; readonly rates: Rates }>;
  /** Multiple of the rates billed in fast mode; 1 when the model has none. */
  readonly fastMultiplier: number;
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
  return JSON.stringify(left) === JSON.stringify(right);
}

const TIER_KEY = /^(.+)_above_(\d+)k_tokens$/u;

/** One rate set from LiteLLM field names, falling back to `base` where a tier omits one. */
function readRates(
  key: string,
  field: (name: string) => number | null,
  base?: Rates,
): Rates | null {
  const input = field("input_cost_per_token") ?? base?.input ?? null;
  const output = field("output_cost_per_token") ?? base?.output ?? null;
  if (input === null || output === null) return null;
  const cacheWrite = field("cache_creation_input_token_cost") ?? base?.cacheWrite ?? input;
  return {
    input,
    output,
    // Cached input without its own price is priced as plain input, not as free.
    cacheRead: field("cache_read_input_token_cost") ?? base?.cacheRead ?? input,
    cacheWrite,
    // Anthropic bills 1-hour cache writes at twice the input rate.
    cacheWrite1h:
      field("cache_creation_input_token_cost_above_1hr") ??
      base?.cacheWrite1h ??
      (bareName(key).startsWith("claude") ? input * 2 : cacheWrite),
  };
}

function parseEntry(key: string, entry: Record<string, unknown>): ModelRate | null {
  const base = readRates(key, (name) => finite(entry[name]));
  if (!base) return null;
  const tierFields = new Map<number, Map<string, number>>();
  for (const [name, value] of Object.entries(entry)) {
    const match = TIER_KEY.exec(name);
    const rate = finite(value);
    if (!match || rate === null) continue;
    const threshold = Number(match[2]) * 1000;
    const fields = tierFields.get(threshold) ?? new Map<string, number>();
    fields.set(match[1]!, rate);
    tierFields.set(threshold, fields);
  }
  const tiers = [...tierFields.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([aboveTokens, fields]) => {
      const rates = readRates(key, (name) => fields.get(name) ?? null, base);
      return rates ? [{ aboveTokens, rates }] : [];
    });
  const fast = finite(record(entry.provider_specific_entry)?.fast);
  return { ...base, tiers, fastMultiplier: fast !== null && fast > 0 ? fast : 1 };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
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
    const key = name.trim().toLowerCase();
    const rate = key ? parseEntry(key, raw as Record<string, unknown>) : null;
    if (rate) table.set(key, rate);
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

/**
 * One response from a session file: the file's own cost when it has one, else
 * its tokens at the model's rates, with the long-prompt tier, 1-hour cache
 * writes and fast mode priced at their own rates. Null when the model has no price.
 */
export function priceTranscriptUsage(
  table: RateTable,
  usage: TranscriptUsageRecord,
): number | null {
  if (usage.reportedCostUsd !== null) return usage.reportedCostUsd;
  const rate = lookupRate(table, usage.model);
  if (!rate) return null;
  const prompt = transcriptPromptTokens(usage.tokens);
  let rates: Rates = rate;
  for (const tier of rate.tiers) if (prompt > tier.aboveTokens) rates = tier.rates;
  const tokens = usage.tokens;
  const cost =
    tokens.inputTokens * rates.input +
    tokens.cacheReadTokens * rates.cacheRead +
    tokens.cacheWrite5mTokens * rates.cacheWrite +
    tokens.cacheWrite1hTokens * rates.cacheWrite1h +
    tokens.outputTokens * rates.output;
  return cost * (usage.fast ? rate.fastMultiplier : 1);
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
