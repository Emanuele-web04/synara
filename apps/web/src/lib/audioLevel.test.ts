import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAudioLevelSubscriber } from "./audioLevel";

vi.mock("~/betaFeatures", async () => {
  const { isBetaFeatureEnabled } = await import("@synara/shared/betaFeatures");
  return { isBetaFeatureOn: (feature: string) => isBetaFeatureEnabled(feature, "production") };
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("audio level subscription admission", () => {
  it.each([
    ["Win32", false],
    ["Linux x86_64", false],
    ["MacIntel", true],
  ])("requests Mac audio in Stable only on a supported platform: %s", (platform, supported) => {
    const setSource = vi.fn().mockResolvedValue("unsupported");
    vi.stubGlobal("navigator", { platform });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      desktopBridge: { audioLevel: { setSource, onLevel: () => () => undefined } },
    });

    const unsubscribe = getAudioLevelSubscriber("system")(() => undefined);
    unsubscribe();
    vi.runAllTimers();
    expect(setSource.mock.calls).toEqual(supported ? [["system"], [null]] : []);
  });

  it("passes the chosen microphone to the desktop and keeps one subscriber per choice", () => {
    const setSource = vi.fn().mockResolvedValue("active");
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", {
      desktopBridge: { audioLevel: { setSource, onLevel: () => () => undefined } },
    });

    expect(getAudioLevelSubscriber("both", "BuiltInMicrophoneDevice")).toBe(
      getAudioLevelSubscriber("both", "BuiltInMicrophoneDevice"),
    );
    expect(getAudioLevelSubscriber("system", "BuiltInMicrophoneDevice")).toBe(
      getAudioLevelSubscriber("system"),
    );

    const unsubscribe = getAudioLevelSubscriber("both", "BuiltInMicrophoneDevice")(() => undefined);
    unsubscribe();
    vi.runAllTimers();
    expect(setSource.mock.calls).toEqual([["both", "BuiltInMicrophoneDevice"], [null]]);
  });
});
