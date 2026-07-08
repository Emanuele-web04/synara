import { describe, expect, it } from "vitest";

import type { ServerLocalServerProcess } from "@synara/contracts";

import {
  localServerAddressLabel,
  localServerFolderLabel,
  localServerMatchesRun,
  localServerPrimaryLabel,
} from "./localServers";

function makeServer(overrides: Partial<ServerLocalServerProcess>): ServerLocalServerProcess {
  return {
    id: "srv-1",
    pid: 2518,
    command: "node",
    displayName: "Vite",
    args: "",
    ports: [],
    addresses: [],
    isStoppable: true,
    ...overrides,
  };
}

describe("localServerAddressLabel", () => {
  it("renders a single port as localhost:<port>", () => {
    expect(localServerAddressLabel(makeServer({ ports: [5733] }))).toBe("localhost:5733");
  });

  it("joins multiple ports", () => {
    expect(localServerAddressLabel(makeServer({ ports: [5733, 8891] }))).toBe(
      "localhost:5733, localhost:8891",
    );
  });

  it("never echoes the raw bind host (ipv6 loopback) — falls back to localhost", () => {
    const server = makeServer({
      ports: [],
      addresses: [{ host: "::1", port: 5733, family: "tcp6", url: "http://[::1]:5733" }],
    });
    expect(localServerAddressLabel(server)).toBe("localhost:5733");
  });

  it("falls back to a bare localhost when no port is known", () => {
    expect(localServerAddressLabel(makeServer({}))).toBe("localhost");
  });
});

describe("localServerPrimaryLabel", () => {
  it("prefers the live page title when one was resolved", () => {
    expect(localServerPrimaryLabel(makeServer({ pageTitle: "Synara", displayName: "Vite" }))).toBe(
      "Synara",
    );
  });

  it("falls back to the detected display name when no page title is known", () => {
    expect(localServerPrimaryLabel(makeServer({ displayName: "Next.js" }))).toBe("Next.js");
  });
});

describe("localServerFolderLabel", () => {
  it("returns the final segment of a POSIX cwd", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/Users/me/Developer/synara-website" }))).toBe(
      "synara-website",
    );
  });

  it("ignores a trailing separator", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/Users/me/Developer/synara/" }))).toBe(
      "synara",
    );
  });

  it("tolerates Windows separators", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "C:\\Users\\me\\projects\\app" }))).toBe("app");
  });

  it("returns null when the cwd is unknown", () => {
    expect(localServerFolderLabel(makeServer({}))).toBeNull();
  });

  it("returns null when the cwd is only separators", () => {
    expect(localServerFolderLabel(makeServer({ cwd: "/" }))).toBeNull();
  });
});

describe("localServerMatchesRun", () => {
  it("matches a server whose pid is the tracked run pid", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200 }), {
        pid: 200,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("matches a server whose parent pid is the tracked run pid", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200, ppid: 100 }), {
        pid: 100,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("falls back to cwd containment for nested listening children", () => {
    expect(
      localServerMatchesRun(makeServer({ pid: 200, cwd: "/repo/app/packages/web" }), {
        pid: 100,
        cwd: "/repo/app",
      }),
    ).toBe(true);
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      localServerMatchesRun(makeServer({ cwd: "/repo/app-other" }), {
        pid: null,
        cwd: "/repo/app",
      }),
    ).toBe(false);
  });
});
