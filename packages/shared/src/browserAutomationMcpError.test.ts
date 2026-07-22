import { describe, expect, it } from "vitest";

import {
  BROWSER_TOOL_DEFINITIONS_BY_NAME,
  stableJsonStringify,
} from "./browserAutomationCatalogue";
import { makeBrowserAutomationError } from "./browserAutomationErrors";
import { decodeBrowserMcpToolError, encodeBrowserMcpToolError } from "./browserAutomationMcpError";

const STALE_REFERENCE_ERROR = makeBrowserAutomationError({
  code: "BrowserStaleReference",
  retryable: true,
  phase: "target",
  effectMayHaveCommitted: false,
});

describe("browser MCP tool error codec", () => {
  it("round-trips the one canonical MCP tool-error result", () => {
    const encoded = encodeBrowserMcpToolError(STALE_REFERENCE_ERROR);
    expect(encoded).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: stableJsonStringify({
            type: "synara_browser_error",
            version: 1,
            error: STALE_REFERENCE_ERROR,
          }),
        },
      ],
    });
    expect(
      decodeBrowserMcpToolError(encoded, {
        definition: BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_click,
        dispatchState: "dispatched",
      }),
    ).toEqual(STALE_REFERENCE_ERROR);
  });

  it("treats malformed post-dispatch effecting results as possibly committed", () => {
    const malformed = { isError: true, content: [{ type: "text", text: "not-json" }] };
    expect(
      decodeBrowserMcpToolError(malformed, {
        definition: BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_click,
        dispatchState: "dispatched",
      }),
    ).toMatchObject({ code: "BrowserMalformedResponse", effectMayHaveCommitted: true });
    expect(
      decodeBrowserMcpToolError(malformed, {
        definition: BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_snapshot,
        dispatchState: "dispatched",
      }),
    ).toMatchObject({ code: "BrowserMalformedResponse", effectMayHaveCommitted: false });
    expect(decodeBrowserMcpToolError(malformed, { dispatchState: "unknown" })).toMatchObject({
      effectMayHaveCommitted: true,
    });
  });

  it("rejects extra fields and never reflects malformed input", () => {
    const decoded = decodeBrowserMcpToolError(
      { isError: true, content: [{ type: "text", text: "secret-token" }], extra: true },
      { dispatchState: "unknown" },
    );
    expect(decoded.code).toBe("BrowserMalformedResponse");
    expect(decoded.message).not.toContain("secret-token");
  });
});
