import { describe, expect, it, vi } from "vitest";

import {
  collectTailscaleDiagnostics,
  parseTailscaleServeJson,
  parseTailscaleStatusJson,
  type TailscaleCommandRunner,
} from "./tailscaleDiagnostics";

describe("Tailscale diagnostics", () => {
  it("reads the connection state and strips the DNS trailing dot", () => {
    expect(
      parseTailscaleStatusJson({
        BackendState: "Running",
        Self: { DNSName: "Desktop.tail123.ts.net." },
        CurrentTailnet: { Name: "example@example.com" },
      }),
    ).toEqual({
      backendState: "Running",
      connectionState: "connected",
      dnsName: "desktop.tail123.ts.net",
      tailnetName: "example@example.com",
    });
    expect(parseTailscaleStatusJson({ BackendState: "NeedsLogin" }).connectionState).toBe(
      "signed-out",
    );
  });

  it("distinguishes the expected proxy target and detects enabled Funnel", () => {
    expect(
      parseTailscaleServeJson(
        {
          TCP: { "443": { HTTPS: true } },
          Web: {
            "desktop.tail123.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
          AllowFunnel: { "desktop.tail123.ts.net:443": false },
        },
        "http://127.0.0.1:3773",
      ),
    ).toMatchObject({ state: "matching", funnelEnabled: false });

    expect(
      parseTailscaleServeJson(
        {
          Web: { host: { Handlers: { "/": { Proxy: "http://127.0.0.1:4000" } } } },
          AllowFunnel: { host: true },
        },
        "http://127.0.0.1:3773",
      ),
    ).toMatchObject({ state: "different-target", funnelEnabled: true });
  });

  it("requires the configured machine root route to target Synara", () => {
    expect(
      parseTailscaleServeJson(
        {
          Web: {
            "desktop.tail123.ts.net:443": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:4000" },
                "/unrelated": { Proxy: "http://127.0.0.1:3773" },
              },
            },
            "other.tail123.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        },
        "http://127.0.0.1:3773",
        "desktop.tail123.ts.net",
      ),
    ).toMatchObject({ state: "different-target" });
  });

  it("collects status and Serve diagnostics without issuing mutation commands", async () => {
    const runner = vi.fn<TailscaleCommandRunner>(async (_executable, args) => {
      if (args[0] === "status") {
        return {
          ok: true,
          unavailable: false,
          stderr: "",
          stdout: JSON.stringify({
            BackendState: "Running",
            Self: { DNSName: "desktop.tail123.ts.net." },
            CurrentTailnet: { Name: "test" },
          }),
        };
      }
      return {
        ok: true,
        unavailable: false,
        stderr: "",
        stdout: JSON.stringify({
          Web: {
            "desktop.tail123.ts.net:443": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:3773" } },
            },
          },
        }),
      };
    });

    const result = await collectTailscaleDiagnostics({
      port: 3773,
      platform: "linux",
      runner,
      now: () => new Date("2026-07-18T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      cliAvailable: true,
      connectionState: "connected",
      serveState: "matching",
      expectedServeCommand: "tailscale serve --bg http://127.0.0.1:3773",
      discoveredOrigin: "https://desktop.tail123.ts.net",
      mobileUrl: "https://desktop.tail123.ts.net/mobile/",
      issue: null,
    });
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([
      ["status", "--json"],
      ["serve", "status", "--json"],
    ]);
  });

  it("reports a missing CLI without trying Serve", async () => {
    const runner = vi.fn<TailscaleCommandRunner>(async () => ({
      ok: false,
      unavailable: true,
      stdout: "",
      stderr: "not found",
    }));
    const result = await collectTailscaleDiagnostics({
      port: 3773,
      platform: "linux",
      runner,
    });
    expect(result).toMatchObject({
      cliAvailable: false,
      connectionState: "unavailable",
      serveState: "unavailable",
    });
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
