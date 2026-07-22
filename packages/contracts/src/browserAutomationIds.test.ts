import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  BoundedUtf8String,
  BrowserAssignmentVersion,
  BrowserAuthorizationEpoch,
  BrowserAuthorizationRequestId,
  BrowserClientId,
  BrowserCommandId,
  BrowserControlEpoch,
  BrowserDesktopInstanceId,
  BrowserDesktopRuntimeId,
  BrowserElementRef,
  BrowserEnvironmentId,
  BrowserHostConnectionId,
  BrowserIdempotencyKey,
  BrowserOperationId,
  BrowserProviderRuntimeGeneration,
  BrowserProviderSessionId,
  BrowserRoutingInventoryVersion,
  BrowserRuntimeGeneration,
  BrowserSnapshotId,
  BrowserTabId,
  BrowserTabRecordVersion,
  BrowserThreadId,
  utf8ByteLength,
} from "./index";

describe("browser automation identities", () => {
  it("brands UUID tab ids and rejects blank ids", () => {
    const id = "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31";
    expect(Schema.decodeUnknownSync(BrowserTabId)(id)).toBe(id);
    expect(() => Schema.decodeUnknownSync(BrowserTabId)("   ")).toThrow();
  });

  it("uses UUIDs for every browser runtime and correlation identity", () => {
    const id = "018f4f7a-4b2a-7c10-8d6e-4c1ac7b92f31";
    const schemas = [
      BrowserDesktopInstanceId,
      BrowserDesktopRuntimeId,
      BrowserHostConnectionId,
      BrowserClientId,
      BrowserOperationId,
      BrowserProviderSessionId,
      BrowserSnapshotId,
      BrowserAuthorizationRequestId,
    ];

    for (const schema of schemas) {
      expect(Schema.is(schema)(id)).toBe(true);
      expect(Schema.is(schema)("not-a-uuid")).toBe(false);
    }
  });

  it("accepts only canonical browser element references", () => {
    for (const ref of ["e1", "e9", "e10", "e9999"]) {
      expect(Schema.decodeUnknownSync(BrowserElementRef)(ref)).toBe(ref);
    }
    for (const ref of ["e0", "e01", "e10000", "E1", "element-1"]) {
      expect(Schema.is(BrowserElementRef)(ref)).toBe(false);
    }
  });

  it("measures composed, decomposed, and multibyte strings in UTF-8 bytes", () => {
    expect(utf8ByteLength("")).toBe(0);
    expect(utf8ByteLength("ascii")).toBe(5);
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("e\u0301")).toBe(3);
    expect(utf8ByteLength("🙂")).toBe(4);
  });

  it("enforces configurable empty, non-empty, ASCII, and multibyte byte bounds", () => {
    const upToFourBytes = BoundedUtf8String(4);
    const oneToFourBytes = BoundedUtf8String(4, 1);

    expect(Schema.is(upToFourBytes)("")).toBe(true);
    expect(Schema.is(oneToFourBytes)("")).toBe(false);
    expect(Schema.is(oneToFourBytes)("abcd")).toBe(true);
    expect(Schema.is(oneToFourBytes)("abcde")).toBe(false);
    expect(Schema.is(oneToFourBytes)("éé")).toBe(true);
    expect(Schema.is(oneToFourBytes)("ééa")).toBe(false);
    expect(Schema.is(oneToFourBytes)("e\u0301")).toBe(true);
    expect(Schema.is(oneToFourBytes)("e\u0301e\u0301")).toBe(false);
    expect(Schema.is(oneToFourBytes)("🙂")).toBe(true);
    expect(Schema.is(oneToFourBytes)("🙂a")).toBe(false);
  });

  it("rejects invalid UTF-8 bound configurations", () => {
    expect(() => BoundedUtf8String(-1)).toThrow(RangeError);
    expect(() => BoundedUtf8String(1, -1)).toThrow(RangeError);
    expect(() => BoundedUtf8String(1, 2)).toThrow(RangeError);
    expect(() => BoundedUtf8String(1.5)).toThrow(RangeError);
  });

  it("accepts only 1-128-byte browser idempotency keys", () => {
    expect(Schema.is(BrowserIdempotencyKey)("")).toBe(false);
    expect(Schema.is(BrowserIdempotencyKey)("a")).toBe(true);
    expect(Schema.is(BrowserIdempotencyKey)("a".repeat(128))).toBe(true);
    expect(Schema.is(BrowserIdempotencyKey)("a".repeat(129))).toBe(false);
    expect(Schema.is(BrowserIdempotencyKey)("é".repeat(64))).toBe(true);
    expect(Schema.is(BrowserIdempotencyKey)("é".repeat(65))).toBe(false);
  });

  it("bounds browser environment, thread, and command ids to 128 UTF-8 bytes", () => {
    for (const schema of [BrowserEnvironmentId, BrowserThreadId, BrowserCommandId]) {
      expect(Schema.is(schema)("a".repeat(128))).toBe(true);
      expect(Schema.is(schema)("a".repeat(129))).toBe(false);
      expect(Schema.is(schema)("é".repeat(64))).toBe(true);
      expect(Schema.is(schema)("é".repeat(65))).toBe(false);
      expect(Schema.is(schema)("   ")).toBe(false);
    }
  });

  it("uses positive integers for authorization and runtime generations", () => {
    for (const schema of [
      BrowserAuthorizationEpoch,
      BrowserProviderRuntimeGeneration,
      BrowserRuntimeGeneration,
    ]) {
      expect(Schema.is(schema)(1)).toBe(true);
      expect(Schema.is(schema)(0)).toBe(false);
      expect(Schema.is(schema)(-1)).toBe(false);
      expect(Schema.is(schema)(1.5)).toBe(false);
    }
  });

  it("uses non-negative integers for control and inventory versions", () => {
    for (const schema of [
      BrowserControlEpoch,
      BrowserTabRecordVersion,
      BrowserAssignmentVersion,
      BrowserRoutingInventoryVersion,
    ]) {
      expect(Schema.is(schema)(0)).toBe(true);
      expect(Schema.is(schema)(1)).toBe(true);
      expect(Schema.is(schema)(-1)).toBe(false);
      expect(Schema.is(schema)(1.5)).toBe(false);
    }
  });

  it("keeps tab record versions monotonic and integer-valued", () => {
    expect(Schema.decodeUnknownSync(BrowserTabRecordVersion)(0)).toBe(0);
    expect(Schema.decodeUnknownSync(BrowserTabRecordVersion)(1)).toBe(1);
    expect(() => Schema.decodeUnknownSync(BrowserTabRecordVersion)(-1)).toThrow();
    expect(() => Schema.decodeUnknownSync(BrowserTabRecordVersion)(1.1)).toThrow();
  });
});
