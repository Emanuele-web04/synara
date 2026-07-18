import { describe, expect, it } from "vitest";
import {
  isCacheableShellRequest,
  isMobileNavigation,
  notificationPreview,
} from "./cachePolicy";

describe("mobile service-worker cache policy", () => {
  const origin = "https://synara.example.ts.net";

  it("only recognizes mobile navigations", () => {
    expect(isMobileNavigation(new URL(`${origin}/mobile/threads/one`), "navigate")).toBe(true);
    expect(isMobileNavigation(new URL(`${origin}/api/auth/session`), "navigate")).toBe(false);
    expect(isMobileNavigation(new URL(`${origin}/mobile/`), "cors")).toBe(false);
  });

  it("allows app-shell assets but never API or foreign requests", () => {
    expect(isCacheableShellRequest(new URL(`${origin}/mobile/assets/main-abc.js`), origin)).toBe(
      true,
    );
    expect(isCacheableShellRequest(new URL(`${origin}/mobile/manifest.webmanifest`), origin)).toBe(
      true,
    );
    expect(isCacheableShellRequest(new URL(`${origin}/api/companion/v1/info`), origin)).toBe(
      false,
    );
    expect(
      isCacheableShellRequest(new URL("https://example.com/mobile/assets/main.js"), origin),
    ).toBe(false);
  });

  it("sanitizes and caps notification previews", () => {
    expect(notificationPreview("Hello\n\nworld\u0000")).toBe("Hello world");
    expect(notificationPreview("x".repeat(200))).toHaveLength(160);
    expect(notificationPreview(null)).toBeUndefined();
  });
});
