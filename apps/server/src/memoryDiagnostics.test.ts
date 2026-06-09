// FILE: memoryDiagnostics.test.ts
// Purpose: Verifies server memory diagnostic payloads and warning thresholds.
// Layer: Server observability tests

import { describe, expect, it } from "vitest";

import {
  shouldWarnServerMemory,
  toServerMemoryDiagnosticLogPayload,
  type ServerMemoryDiagnosticSnapshot,
} from "./memoryDiagnostics";

function snapshot(heapUsedRatio: number): ServerMemoryDiagnosticSnapshot {
  return {
    rssMb: 1200,
    heapUsedMb: 700,
    heapTotalMb: 900,
    heapLimitMb: 1000,
    heapUsedRatio,
    externalMb: 90,
    arrayBuffersMb: 40,
  };
}

describe("toServerMemoryDiagnosticLogPayload", () => {
  it("rounds heap ratio to a readable percentage", () => {
    expect(toServerMemoryDiagnosticLogPayload(snapshot(0.73456))).toEqual({
      rssMb: 1200,
      heapUsedMb: 700,
      heapTotalMb: 900,
      heapLimitMb: 1000,
      heapUsedPercent: 73.5,
      externalMb: 90,
      arrayBuffersMb: 40,
    });
  });
});

describe("shouldWarnServerMemory", () => {
  it("warns at or above the configured heap ratio", () => {
    expect(shouldWarnServerMemory(snapshot(0.69), 0.7)).toBe(false);
    expect(shouldWarnServerMemory(snapshot(0.7), 0.7)).toBe(true);
  });
});
