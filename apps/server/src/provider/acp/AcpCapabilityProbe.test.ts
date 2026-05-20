import { describe, expect, it } from "vitest";

import {
  detailFromAcpProbeLogs,
  parseAcpJsonRpcLine,
  pushAcpLogLine,
  truncateAcpLogLine,
} from "./AcpCapabilityProbe.ts";

describe("AcpCapabilityProbe helpers", () => {
  it("truncates long log lines", () => {
    expect(truncateAcpLogLine("x".repeat(300)).endsWith("...")).toBe(true);
  });

  it("keeps only the latest non-json log lines", () => {
    const lines: string[] = [];
    pushAcpLogLine(lines, '{"jsonrpc":"2.0"}');
    pushAcpLogLine(lines, "line one");
    pushAcpLogLine(lines, "line two");
    expect(lines).toEqual(["line one", "line two"]);
  });

  it("parses json rpc lines", () => {
    expect(parseAcpJsonRpcLine('{"jsonrpc":"2.0","id":1}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
    });
  });

  it("prefers stderr detail when present", () => {
    expect(detailFromAcpProbeLogs(["stdout"], ["stderr"])).toBe("stderr");
  });
});
