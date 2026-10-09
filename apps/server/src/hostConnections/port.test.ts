import { EnvironmentId, type AccountHost, type RemoteExecutionScope } from "@synara/contracts";
import { expect, it } from "vitest";
import { HostConnectionRegistry } from "./registry";
import { makeHostConnectionsPort } from "./port";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const host: AccountHost = {
  id: "host",
  environmentId: EnvironmentId.makeUnsafe("mini"),
  name: "Mini",
  platform: "darwin",
  kind: "local",
  endpoints: [],
  ownerUserId: "owner",
  discoverable: false,
  linked: true,
  keyGeneration: 1,
  mine: true,
  createdAt: "2026-09-27T00:00:00Z",
  lastSeenAt: "2026-09-27T00:00:00Z",
};
const scope: RemoteExecutionScope = {
  accountAuthority: "https://account.test",
  userId: "owner",
  organizationId: "personal",
  environmentId: "mini",
  channel: "beta",
};

it.each(["disconnect", "account", "stop"])(
  "does not resurrect a connection after %s while discovery is pending",
  async (action) => {
    const discovery = deferred<{ hosts: AccountHost[] }>();
    const registry = new HostConnectionRegistry();
    const writes: boolean[] = [];
    let trustReads = 0;
    const port = makeHostConnectionsPort({
      registry,
      accountSession: {
        listHosts: () => discovery.promise,
        requestGrant: async () => {
          throw new Error("Must not request a grant");
        },
        dialIdentity: async () => {
          throw new Error("Must not read a key");
        },
      },
      setDesired: async (_id, desired) => {
        writes.push(desired);
      },
      listPaired: async () => [],
      listDesired: async () => [],
      readTrust: async () => {
        trustReads++;
        return undefined;
      },
    });
    const pending = port.connect({ hostId: "host" });
    const rejected = expect(pending).rejects.toThrow("cancelled");
    if (action === "disconnect") await port.disconnect({ hostId: "host" });
    if (action === "account") registry.invalidateAccount({ ...scope, userId: "another-account" });
    if (action === "stop") registry.closeAll();
    discovery.resolve({ hosts: [host] });
    await rejected;
    expect(trustReads).toBe(0);
    expect(writes).toEqual(action === "disconnect" ? [false] : []);
    expect(registry.hasConnector("host")).toBe(false);
  },
);

it("orders durable disconnect after an already-started desired-state write and shares concurrent discovery", async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const registry = new HostConnectionRegistry();
  const writes: boolean[] = [];
  let discoveries = 0;
  const port = makeHostConnectionsPort({
    registry,
    accountSession: {
      listHosts: async () => {
        discoveries++;
        return { hosts: [host] };
      },
      requestGrant: async () => {
        throw new Error("No dial after disconnect");
      },
      dialIdentity: async () => {
        throw new Error("No dial after disconnect");
      },
    },
    readTrust: async () => ({
      environmentId: "mini",
      rootCertificate: "fixture",
      rootFingerprint: "fixture",
      executionScope: scope,
    }),
    listPaired: async () => [],
    listDesired: async () => [],
    setDesired: async (_id, desired) => {
      if (desired) {
        started.resolve();
        await release.promise;
      }
      writes.push(desired);
    },
  });
  const first = port.connect({ hostId: "host" });
  const second = port.connect({ hostId: "host" });
  expect(second).toBe(first);
  const rejected = expect(first).rejects.toThrow("cancelled");
  await started.promise;
  const stopped = port.disconnect({ hostId: "host" });
  release.resolve();
  await stopped;
  await rejected;
  expect(writes).toEqual([true, false]);
  expect(discoveries).toBe(1);
  expect(registry.hasConnector("host")).toBe(false);
});
