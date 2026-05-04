import { describe, expect, it } from "vitest";

import {
  formatHostForUrl,
  isLoopbackHost,
  isWildcardHost,
  resolveListeningPort,
} from "./startupAccess";

describe("startupAccess", () => {
  it("detects wildcard hosts", () => {
    expect(isWildcardHost("0.0.0.0")).toBe(true);
    expect(isWildcardHost("::")).toBe(true);
    expect(isWildcardHost("127.0.0.1")).toBe(false);
  });

  it("detects loopback hosts", () => {
    expect(isLoopbackHost(undefined)).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.50")).toBe(false);
  });

  it("formats IPv6 hosts for URLs", () => {
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  it("prefers the actual bound port when an HTTP server address is available", () => {
    expect(resolveListeningPort({ port: 4123 }, 3773)).toBe(4123);
    expect(resolveListeningPort("pipe", 3773)).toBe(3773);
    expect(resolveListeningPort(null, 3773)).toBe(3773);
  });
});
