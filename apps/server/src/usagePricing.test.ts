// FILE: usagePricing.test.ts
// Purpose: LiteLLM rate parsing, model lookup, token pricing, and the daily
// file-cached price list loader.
// Layer: Server usage pricing tests

import fs from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { lookupRate, makeUsagePricingSource, parseRateTable, priceTokens } from "./usagePricing";

const DOCUMENT = {
  sample_spec: { input_cost_per_token: "not a number" },
  "gpt-5-codex": {
    input_cost_per_token: 1.25e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1.25e-7,
  },
  "claude-opus-5-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "openrouter/only-here": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  "a/conflict": { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
  "b/conflict": { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
  "no-output": { input_cost_per_token: 1e-6 },
};

/** A document big enough to pass the loader's sanity check. */
function largeDocument(inputCost: number) {
  return {
    ...DOCUMENT,
    ...Object.fromEntries(
      Array.from({ length: 120 }, (_, index) => [
        `filler-${index}`,
        { input_cost_per_token: inputCost, output_cost_per_token: inputCost },
      ]),
    ),
  };
}

describe("parseRateTable", () => {
  const table = parseRateTable(DOCUMENT);

  it("keeps models with both input and output prices", () => {
    expect(table.has("gpt-5-codex")).toBe(true);
    expect(table.has("no-output")).toBe(false);
    expect(table.has("sample_spec")).toBe(false);
  });

  it("prices missing cache rates as plain input", () => {
    expect(table.get("gpt-5-codex")).toEqual({
      input: 1.25e-6,
      output: 1e-5,
      cacheRead: 1.25e-7,
      cacheWrite: 1.25e-6,
    });
  });

  it("adds a bare alias only when every qualified entry agrees", () => {
    expect(table.has("only-here")).toBe(true);
    expect(table.has("conflict")).toBe(false);
  });
});

describe("lookupRate", () => {
  const table = parseRateTable(DOCUMENT);

  it("ignores case, context variants and date suffixes", () => {
    expect(lookupRate(table, "Claude-Opus-5-5")).not.toBeNull();
    expect(lookupRate(table, "claude-opus-5-5[1m]")).not.toBeNull();
    expect(lookupRate(table, "claude-opus-5-5-20260301")).not.toBeNull();
  });

  it("never prices synthetic messages or bare family names", () => {
    expect(lookupRate(table, "<synthetic>")).toBeNull();
    expect(lookupRate(table, "opus")).toBeNull();
    expect(lookupRate(table, "unknown-model")).toBeNull();
  });
});

describe("priceTokens", () => {
  it("prices each token part at its own rate", () => {
    const table = parseRateTable(DOCUMENT);
    const cost = priceTokens(table, "claude-opus-5-5", {
      inputTokens: 1_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
      outputTokens: 500,
    });
    expect(cost).toBeCloseTo(1_000 * 5e-6 + 10_000 * 5e-7 + 2_000 * 6.25e-6 + 500 * 2.5e-5, 12);
    expect(
      priceTokens(table, "unknown", {
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toBeNull();
  });
});

describe("makeUsagePricingSource", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })),
    );
  });
  const stateDir = async () => {
    const path = await fs.mkdtemp(nodePath.join(os.tmpdir(), "usage-pricing-"));
    directories.push(path);
    return path;
  };

  it("downloads once a day and reuses the saved copy after a restart", async () => {
    const dir = await stateDir();
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    let downloads = 0;
    const fetchDocument = async () => {
      downloads += 1;
      return largeDocument(1e-6);
    };
    const source = makeUsagePricingSource({ stateDir: dir, fetchDocument, now: () => now });

    const first = await source.load();
    expect(first.status).toBe("fresh");
    expect(lookupRate(first.table, "gpt-5-codex")).not.toBeNull();
    now += 60 * 60 * 1000;
    await source.load();
    expect(downloads).toBe(1);

    // A new server reads the saved prices instead of downloading again.
    const restarted = makeUsagePricingSource({ stateDir: dir, fetchDocument, now: () => now });
    expect((await restarted.load()).status).toBe("cached");
    expect(downloads).toBe(1);
  });

  it("keeps the last prices when a refresh fails, and reports none without any", async () => {
    const dir = await stateDir();
    let now = Date.parse("2026-10-01T00:00:00.000Z");
    let online = true;
    const source = makeUsagePricingSource({
      stateDir: dir,
      now: () => now,
      fetchDocument: async () => {
        if (!online) throw new Error("offline");
        return largeDocument(1e-6);
      },
    });
    await source.load();
    online = false;
    now += 25 * 60 * 60 * 1000;
    // Old prices come back at once; the failed refresh then marks them cached.
    expect((await source.load()).table.size).toBeGreaterThan(100);
    await vi.waitFor(async () => expect((await source.load()).status).toBe("cached"));

    const empty = makeUsagePricingSource({
      stateDir: await stateDir(),
      fetchDocument: async () => {
        throw new Error("offline");
      },
    });
    expect(await empty.load()).toMatchObject({ status: "unavailable", fetchedAt: null });
  });

  it("rejects a document that is not a price table", async () => {
    const source = makeUsagePricingSource({
      stateDir: await stateDir(),
      fetchDocument: async () => DOCUMENT,
    });
    expect((await source.load()).status).toBe("unavailable");
  });
});
