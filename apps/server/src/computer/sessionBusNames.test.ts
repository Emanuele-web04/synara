import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import type { KWinComputerDbusOptions } from "./kwinDbus.ts";
import { DBUS_INTERFACE, DBUS_OBJECT_PATH, DBUS_SERVICE } from "./kwinDbus.ts";
import { sessionBusNameHasOwner, sessionBusNamesHaveOwners } from "./sessionBusNames.ts";

type NameHasOwner = (name: string) => Promise<unknown>;

/**
 * The surface of a dbus-next session bus these probes touch: an EventEmitter
 * with `getProxyObject`, whose proxy exposes the bus daemon's interface, and
 * `disconnect`.
 */
function fakeSessionBus(nameHasOwner: NameHasOwner, onDisconnect?: (bus: EventEmitter) => void) {
  const bus = new EventEmitter();
  const getInterface = vi.fn((name: string) => {
    if (name !== DBUS_INTERFACE) throw new Error(`unexpected interface ${name}`);
    return { NameHasOwner: nameHasOwnerSpy };
  });
  const nameHasOwnerSpy = vi.fn(nameHasOwner);
  const getProxyObject = vi.fn((service: string, path: string) => {
    if (service !== DBUS_SERVICE || path !== DBUS_OBJECT_PATH) {
      throw new Error(`unexpected proxy ${service} ${path}`);
    }
    return Promise.resolve({ getInterface });
  });
  const disconnect = vi.fn(() => onDisconnect?.(bus));
  const connection = Object.assign(bus, { getProxyObject, disconnect });
  const sessionBus = vi.fn(() => connection);
  const dbusModule = { sessionBus } as unknown as NonNullable<
    KWinComputerDbusOptions["dbusModule"]
  >;
  return { bus, sessionBus, nameHasOwner: nameHasOwnerSpy, disconnect, dbusModule };
}

describe("sessionBusNamesHaveOwners", () => {
  it("asks NameHasOwner once per name on one connection and disconnects it", async () => {
    const owned = new Set(["org.kde.KWin"]);
    const fake = fakeSessionBus((name) => Promise.resolve(owned.has(name)));

    await expect(
      sessionBusNamesHaveOwners(["org.kde.KWin", "org.synara.ComputerUse"], {
        dbusModule: fake.dbusModule,
      }),
    ).resolves.toEqual([true, false]);

    expect(fake.sessionBus).toHaveBeenCalledTimes(1);
    expect(fake.nameHasOwner.mock.calls).toEqual([["org.kde.KWin"], ["org.synara.ComputerUse"]]);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
    // Nothing is left listening on a connection that no longer exists.
    expect(fake.bus.listenerCount("error")).toBe(0);
    expect(fake.bus.listenerCount("disconnect")).toBe(0);
  });

  it("opens no connection for an empty question", async () => {
    const fake = fakeSessionBus(() => Promise.resolve(true));
    await expect(sessionBusNamesHaveOwners([], { dbusModule: fake.dbusModule })).resolves.toEqual(
      [],
    );
    expect(fake.sessionBus).not.toHaveBeenCalled();
  });

  it("reads only a strict true as owned", async () => {
    const answers = new Map<string, unknown>([
      ["a", true],
      ["b", 1],
      ["c", "true"],
    ]);
    const fake = fakeSessionBus((name) => Promise.resolve(answers.get(name)));
    await expect(
      sessionBusNamesHaveOwners(["a", "b", "c"], { dbusModule: fake.dbusModule }),
    ).resolves.toEqual([true, false, false]);
  });

  it("rejects with the connection failure when the bus errors mid-operation", async () => {
    const connectionError = new Error("socket hung up");
    const fake = fakeSessionBus(() => {
      // dbus-next reports a dropped connection on the bus object and then
      // fails the pending call; the probe must surface the former.
      fake.bus.emit("error", connectionError);
      return Promise.reject(new Error("call aborted"));
    });

    await expect(
      sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
    ).rejects.toBe(connectionError);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rejects when the bus disconnects underneath the operation", async () => {
    const fake = fakeSessionBus(() => {
      fake.bus.emit("disconnect");
      return Promise.reject(new Error("call aborted"));
    });

    await expect(
      sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
    ).rejects.toBeInstanceOf(Error);
  });

  it("keeps the error listener attached while disconnecting", async () => {
    // A close that lands on a reset socket is reported as an `error` event
    // from inside disconnect(); with no listener that would throw out of the
    // finally block and, on a real process, be fatal.
    const fake = fakeSessionBus(
      () => Promise.resolve(true),
      (bus) => {
        bus.emit("error", new Error("ECONNRESET"));
      },
    );

    await expect(
      sessionBusNamesHaveOwners(["org.kde.KWin"], { dbusModule: fake.dbusModule }),
    ).resolves.toEqual([true]);
    expect(fake.bus.listenerCount("error")).toBe(0);
  });
});

describe("sessionBusNameHasOwner", () => {
  it("delegates a single name to the batch probe", async () => {
    const fake = fakeSessionBus((name) => Promise.resolve(name === "org.kde.KWin"));

    await expect(
      sessionBusNameHasOwner("org.kde.KWin", { dbusModule: fake.dbusModule }),
    ).resolves.toBe(true);
    await expect(
      sessionBusNameHasOwner("org.synara.ComputerUse", { dbusModule: fake.dbusModule }),
    ).resolves.toBe(false);

    expect(fake.sessionBus).toHaveBeenCalledTimes(2);
    expect(fake.nameHasOwner.mock.calls).toEqual([["org.kde.KWin"], ["org.synara.ComputerUse"]]);
    expect(fake.disconnect).toHaveBeenCalledTimes(2);
  });
});
