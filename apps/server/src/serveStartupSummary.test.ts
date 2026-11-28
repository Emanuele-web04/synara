import { describe, expect, it } from "vitest";

import { formatServeStartupSummary } from "./serveStartupSummary";

describe("formatServeStartupSummary", () => {
  it("formats a local loopback server summary", () => {
    const summary = formatServeStartupSummary({
      host: "127.0.0.1",
      port: 3773,
      baseDir: "/home/alice/.synara",
      staticDir: "/opt/synara/client",
      devUrl: undefined,
      publicUrl: undefined,
      allowInsecureRemote: false,
      startupPairingUrl: undefined,
    });

    expect(summary).toBe(
      [
        "Synara web server listening",
        "  URL: http://127.0.0.1:3773",
        "  Data: /home/alice/.synara",
      ].join("\n"),
    );
  });

  it("brackets IPv6 hosts and reports missing web bundle guidance", () => {
    const summary = formatServeStartupSummary({
      host: "::1",
      port: 4100,
      baseDir: "/tmp/synara",
      staticDir: undefined,
      devUrl: undefined,
      publicUrl: undefined,
      allowInsecureRemote: false,
      startupPairingUrl: undefined,
    });

    expect(summary).toContain("  URL: http://[::1]:4100");
    expect(summary).toContain("Web UI: unavailable");
  });

  it("shows listen/local URLs, pairing link, hint, and warning for wildcard LAN serving", () => {
    const summary = formatServeStartupSummary({
      host: "0.0.0.0",
      port: 3773,
      baseDir: "/home/alice/.synara",
      staticDir: "/opt/synara/client",
      devUrl: undefined,
      publicUrl: undefined,
      allowInsecureRemote: true,
      startupPairingUrl: "http://localhost:3773/pair#token=one-time-code",
    });

    expect(summary).toBe(
      [
        "Synara web server listening",
        "  Listen: http://0.0.0.0:3773",
        "  Local: http://localhost:3773",
        "  Pairing URL: http://localhost:3773/pair#token=one-time-code",
        "  Hint: Replace localhost in the pairing URL with this machine's reachable IP or hostname.",
        "  Warning: Unencrypted remote access enabled (--allow-insecure-remote). Use only on a trusted LAN.",
        "  Data: /home/alice/.synara",
      ].join("\n"),
    );
  });

  it("shows the HTTPS public URL without wildcard/insecure warnings when proxied", () => {
    const summary = formatServeStartupSummary({
      host: "0.0.0.0",
      port: 3773,
      baseDir: "/home/alice/.synara",
      staticDir: "/opt/synara/client",
      devUrl: undefined,
      publicUrl: new URL("https://synara.example.test/"),
      allowInsecureRemote: true,
      startupPairingUrl: "https://synara.example.test/pair#token=one-time-code",
    });

    expect(summary).toContain("  Public URL: https://synara.example.test");
    expect(summary).toContain(
      "  Pairing URL: https://synara.example.test/pair#token=one-time-code",
    );
    expect(summary).not.toContain("Replace localhost");
    expect(summary).not.toContain("Unencrypted remote access");
  });

  it("includes dev URL and skips missing-bundle notice in dev mode", () => {
    const summary = formatServeStartupSummary({
      host: "127.0.0.1",
      port: 3773,
      baseDir: "/home/alice/.synara",
      staticDir: undefined,
      devUrl: new URL("http://127.0.0.1:5173"),
      publicUrl: undefined,
      allowInsecureRemote: false,
      startupPairingUrl: undefined,
    });

    expect(summary).toContain("  Dev URL: http://127.0.0.1:5173/");
    expect(summary).not.toContain("Web UI: unavailable");
  });
});
