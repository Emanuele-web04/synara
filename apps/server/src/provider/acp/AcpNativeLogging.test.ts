import { describe, expect, it } from "vitest";

import { redactAcpLogPayload } from "./AcpNativeLogging";

describe("redactAcpLogPayload", () => {
  it("removes Canvas bridge capabilities from nested ACP session payloads", () => {
    expect(
      redactAcpLogPayload({
        mcpServers: [
          {
            name: "synara-excalidraw",
            env: [
              { name: "SYNARA_CANVAS_BRIDGE_TOKEN", value: "bridge-secret" },
              { name: "SYNARA_CANVAS_THREAD_ID", value: "drawing-1" },
            ],
          },
        ],
        authorization: "Bearer bridge-secret",
      }),
    ).toEqual({
      mcpServers: [
        {
          name: "synara-excalidraw",
          env: [
            { name: "SYNARA_CANVAS_BRIDGE_TOKEN", value: "[REDACTED]" },
            { name: "SYNARA_CANVAS_THREAD_ID", value: "drawing-1" },
          ],
        },
      ],
      authorization: "[REDACTED]",
    });
  });

  it("distinguishes repeated references from actual cycles", () => {
    const shared = { name: "ordinary", value: "visible" };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(redactAcpLogPayload({ first: shared, second: shared, cyclic })).toEqual({
      first: shared,
      second: shared,
      cyclic: { self: "[Circular]" },
    });
  });
});
