import { describe, expect, it } from "vitest";

import { isTrustedDesktopRendererUrl } from "./desktopRendererTrust";

describe("desktop renderer trust", () => {
  it("accepts only the packaged Synara app host", () => {
    expect(isTrustedDesktopRendererUrl("synara://app/settings?section=remote-access", null)).toBe(
      true,
    );
    expect(isTrustedDesktopRendererUrl("synara://attacker/settings", null)).toBe(false);
    expect(isTrustedDesktopRendererUrl("https://example.com", null)).toBe(false);
  });

  it("accepts only the configured development origin", () => {
    const developmentUrl = "http://127.0.0.1:5173";
    expect(isTrustedDesktopRendererUrl("http://127.0.0.1:5173/settings", developmentUrl)).toBe(
      true,
    );
    expect(isTrustedDesktopRendererUrl("http://localhost:5173/settings", developmentUrl)).toBe(
      false,
    );
    expect(isTrustedDesktopRendererUrl("http://127.0.0.1:5174/settings", developmentUrl)).toBe(
      false,
    );
  });
});
