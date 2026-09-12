import { describe, expect, it } from "vitest";

import { formatMindCountLabel, isMindListTruncated, optimisticForgetCount } from "./mindList";

describe("isMindListTruncated", () => {
  it("is truncated only when fewer rows are shown than the true total", () => {
    expect(isMindListTruncated({ shown: 500, total: 2300 })).toBe(true);
    expect(isMindListTruncated({ shown: 2, total: 2 })).toBe(false);
    expect(isMindListTruncated({ shown: 0, total: 0 })).toBe(false);
  });
});

describe("formatMindCountLabel", () => {
  it("renders the plain count when the whole store is loaded", () => {
    expect(formatMindCountLabel({ shown: 2, total: 2, pinnedCount: 1, cap: 500 })).toBe(
      "2 memories · 1 pinned · cap 500",
    );
  });

  it("renders the singular noun for one memory", () => {
    expect(formatMindCountLabel({ shown: 1, total: 1, pinnedCount: 0, cap: 500 })).toBe(
      "1 memory · 0 pinned · cap 500",
    );
  });

  it("renders showing X of N when the page is truncated", () => {
    expect(formatMindCountLabel({ shown: 500, total: 2300, pinnedCount: 12, cap: 500 })).toBe(
      "Showing 500 of 2300 memories · 12 pinned · cap 500",
    );
  });
});

describe("optimisticForgetCount", () => {
  it("decrements when the whole store is loaded", () => {
    expect(optimisticForgetCount({ count: 2, shown: 2 })).toBe(1);
    expect(optimisticForgetCount({ count: 0, shown: 0 })).toBe(0);
  });

  it("keeps the true total while truncated so the refetch converges it", () => {
    expect(optimisticForgetCount({ count: 2300, shown: 500 })).toBe(2300);
  });
});
