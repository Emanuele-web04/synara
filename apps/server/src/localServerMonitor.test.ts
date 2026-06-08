// FILE: localServerMonitor.test.ts
// Purpose: Covers localhost listener parsing, dev-server filtering, and page-title enrichment.
// Layer: Server unit tests for localServerMonitor.ts.
// Depends on: Vitest and exported local server monitor helpers.

import { describe, expect, it, vi } from "vitest";

import {
  buildLocalServerProcesses,
  enrichLocalServerProcessesWithPageTitles,
  extractLocalServerPageTitle,
  isIgnoredLocalServerProcess,
  isLikelyDevServerProcess,
  parseLsofTcpListenOutput,
  type LocalServerProcessInfo,
} from "./localServerMonitor";

type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

async function withMockedFetch<T>(
  fetchMock: typeof globalThis.fetch,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe("localServerMonitor", () => {
  it("parses lsof listener records into local endpoints", () => {
    const listeners = parseLsofTcpListenOutput(
      [
        "p123",
        "cnode",
        "f12",
        "PTCP",
        "n127.0.0.1:5173",
        "f13",
        "PTCP",
        "n[::1]:5173",
        "p456",
        "cPython",
        "f9",
        "PTCP",
        "n*:8000",
      ].join("\n"),
    );

    expect(listeners).toEqual([
      { pid: 123, command: "node", protocol: "tcp", host: "127.0.0.1", port: 5173, family: "tcp4" },
      { pid: 123, command: "node", protocol: "tcp", host: "::1", port: 5173, family: "tcp6" },
      { pid: 456, command: "Python", protocol: "tcp", host: "*", port: 8000, family: "tcp" },
    ]);
  });

  it("extracts a readable title from local server HTML", () => {
    expect(
      extractLocalServerPageTitle(`
        <!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Customer &amp; Admin">
            <title>Fallback</title>
          </head>
        </html>
      `),
    ).toBe("Customer & Admin");

    expect(extractLocalServerPageTitle("<title>\n  Vite + React&nbsp;Dashboard\n</title>")).toBe(
      "Vite + React Dashboard",
    );
  });

  it("keeps dev servers and ignores Electron/Synara-style application listeners", () => {
    expect(
      isLikelyDevServerProcess({
        command: "node",
        args: "node ./node_modules/.bin/vite --host 127.0.0.1",
        ports: [5173],
      }),
    ).toBe(true);
    expect(
      isIgnoredLocalServerProcess({
        command: "Electron",
        args: "/Applications/Synara.app/Contents/MacOS/Synara",
        ports: [61449],
      }),
    ).toBe(true);
    expect(
      isIgnoredLocalServerProcess({
        command: "Synara",
        args: "/Applications/Synara.app/Contents/MacOS/Synara",
        ports: [61449],
      }),
    ).toBe(true);
    expect(
      isLikelyDevServerProcess({
        command: "node",
        args: "node /Users/emanueledipietro/Developer/synara/apps/web/node_modules/.bin/vite",
        ports: [5733],
      }),
    ).toBe(true);
    expect(
      isLikelyDevServerProcess({
        command: "bun",
        args: "bun run electron:dev",
        ports: [5733],
      }),
    ).toBe(true);
  });

  it("ignores Chromium/Electron app helpers that hold a dev-range port (e.g. Discord on :6463)", () => {
    const discordRenderer = {
      command: "Discord Helper (Renderer)",
      args: "/Applications/Discord.app/Contents/Frameworks/Discord Helper (Renderer).app/Contents/MacOS/Discord Helper (Renderer) --type=renderer --enable-sandbox",
      ports: [6463],
    };
    expect(isIgnoredLocalServerProcess(discordRenderer)).toBe(true);
    expect(isLikelyDevServerProcess(discordRenderer)).toBe(false);

    // Filtered by the helper name alone, even without the full Chromium arg list.
    expect(
      isIgnoredLocalServerProcess({
        command: "Slack Helper (GPU)",
        args: "Slack Helper (GPU)",
        ports: [6463],
      }),
    ).toBe(true);

    // A real dev server on the same port range stays visible.
    expect(
      isLikelyDevServerProcess({
        command: "node",
        args: "node ./node_modules/.bin/vite --port 6006",
        ports: [6006],
      }),
    ).toBe(true);
  });

  it("does not promote databases or port-only listeners to local dev servers", () => {
    expect(
      isLikelyDevServerProcess({
        command: "mongod",
        args: "mongod --config /opt/homebrew/etc/mongod.conf",
        ports: [27017],
      }),
    ).toBe(false);
    expect(
      isLikelyDevServerProcess({
        command: "go",
        args: "go run ./cmd/web",
        ports: [8080],
      }),
    ).toBe(true);

    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node server.js" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5733"].join("\n")),
      processInfo,
    );

    expect(servers).toHaveLength(0);
  });

  it("treats custom electron dev scripts as dev context without showing Electron helpers", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [
        123,
        {
          ppid: 1,
          commandLine: "bun run electron:dev",
        },
      ],
      [
        456,
        {
          ppid: 123,
          commandLine: "Electron Helper (Renderer) --type=renderer",
        },
      ],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(
        [
          "p123",
          "cbun",
          "PTCP",
          "n127.0.0.1:5733",
          "p456",
          "cElectron Helper (Renderer)",
          "PTCP",
          "n127.0.0.1:6463",
        ].join("\n"),
      ),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      displayName: "Dev Server",
      ports: [5733],
    });
  });

  it("groups one process with multiple listener addresses into one row", () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);

    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(
        ["p123", "cnode", "PTCP", "n127.0.0.1:5173", "PTCP", "n*:5173"].join("\n"),
      ),
      processInfo,
    );

    expect(servers).toHaveLength(1);
    expect(servers[0]?.displayName).toBe("Vite");
    expect(servers[0]?.ports).toEqual([5173]);
    expect(servers[0]?.addresses.map((address) => address.url)).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]);
  });

  it("adds page titles to detected local server rows", async () => {
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", "n127.0.0.1:5173"].join("\n")),
      processInfo,
    );

    const enriched = await enrichLocalServerProcessesWithPageTitles(servers, async (url) =>
      url === "http://127.0.0.1:5173" ? "Acme Admin" : null,
    );

    expect(enriched[0]?.displayName).toBe("Vite");
    expect(enriched[0]?.pageTitle).toBe("Acme Admin");
  });

  it("keeps page-title redirects on local/private hosts", async () => {
    const port = 59173;
    const startUrl = `http://127.0.0.1:${port}`;
    const redirectedUrl = `http://127.0.0.1:${port}/app`;
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", `n127.0.0.1:${port}`].join("\n")),
      processInfo,
    );
    const fetchedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: FetchInput) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url === startUrl) {
        return new Response(null, { status: 302, headers: { location: "/app" } });
      }
      return new Response("<title>Local Redirect</title>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const enriched = await withMockedFetch(fetchMock, () =>
      enrichLocalServerProcessesWithPageTitles(servers),
    );

    expect(fetchedUrls).toEqual([startUrl, redirectedUrl]);
    expect(enriched[0]?.pageTitle).toBe("Local Redirect");
  });

  it("does not follow page-title redirects to external hosts", async () => {
    const port = 59174;
    const startUrl = `http://127.0.0.1:${port}`;
    const processInfo = new Map<number, LocalServerProcessInfo>([
      [123, { ppid: 1, commandLine: "node ./node_modules/.bin/vite" }],
    ]);
    const servers = buildLocalServerProcesses(
      parseLsofTcpListenOutput(["p123", "cnode", "PTCP", `n127.0.0.1:${port}`].join("\n")),
      processInfo,
    );
    const fetchedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url === startUrl) {
        if (init?.redirect === "follow") {
          fetchedUrls.push("https://example.com/");
          return new Response("<title>External Redirect</title>", {
            headers: { "content-type": "text/html" },
          });
        }
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/" },
        });
      }
      return new Response("<title>External Redirect</title>", {
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof globalThis.fetch;

    const enriched = await withMockedFetch(fetchMock, () =>
      enrichLocalServerProcessesWithPageTitles(servers),
    );

    expect(fetchedUrls).toEqual([startUrl]);
    expect(enriched[0]?.pageTitle).toBeUndefined();
  });
});
