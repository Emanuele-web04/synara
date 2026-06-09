import { describe, expect, it } from "vitest";

import { closeOpenReviewTab, upsertCurrentTab, type OpenReviewTab } from "./ReviewBrowserTabs";

const tabs = [
  { reference: "7208", title: "POC write targets" },
  { reference: "7866", title: "Dashboard vitest harness" },
  { reference: "7870", title: "Task assignment buckets" },
] satisfies ReadonlyArray<OpenReviewTab>;

describe("ReviewBrowserTabs logic", () => {
  it("updates the current tab title without moving its position", () => {
    expect(upsertCurrentTab(tabs, "7866", "Updated title")).toEqual([
      { reference: "7208", title: "POC write targets" },
      { reference: "7866", title: "Updated title" },
      { reference: "7870", title: "Task assignment buckets" },
    ]);
  });

  it("appends a new tab without reordering open tabs", () => {
    expect(upsertCurrentTab(tabs, "#7871", "New review")).toEqual([
      ...tabs,
      { reference: "7871", title: "New review" },
    ]);
  });

  it("closes inactive tabs without changing the active reference", () => {
    expect(closeOpenReviewTab(tabs, "7208", "7866")).toEqual({
      tabs: [
        { reference: "7866", title: "Dashboard vitest harness" },
        { reference: "7870", title: "Task assignment buckets" },
      ],
      nextReference: null,
    });
  });

  it("closes the active tab and selects the left neighbor", () => {
    expect(closeOpenReviewTab(tabs, "7866", "7866")).toEqual({
      tabs: [
        { reference: "7208", title: "POC write targets" },
        { reference: "7870", title: "Task assignment buckets" },
      ],
      nextReference: "7208",
    });
  });

  it("closes the last active tab and reports no fallback reference", () => {
    expect(closeOpenReviewTab([{ reference: "7866", title: null }], "7866", "7866")).toEqual({
      tabs: [],
      nextReference: null,
    });
  });
});
