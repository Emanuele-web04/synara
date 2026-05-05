import { describe, expect, it } from "vitest";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  deriveAuthClientMetadata,
  resolveSessionCookieName,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils";

describe("auth utils", () => {
  it("resolves stable web and port-scoped desktop cookie names", () => {
    expect(resolveSessionCookieName({ mode: "web", port: 3773 })).toBe("t3_session");
    expect(resolveSessionCookieName({ mode: "desktop", port: 3773 })).toBe("t3_session_3773");
  });

  it("round-trips base64url text", () => {
    const encoded = base64UrlEncode("hello auth");
    expect(encoded).not.toContain("+");
    expect(base64UrlDecodeUtf8(encoded)).toBe("hello auth");
  });

  it("compares signed payloads safely", () => {
    const secret = new Uint8Array([1, 2, 3, 4]);
    const signature = signPayload("payload", secret);

    expect(timingSafeEqualBase64Url(signature, signature)).toBe(true);
    expect(timingSafeEqualBase64Url(signature, signPayload("other", secret))).toBe(false);
  });

  it("derives basic client metadata", () => {
    expect(
      deriveAuthClientMetadata({
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Chrome/123",
        },
        remoteAddress: "::ffff:127.0.0.1",
        label: "Local browser",
      }),
    ).toEqual({
      label: "Local browser",
      ipAddress: "127.0.0.1",
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Chrome/123",
      deviceType: "desktop",
      os: "macOS",
      browser: "Chrome",
    });
  });
});
