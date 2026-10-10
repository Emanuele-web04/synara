import { describe, expect, it } from "vitest";
import {
  extractToolArgumentField,
  isPrefixedToolArgumentSummary,
  parseToolArgumentSummary,
  toolArgumentSummaryToolName,
} from "./toolArgumentSummary";

describe("isPrefixedToolArgumentSummary", () => {
  it("recognizes `ToolName: {json}` and `ToolName: [json]` details", () => {
    expect(
      isPrefixedToolArgumentSummary('mcp__synara__synara_read_thread: {"threadId":"c357"}'),
    ).toBe(true);
    expect(isPrefixedToolArgumentSummary('ToolSearch: {"query":"select:Read"}')).toBe(true);
    expect(isPrefixedToolArgumentSummary('Edit: [{"old":"a","new":"b"}]')).toBe(true);
  });

  it("leaves human-readable details alone", () => {
    expect(isPrefixedToolArgumentSummary("Read 25 lines")).toBe(false);
    expect(isPrefixedToolArgumentSummary("Claude rejected reasoningEffort")).toBe(false);
    expect(isPrefixedToolArgumentSummary('{"threadId":"bare-json"}')).toBe(false);
    expect(isPrefixedToolArgumentSummary("Summary: everything passed")).toBe(false);
  });
});

describe("toolArgumentSummaryToolName", () => {
  it("extracts the identifier prefix whether or not JSON args follow", () => {
    expect(toolArgumentSummaryToolName('ExitPlanMode: {"plan":"Ship it"}')).toBe("ExitPlanMode");
    expect(toolArgumentSummaryToolName("ExitPlanMode: truncated args…")).toBe("ExitPlanMode");
    expect(toolArgumentSummaryToolName('mcp__synara__synara_read_thread: {"threadId":"c3"}')).toBe(
      "mcp__synara__synara_read_thread",
    );
  });

  it("returns null when there is no identifier prefix", () => {
    expect(toolArgumentSummaryToolName("Read 25 lines")).toBeNull();
    expect(toolArgumentSummaryToolName('{"threadId":"bare-json"}')).toBeNull();
    expect(toolArgumentSummaryToolName("Ran the build: it passed")).toBeNull();
  });
});

describe("parseToolArgumentSummary", () => {
  it("splits the tool name from parsed args", () => {
    expect(parseToolArgumentSummary('WebFetch: {"url":"https://example.com"}')).toEqual({
      toolName: "WebFetch",
      args: { url: "https://example.com" },
    });
  });

  it("keeps toolName null for bare JSON and prose prefixes", () => {
    expect(parseToolArgumentSummary('{"file_path":"/a/b.ts"}')).toEqual({
      toolName: null,
      args: { file_path: "/a/b.ts" },
    });
    expect(parseToolArgumentSummary('Read {"file_path":"/a/b.ts"}')?.toolName).toBeNull();
  });

  it("returns null args for malformed JSON and null for no JSON at all", () => {
    expect(parseToolArgumentSummary('Read: {"file_path":"/a/b.ts"')).toBeNull();
    expect(parseToolArgumentSummary('Read: {"file_path":}')).toEqual({
      toolName: "Read",
      args: null,
    });
    expect(parseToolArgumentSummary("Read 25 lines")).toBeNull();
  });
});

describe("extractToolArgumentField", () => {
  it("prefers parsed top-level fields in key order", () => {
    expect(
      extractToolArgumentField('Read: {"file_path":"/a/b.ts","offset":10}', ["file_path", "path"]),
    ).toBe("/a/b.ts");
  });

  it("falls back to a regex scan for malformed or nested JSON", () => {
    expect(
      extractToolArgumentField('Read: {"file_path":"/a/b.ts",', ["file_path", "path"]),
    ).toBeNull();
    expect(
      extractToolArgumentField('Read: {"file_path":"/a/b.ts", "broken": }', ["file_path"]),
    ).toBe("/a/b.ts");
    expect(
      extractToolArgumentField('Call: {"input":{"url":"https://example.com"}}', ["url", "uri"]),
    ).toBe("https://example.com");
  });

  it('with fallbackScan "whenUnparsed", skips nested fields of parsed args but still resolves truncated JSON', () => {
    expect(
      extractToolArgumentField('Task: {"config":{"path":"/nested/dir"}}', ["path"], {
        fallbackScan: "whenUnparsed",
      }),
    ).toBeNull();
    expect(
      extractToolArgumentField('Read: {"file_path":"/a/b.ts", "broken": }', ["file_path"], {
        fallbackScan: "whenUnparsed",
      }),
    ).toBe("/a/b.ts");
  });

  it("returns null when the detail has no JSON slice or no matching field", () => {
    expect(extractToolArgumentField("Read 25 lines", ["file_path"])).toBeNull();
    expect(extractToolArgumentField('Read: {"offset":10}', ["file_path"])).toBeNull();
  });
});
