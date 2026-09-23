import type { ComputerAuditHistoryEntry, ComputerGetAuditHistoryResult } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ComputerAuditHistoryList,
  computerAuditHistoryEntries,
  nextComputerAuditHistoryPage,
} from "./ComputerAuditHistorySection";

function entry(
  index: number,
  effect: ComputerAuditHistoryEntry["effect"] = "dispatched-unknown",
): ComputerAuditHistoryEntry {
  return {
    id: index.toString(16).padStart(64, "0"),
    ts: "2026-09-20T12:00:00.000Z",
    tool: "computer_browser_click",
    effect,
  };
}
function page(
  entries: readonly ComputerAuditHistoryEntry[],
  nextCursor: string | null = "older",
): ComputerGetAuditHistoryResult {
  return { entries, nextCursor, status: "available", truncated: false };
}

describe("Computer audit history", () => {
  it("reduces the final request to the remaining row budget and stops at 100", () => {
    const pages = [0, 30, 60].map((start) =>
      page(Array.from({ length: 30 }, (_, i) => entry(start + i))),
    );
    expect(nextComputerAuditHistoryPage(pages[2]!, pages)).toEqual({ before: "older", limit: 10 });
    const last = page(Array.from({ length: 10 }, (_, i) => entry(90 + i)));
    expect(nextComputerAuditHistoryPage(last, [...pages, last])).toBeUndefined();
    expect(nextComputerAuditHistoryPage(page([], null), [])).toBeUndefined();
  });

  it("deduplicates pages and bounds retained UI rows", () => {
    const entries = Array.from({ length: 110 }, (_, i) => entry(i));
    const result = computerAuditHistoryEntries([page(entries.slice(0, 30)), page(entries)]);
    expect(result).toHaveLength(100);
    expect(new Set(result.map((item) => item.id)).size).toBe(100);
    expect(result[0]?.id).toBe(entry(0).id);
  });

  it("shows delivery uncertainty without raw tool names, correlation IDs or private payloads", () => {
    const record = {
      ...entry(1),
      threadId: "private-thread",
      code: "private_refusal",
      args: { text: "synthetic-secret" },
    };
    const markup = renderToStaticMarkup(
      <ComputerAuditHistoryList entries={[record]} status="available" truncated={false} />,
    );
    expect(markup).toContain("Click in the browser");
    expect(markup).toContain("Sent; effect unconfirmed");
    expect(markup).not.toMatch(
      /computer_browser_click|private-thread|private_refusal|synthetic-secret/,
    );
    expect(markup).not.toContain("Success");
  });

  it.each([
    ["disabled", false, "Action history is not enabled"],
    ["missing", false, "No recorded actions yet"],
    ["available", true, "Older retained actions are no longer available"],
  ] as const)("distinguishes %s history from a successful action", (status, truncated, text) => {
    const markup = renderToStaticMarkup(
      <ComputerAuditHistoryList entries={[]} status={status} truncated={truncated} />,
    );
    expect(markup).toContain(text);
    expect(markup).not.toContain("Success");
  });

  it("labels partial history when retained bounds omitted earlier actions", () => {
    const markup = renderToStaticMarkup(
      <ComputerAuditHistoryList
        entries={[entry(1, "verified")]}
        status="available"
        truncated={true}
      />,
    );
    expect(markup).toContain("Effect observed");
    expect(markup).toContain("This is not a complete history");
  });
});
