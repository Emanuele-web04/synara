// FILE: handoff.test.ts
// Purpose: Verifies bootstrap transcripts stay within the replay char budget.
// Layer: Orchestration mapping tests
// Depends on: handoff.

import { MessageId, type OrchestrationMessage } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { buildPriorTranscriptBootstrapText } from "./handoff.ts";

const message = (
  index: number,
  role: "user" | "assistant",
  text: string,
): OrchestrationMessage => ({
  id: MessageId.makeUnsafe(`message-${index}`),
  role,
  text,
  turnId: null,
  streaming: false,
  source: "native",
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
});

const thread = (messages: ReadonlyArray<OrchestrationMessage>) => ({
  title: "Budgeted thread",
  branch: null,
  worktreePath: null,
  messages,
});

describe("buildPriorTranscriptBootstrapText", () => {
  it("keeps every message with a plain summary header when under budget", () => {
    const messages = Array.from({ length: 10 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} short message`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-9");

    expect(text).not.toBeNull();
    expect(text).toContain("Earlier conversation summary:");
    expect(text).not.toContain("omitted to fit the context budget");
    for (let index = 0; index < 9; index += 1) {
      expect(text).toContain(`marker-${index}`);
    }
  });

  it("drops the oldest summaries and notes the omission when over budget", () => {
    const filler = "x".repeat(400);
    const messages = Array.from({ length: 301 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-300");

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain("omitted to fit the context budget");
    // The most recent messages survive verbatim; the oldest summaries are gone.
    expect(text).toContain("marker-299");
    expect(text).toContain("marker-294");
    expect(text).not.toContain("marker-0 ");
    expect(text).not.toContain("marker-1 ");
    // Kept summaries stay in chronological order.
    expect(text!.indexOf("marker-250")).toBeLessThan(text!.indexOf("marker-290"));
  });

  it("respects a caller budget smaller than the transcript ceiling", () => {
    const filler = "y".repeat(400);
    const messages = Array.from({ length: 60 }, (_, index) =>
      message(index, index % 2 === 0 ? "user" : "assistant", `marker-${index} ${filler}`),
    );
    const text = buildPriorTranscriptBootstrapText(thread(messages), "message-59", 8_000);

    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(8_000);
    expect(text).toContain("marker-58");
  });
});
