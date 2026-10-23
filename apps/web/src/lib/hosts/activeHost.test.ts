// Legacy selections are migration input only. Each remote runtime captures
// its own host; the main window always retains local execution. Web unit tests run
// without a DOM, so `window` is stubbed with an in-memory sessionStorage the
// same way the storage-migration tests stub localStorage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readActiveHost, readLegacyActiveHost } from "./activeHost";

const KEY = "synara:active-host:v1";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
}

let sessionStorage: Storage;

beforeEach(() => {
  sessionStorage = createMemoryStorage();
  vi.stubGlobal("window", { sessionStorage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("activeHost", () => {
  it("is null when nothing is chosen", () => {
    expect(readActiveHost()).toBeNull();
  });

  it("leaves a legacy remote selection for migration without changing local execution", () => {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ hostId: "host_1", hostName: "Ada", wsPath: "/ws/remote/host_1/" }),
    );
    expect(readLegacyActiveHost()).toEqual({
      hostId: "host_1",
      hostName: "Ada",
      wsPath: "/ws/remote/host_1/",
    });
    expect(readActiveHost()).toBeNull();
  });

  it("drops a corrupt or non-path value rather than pointing the transport at it", () => {
    sessionStorage.setItem(KEY, "not json");
    expect(readLegacyActiveHost()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();

    sessionStorage.setItem(
      KEY,
      JSON.stringify({ hostId: "host_1", hostName: "Ada", wsPath: "https://evil.test/ws" }),
    );
    expect(readLegacyActiveHost()).toBeNull();
  });

  it("is null when there is no window at all", () => {
    vi.unstubAllGlobals();
    expect(readActiveHost()).toBeNull();
  });
});
