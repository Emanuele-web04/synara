// FILE: threadExport.test.ts
// Purpose: Verifies the shared export-eligibility guard used by the server
//          export route (409) and the web composer's /export availability.
// Layer: Shared utility tests

import { describe, expect, it } from "vitest";

import { threadExportBlockedReason } from "./threadExport";

const settledMessages = [{ streaming: false }, { streaming: false }];

describe("threadExportBlockedReason", () => {
  it("allows export for a settled thread", () => {
    expect(threadExportBlockedReason({ latestTurn: null, messages: settledMessages })).toBeNull();
  });

  it("allows export when the latest turn has settled", () => {
    expect(
      threadExportBlockedReason({
        latestTurn: { state: "completed" },
        messages: settledMessages,
      }),
    ).toBeNull();
  });

  it("blocks export while the latest turn is running", () => {
    expect(
      threadExportBlockedReason({ latestTurn: { state: "running" }, messages: settledMessages }),
    ).toMatch(/still running/);
  });

  it("blocks export while any message is still streaming", () => {
    expect(
      threadExportBlockedReason({
        latestTurn: { state: "completed" },
        messages: [...settledMessages, { streaming: true }],
      }),
    ).toMatch(/streaming/);
  });
});
