import { describe, expect, it } from "vitest";

import {
  normalizeAtifExport,
  normalizeCloudMessages,
  normalizeLocalTranscript,
} from "./devinHistoryNormalizer.ts";
import type { DevinLocalRawMessage } from "./devinLocalHistory.ts";
import { parseDevinAtifExport } from "./devinAtifHistory.ts";

const node = (input: Partial<DevinLocalRawMessage> & { nodeId: number }): DevinLocalRawMessage => ({
  messageId: `m-${input.nodeId}`,
  role: "assistant",
  content: "text",
  isUserInput: false,
  createdAt: null,
  ...input,
});

describe("normalizeLocalTranscript", () => {
  it("keeps user input and assistant text, drops system/tool/hidden", () => {
    const result = normalizeLocalTranscript([
      node({ nodeId: 0, role: "system" }),
      node({ nodeId: 1, role: "user", content: "hello", isUserInput: true }),
      node({ nodeId: 2, role: "assistant", content: "answer" }),
      node({ nodeId: 3, role: "tool", content: "out" }),
      node({ nodeId: 4, role: "user", content: "hidden ctx", isUserInput: false }),
      node({ nodeId: 5, role: "assistant", content: "" }),
    ]);
    expect(result.messages.map((m) => [m.upstreamMessageId, m.role])).toEqual([
      ["m-1", "user"],
      ["m-2", "assistant"],
    ]);
    expect(result.fidelity.dropped).toEqual({
      system: 1,
      tool: 1,
      hiddenUser: 1,
      empty: 1,
      duplicate: 0,
      unsupported: 0,
    });
  });

  it("strips the Synara host context wrapper from user text", () => {
    const result = normalizeLocalTranscript([
      node({
        nodeId: 1,
        role: "user",
        isUserInput: true,
        content: "<synara_host_context>policy</synara_host_context>\n\nactual question",
      }),
    ]);
    expect(result.messages[0]?.text).toBe("actual question");
  });

  it("dedupes repeated message_ids and keeps identical texts under different ids", () => {
    const result = normalizeLocalTranscript([
      node({ nodeId: 1, role: "assistant", content: "same", messageId: "dup" }),
      node({ nodeId: 2, role: "assistant", content: "same", messageId: "dup" }),
      node({ nodeId: 3, role: "assistant", content: "same", messageId: "other" }),
    ]);
    expect(result.messages.map((m) => m.upstreamMessageId)).toEqual(["dup", "other"]);
    expect(result.fidelity.dropped.duplicate).toBe(1);
  });

  it("marks missing timestamps as fallback-deterministic", () => {
    const withTs = node({ nodeId: 1, createdAt: "2026-11-23T12:00:00Z" });
    const withoutTs = node({ nodeId: 2, createdAt: null });
    const result = normalizeLocalTranscript([withTs, withoutTs]);
    expect(result.messages[0]?.timestampProvenance).toBe("source");
    expect(result.messages[1]?.timestampProvenance).toBe("fallback-deterministic");
  });
});

describe("normalizeCloudMessages", () => {
  it("maps user/devin sources", () => {
    const result = normalizeCloudMessages([
      { eventId: "e1", source: "user", message: "q", createdAt: "2026-11-23T12:00:00Z" },
      { eventId: "e2", source: "devin", message: "a", createdAt: "2026-11-23T12:00:01Z" },
    ]);
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("normalizeAtifExport + parseDevinAtifExport", () => {
  it("parses the documented steps shape", () => {
    const atif = parseDevinAtifExport(
      JSON.stringify({
        schema_version: "atif-v1.0",
        agent: { name: "devin", version: "3000.14" },
        steps: [
          { step_id: "s1", source: "user", message: "do it", timestamp: "2026-11-23T12:00:00Z" },
          { step_id: "s2", source: "agent", message: "done" },
          { step_id: "s3", source: "tool", message: "out" },
        ],
      }),
    );
    const result = normalizeAtifExport(atif);
    expect(result.messages.map((m) => [m.upstreamMessageId, m.role])).toEqual([
      ["s1", "user"],
      ["s2", "assistant"],
    ]);
    expect(result.fidelity.dropped.tool).toBe(1);
  });

  it("synthesizes stable ids for steps without step_id", () => {
    const json = JSON.stringify({
      steps: [
        { source: "user", message: "same" },
        { source: "user", message: "same" },
      ],
    });
    const first = normalizeAtifExport(parseDevinAtifExport(json));
    const second = normalizeAtifExport(parseDevinAtifExport(json));
    expect(first.messages).toHaveLength(2);
    expect(first.messages[0]?.upstreamMessageId).not.toBe(first.messages[1]?.upstreamMessageId);
    expect(first.messages.map((m) => m.upstreamMessageId)).toEqual(
      second.messages.map((m) => m.upstreamMessageId),
    );
  });

  it("rejects non-ATIF JSON with unsupported-version", () => {
    expect(() => parseDevinAtifExport(JSON.stringify({ hello: 1 }))).toThrowError(
      expect.objectContaining({ code: "unsupported-version" }) as Error,
    );
  });
});
