import { describe, expect, it } from "vitest";

import { isPlainObject, sanitizeStringKeyedRecord } from "./persistedRecord";

describe("isPlainObject", () => {
  it("accepts plain objects only", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject("x")).toBe(false);
    expect(isPlainObject(7)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe("sanitizeStringKeyedRecord", () => {
  it("returns an empty record for non-object input", () => {
    expect(sanitizeStringKeyedRecord(null, () => 1)).toEqual({});
    expect(sanitizeStringKeyedRecord([1, 2], () => 1)).toEqual({});
  });

  it("keeps entries the sanitizer accepts and drops the ones it rejects", () => {
    const result = sanitizeStringKeyedRecord<number>({ a: "1", b: "x", c: "3" }, (raw) => {
      const parsed = Number(raw);
      return Number.isFinite(parsed) && raw !== "x" ? parsed : null;
    });

    expect(result).toEqual({ a: 1, c: 3 });
  });

  it("does not mutate or share the input reference", () => {
    const input = { a: { keep: true } };
    const result = sanitizeStringKeyedRecord(input, (raw) => raw);

    expect(result).not.toBe(input);
    expect(result.a).toBe(input.a);
  });

  it("ignores prototype-polluting keys from untrusted input", () => {
    const malicious = JSON.parse('{"safe": 1, "__proto__": {"polluted": true}, "constructor": 2}');

    const result = sanitizeStringKeyedRecord<unknown>(malicious, (raw) => raw);

    expect(result).toEqual({ safe: 1 });
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(Object.hasOwn(result, "constructor")).toBe(false);
    // The global prototype must remain untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
