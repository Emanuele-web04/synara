import { describe, expect, it } from "vitest";
import {
  capturePairingTokenFromHash,
  normalizePairingToken,
  relativeTime,
  takeCapturedPairingToken,
  tokenFromLocationHash,
} from "./mobileLogic";

describe("mobile companion logic", () => {
  it("normalizes manually entered pairing codes", () => {
    expect(normalizePairingToken("ab12-cd34 ef56 7890")).toBe("AB12CD34EF56");
  });

  it("reads pairing credentials from a URL fragment", () => {
    expect(tokenFromLocationHash("#token=ab12-cd34-ef56&ignored=yes")).toBe("AB12CD34EF56");
  });

  it("clears and consumes a captured fragment credential exactly once", () => {
    let cleared = false;
    capturePairingTokenFromHash("#token=ab12-cd34-ef56", () => {
      cleared = true;
    });

    expect(cleared).toBe(true);
    expect(takeCapturedPairingToken()).toBe("AB12CD34EF56");
    expect(takeCapturedPairingToken()).toBe("");
  });

  it("formats recent timestamps without future negative values", () => {
    const now = Date.parse("2026-07-18T12:00:00.000Z");
    expect(relativeTime("2026-07-18T11:42:00.000Z", now)).toBe("18m ago");
    expect(relativeTime("2026-07-18T12:01:00.000Z", now)).toBe("Just now");
  });
});
