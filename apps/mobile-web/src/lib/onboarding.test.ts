import { describe, expect, it } from "vitest";
import { isIosPlatform, isStandaloneDisplay } from "./install";
import {
  clearPostPairOnboardingPending,
  isPostPairOnboardingPending,
  markPostPairOnboardingPending,
} from "./onboarding";

describe("mobile onboarding", () => {
  it("recognizes iPhone, iPad, and desktop-mode iPadOS", () => {
    expect(
      isIosPlatform({ userAgent: "Mozilla/5.0 (iPhone)", platform: "iPhone", maxTouchPoints: 5 }),
    ).toBe(true);
    expect(
      isIosPlatform({ userAgent: "Mozilla/5.0", platform: "MacIntel", maxTouchPoints: 5 }),
    ).toBe(true);
    expect(
      isIosPlatform({ userAgent: "Mozilla/5.0", platform: "MacIntel", maxTouchPoints: 0 }),
    ).toBe(false);
  });

  it("recognizes browser and iOS standalone display modes", () => {
    expect(isStandaloneDisplay({ displayModeStandalone: true })).toBe(true);
    expect(
      isStandaloneDisplay({ displayModeStandalone: false, navigatorStandalone: true }),
    ).toBe(true);
    expect(isStandaloneDisplay({ displayModeStandalone: false })).toBe(false);
  });

  it("keeps the post-pair guide pending without storing sensitive state", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };

    expect(isPostPairOnboardingPending(storage)).toBe(false);
    markPostPairOnboardingPending(storage);
    expect(isPostPairOnboardingPending(storage)).toBe(true);
    expect([...values.values()]).toEqual(["true"]);
    clearPostPairOnboardingPending(storage);
    expect(isPostPairOnboardingPending(storage)).toBe(false);
  });

  it("never turns blocked browser storage into a pairing failure", () => {
    const blockedStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };

    expect(() => markPostPairOnboardingPending(blockedStorage)).not.toThrow();
    expect(isPostPairOnboardingPending(blockedStorage)).toBe(false);
    expect(() => clearPostPairOnboardingPending(blockedStorage)).not.toThrow();
  });
});
