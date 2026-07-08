// FILE: trustedOrigins.test.ts
// Purpose: Pins which browser origins can use local-data HTTP/WS surfaces.
// Layer: Server utility tests

import { describe, expect, it } from "vitest";

import type { ServerConfigShape } from "./config";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectUntrustedRequestOrigin,
} from "./trustedOrigins";

const config = {
  devUrl: new URL("http://localhost:5173/"),
} as ServerConfigShape;

describe("trustedOrigins", () => {
  it("trusts same-origin, configured dev, and desktop app origins", () => {
    expect(
      isTrustedAppOrigin({
        origin: "http://127.0.0.1:58090",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "http://localhost:5173",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "synara://app",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });

  it("rejects unrelated browser origins but allows non-browser requests without Origin", () => {
    expect(
      isTrustedAppOrigin({
        origin: "https://example.test",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      isTrustedAppOrigin({
        origin: null,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
  });

  it("trusts same-origin hosts only when local, configured, or wildcard-bound", () => {
    expect(
      isTrustedAppOrigin({
        origin: "http://evil.test:3773",
        requestOrigin: "http://evil.test:3773",
        config,
      }),
    ).toBe(false);
    expect(
      isTrustedAppOrigin({
        origin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "192.168.1.50" },
      }),
    ).toBe(true);
    expect(
      isTrustedAppOrigin({
        origin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "0.0.0.0" },
      }),
    ).toBe(true);
  });

  it("normalizes desktop origins with trailing slashes", () => {
    expect(normalizeCorsOrigin("synara://app/")).toBe("synara://app");
  });

  it("rejects present but untrusted request origins for websocket-style gates", () => {
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: undefined,
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "null",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "https://example.test",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(true);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "http://localhost:5173",
        requestOrigin: "http://127.0.0.1:58090",
        config,
      }),
    ).toBe(false);
    expect(
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: "http://192.168.1.50:3773",
        requestOrigin: "http://192.168.1.50:3773",
        config: { ...config, host: "0.0.0.0" },
      }),
    ).toBe(false);
  });
});
