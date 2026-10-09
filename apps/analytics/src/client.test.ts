// FILE: src/client.test.ts
// Purpose: Unit coverage for DOM-free client helpers — debounce timing,
// filter picking, login error copy, and hash parsing. Runs in plain vitest.

import { describe, expect, it, vi } from "vitest";

import { createDebounced } from "./debounce";
import {
  EMPTY_FILTERS,
  loginErrorMessage,
  pickFilters,
  productFiltersQuery,
  type Filters,
} from "./api";
import { parseHash, routeHash } from "./filters";

describe("createDebounced", () => {
  it("commits once after the quiet period, latest value wins", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const debounced = createDebounced((v: string) => calls.push(v), 300);
    debounced("a");
    debounced("ab");
    vi.advanceTimersByTime(299);
    expect(calls).toEqual([]);
    debounced("abc");
    vi.advanceTimersByTime(300);
    expect(calls).toEqual(["abc"]);
    vi.useRealTimers();
  });

  it("cancel drops a pending commit", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    const debounced = createDebounced((v: string) => calls.push(v), 300);
    debounced("x");
    debounced.cancel();
    vi.advanceTimersByTime(1000);
    expect(calls).toEqual([]);
    vi.useRealTimers();
  });
});

describe("pickFilters", () => {
  const full: Filters = {
    days: 30,
    version: "0.9.4-beta.1",
    platform: "darwin",
    kind: "crash",
    q: "quota",
  };

  it("keeps only the view's exposed params plus days", () => {
    expect(pickFilters(full, ["version", "platform", "kind", "q"])).toEqual(full);
    expect(pickFilters(full, ["version", "platform"])).toEqual({
      ...EMPTY_FILTERS,
      days: 30,
      version: "0.9.4-beta.1",
      platform: "darwin",
    });
    expect(pickFilters(full, ["platform"])).toEqual({
      ...EMPTY_FILTERS,
      days: 30,
      platform: "darwin",
    });
  });
});

describe("loginErrorMessage", () => {
  it("maps network failure, 429 and 401 to distinct copy", () => {
    expect(loginErrorMessage(null)).toBe("Couldn't reach the server. Try again.");
    expect(loginErrorMessage(new Response(null, { status: 429 }))).toBe(
      "Too many attempts. Wait a minute and try again.",
    );
    expect(loginErrorMessage(new Response(null, { status: 401 }))).toBe("Wrong password.");
    expect(loginErrorMessage(new Response(null, { status: 500 }))).toBe("Wrong password.");
  });
});

describe("product filters", () => {
  it("serializes only the product dashboard's range, channel, and surface filters", () => {
    expect(
      productFiltersQuery({
        from: "2026-10-01",
        to: "2026-10-05",
        channel: "stable",
        surface: "desktop",
      }),
    ).toBe("?from=2026-10-01&to=2026-10-05&channel=stable&surface=desktop");
    expect(parseHash("#/product").route).toEqual({ view: "product" });
  });
});

describe("parseHash", () => {
  it("round-trips product section links and keeps invalid sections in Product", () => {
    for (const section of ["overview", "providers", "tokens", "reliability"] as const) {
      const route = { view: "product", section } as const;
      expect(parseHash(routeHash(route, EMPTY_FILTERS)).route).toEqual(route);
    }
    expect(parseHash("#/product/not-a-section").route).toEqual({ view: "product" });
    expect(parseHash("#/product/providers?days=14").filters.days).toBe(14);
  });

  it("clamps days into the supported range", () => {
    expect(parseHash("#/?days=0").filters.days).toBe(7);
    expect(parseHash("#/?days=14").filters.days).toBe(14);
    expect(parseHash("#/?days=9999").filters.days).toBe(365);
  });

  it("ignores params the client no longer parses", () => {
    const { filters } = parseHash("#/?days=14&source=gpu&platform=darwin");
    expect(filters.days).toBe(14);
    expect(filters.platform).toBe("darwin");
    expect("source" in filters).toBe(false);
  });
});
