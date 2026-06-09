// FILE: devServerManager.test.ts
// Purpose: Covers project dev-server registry helpers without starting PTYs.
// Layer: Server unit tests for DevServerManager support logic.

import { describe, expect, it } from "vitest";

import {
  ProjectId,
  type ProjectDevServer,
  type ServerLocalServerProcess,
} from "@t3tools/contracts";

import { findProjectDevServerForLocalServer } from "./devServerManager";

function makeDevServer(overrides: Partial<ProjectDevServer> = {}): ProjectDevServer {
  return {
    projectId: ProjectId.makeUnsafe("project-1"),
    command: "pnpm run dev",
    cwd: "/repo/app",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function makeLocalServer(
  overrides: Partial<ServerLocalServerProcess> = {},
): ServerLocalServerProcess {
  return {
    id: "200:5173",
    pid: 200,
    command: "node",
    displayName: "Vite",
    args: "node ./node_modules/.bin/vite",
    ports: [5173],
    addresses: [{ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173", family: "tcp4" }],
    isStoppable: true,
    ...overrides,
  };
}

describe("findProjectDevServerForLocalServer", () => {
  it("matches a local server owned by the tracked PTY pid", () => {
    const devServer = makeDevServer({ pid: 200 });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("uses the shared local-server ownership rule for cwd matches", () => {
    const devServer = makeDevServer({ cwd: "/repo/app", pid: null });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app/packages/web", pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app-other" }),
        devServers: [makeDevServer({ cwd: "/repo/app" })],
      }),
    ).toBeNull();
  });
});
