import { describe, expect, it } from "vitest";

import type { ServerLocalServerProcess } from "@t3tools/contracts";

import { localServerAddressLabel } from "./localServers";

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
