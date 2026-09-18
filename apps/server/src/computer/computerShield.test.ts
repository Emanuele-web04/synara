import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cuaMaskedActivationEnabled,
  cuaMaskedActivationOptIn,
  maskedActivationOptedIn,
} from "./computerShield.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cuaMaskedActivationEnabled", () => {
  it("is off by default and off for unset or empty values", () => {
    expect(cuaMaskedActivationEnabled()).toBe(false);
    vi.stubEnv("SYNARA_CUA_MASKED_ACTIVATION", "");
    expect(cuaMaskedActivationEnabled()).toBe(false);
    vi.stubEnv("SYNARA_CUA_MASKED_ACTIVATION", "   ");
    expect(cuaMaskedActivationEnabled()).toBe(false);
  });

  it("accepts the affirmative spellings", () => {
    for (const value of ["1", "true", "on", "yes", "TRUE", " Yes ", "ON"]) {
      vi.stubEnv("SYNARA_CUA_MASKED_ACTIVATION", value);
      expect(cuaMaskedActivationEnabled(), `value ${JSON.stringify(value)}`).toBe(true);
    }
  });

  it("rejects every other spelling rather than guessing", () => {
    for (const value of ["0", "false", "off", "no", "enabled", "2", "tru", "yes please"]) {
      vi.stubEnv("SYNARA_CUA_MASKED_ACTIVATION", value);
      expect(cuaMaskedActivationEnabled(), `value ${JSON.stringify(value)}`).toBe(false);
    }
  });
});

describe("cuaMaskedActivationOptIn", () => {
  it("is empty by default and for a blank list", () => {
    expect(cuaMaskedActivationOptIn().size).toBe(0);
    vi.stubEnv("SYNARA_CUA_MASKED_APPS", "");
    expect(cuaMaskedActivationOptIn().size).toBe(0);
    vi.stubEnv("SYNARA_CUA_MASKED_APPS", " , ;  ");
    expect(cuaMaskedActivationOptIn().size).toBe(0);
  });

  it("splits on commas, semicolons, and whitespace, and lowercases entries", () => {
    vi.stubEnv(
      "SYNARA_CUA_MASKED_APPS",
      " com.example.Foo,COM.EXAMPLE.BAR ;org.kde.kcalc\tnet.example.Baz ",
    );
    expect([...cuaMaskedActivationOptIn()].sort()).toEqual([
      "com.example.bar",
      "com.example.foo",
      "net.example.baz",
      "org.kde.kcalc",
    ]);
  });

  it("deduplicates repeated ids", () => {
    vi.stubEnv("SYNARA_CUA_MASKED_APPS", "com.example.foo,COM.EXAMPLE.FOO");
    expect(cuaMaskedActivationOptIn().size).toBe(1);
  });
});

describe("maskedActivationOptedIn", () => {
  const optIn = new Set(["com.example.foo"]);

  it("matches case-insensitively and ignores surrounding whitespace", () => {
    expect(maskedActivationOptedIn(optIn, "COM.EXAMPLE.FOO")).toBe(true);
    expect(maskedActivationOptedIn(optIn, " com.example.foo ")).toBe(true);
  });

  it("does not match an absent, blank, or different bundle id", () => {
    expect(maskedActivationOptedIn(optIn, undefined)).toBe(false);
    expect(maskedActivationOptedIn(optIn, "")).toBe(false);
    expect(maskedActivationOptedIn(optIn, "com.example.other")).toBe(false);
    expect(maskedActivationOptedIn(new Set(), "com.example.foo")).toBe(false);
  });
});
