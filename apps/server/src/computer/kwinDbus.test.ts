import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  captureTimeoutMs,
  COMPUTER_OBJECT_PATH,
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  invokeKWinDbusMethod,
  KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS,
  KWIN_DBUS_CAPTURE_TIMEOUT_MS,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  KWinDbusTimeoutError,
  parseKwinSupportVersion,
  readStringArray,
  COMPUTER_AUTH_THROTTLED_ERROR,
} from "./kwinDbus.ts";

describe("KWin D-Bus calls", () => {
  it("times out ordinary and capture calls at their separate limits", async () => {
    vi.useFakeTimers();
    try {
      let ordinarySettled = false;
      const ordinary = invokeKWinDbusMethod(
        { stateJson: () => new Promise(() => undefined) },
        "stateJson",
      );
      ordinary.then(
        () => {
          ordinarySettled = true;
        },
        () => {
          ordinarySettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_DEFAULT_TIMEOUT_MS - 1);
      expect(ordinarySettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(ordinary).rejects.toBeInstanceOf(KWinDbusTimeoutError);

      let captureSettled = false;
      const capture = invokeKWinDbusMethod(
        { captureWindow: () => new Promise(() => undefined) },
        "captureWindow",
      );
      capture.then(
        () => {
          captureSettled = true;
        },
        () => {
          captureSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(KWIN_DBUS_CAPTURE_TIMEOUT_MS - 1);
      expect(captureSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(capture).rejects.toBeInstanceOf(KWinDbusTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when a call settles", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        invokeKWinDbusMethod({ stateJson: () => Promise.resolve("ok") }, "stateJson"),
      ).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a failure KWin reported through untouched", async () => {
    // Only a timeout is connection-level. A call KWin answered with an error
    // says nothing about the connection, so wrapping it in the type that drives
    // a reconnect would tear down a session over a bad argument.
    const reported = new Error("org.freedesktop.DBus.Error.InvalidArgs");
    await expect(
      invokeKWinDbusMethod({ focusWindow: () => Promise.reject(reported) }, "focusWindow"),
    ).rejects.toBe(reported);
  });

  it("keeps a one-element loaded plugin array as an array", () => {
    expect(readStringArray(["onlyPlugin"])).toEqual(["onlyPlugin"]);
    expect(readStringArray({ signature: "as", value: ["onlyPlugin"] })).toEqual(["onlyPlugin"]);
  });
});

describe("connectPlugin owner pinning", () => {
  // A proxy addressed by the well-known name follows the name to whoever owns
  // it next, so a squatter or stale generation taking the name after the
  // backend's ownership check would receive every input and capture call.
  // These pin the proxy's destination to the unique name resolved at connect.
  function fakeBus(options: { readonly owner?: string }) {
    const proxied: string[] = [];
    const bus = {
      proxied,
      getProxyObject: (service: string) => {
        proxied.push(service);
        return Promise.resolve({
          getInterface: () => ({
            GetNameOwner: (name: string) => {
              if (options.owner === undefined) {
                return Promise.reject(
                  Object.assign(new Error("Could not get owner of name: no such name"), {
                    type: "org.freedesktop.DBus.Error.NameHasNoOwner",
                  }),
                );
              }
              return Promise.resolve(name === COMPUTER_SERVICE ? options.owner : ":0.0");
            },
            RequestName: async () => 1,
            GetId: async () => `test-${process.pid}`,
            authenticate: async () => "test-instance",
          }),
        });
      },
      disconnect: () => undefined,
      on: () => bus,
      off: () => bus,
    };
    return bus;
  }

  it("waits out a throttled authentication instead of treating it as a refusal", async () => {
    const bus = fakeBus({ owner: ":1.42" });
    let attempts = 0;
    const getProxyObject = bus.getProxyObject;
    bus.getProxyObject = async (service: string) => {
      const object = await getProxyObject(service);
      const iface = object.getInterface();
      return {
        getInterface: () => ({
          ...iface,
          authenticate: async () => {
            attempts += 1;
            if (attempts === 1) {
              throw Object.assign(new Error("authentication throttled"), {
                type: COMPUTER_AUTH_THROTTLED_ERROR,
              });
            }
            return "test-instance";
          },
        }),
      };
    };
    const waits: number[] = [];
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    const plugin = await dbus.connectPlugin();

    expect(plugin.instanceId).toBe("test-instance");
    expect(attempts).toBe(2);
    expect(waits).toEqual([1_100]);
  });

  it("addresses the plugin proxy by the resolved unique name, not the well-known one", async () => {
    const bus = fakeBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    await dbus.connectPlugin();

    expect(bus.proxied.at(-1)).toBe(":1.42");
    expect(bus.proxied).not.toContain(COMPUTER_SERVICE);
    expect(bus.proxied.filter((service) => service === COMPUTER_OBJECT_PATH)).toEqual([]);
    await dbus.close();
  });

  it("refuses to connect when nothing owns the service name", async () => {
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => fakeBus({}) as never },
    });

    await expect(dbus.connectPlugin()).rejects.toThrow(/Nothing on the session bus owns/);
    await dbus.close();
  });
});

describe("session bus lifetime", () => {
  /** A bus that is a real emitter, so an unhandled `error` really throws. */
  function emitterBus(options: { readonly owner?: string } = {}) {
    const bus = new EventEmitter() as EventEmitter & {
      readonly daemon: EventEmitter;
      readonly pinged: string[];
      getProxyObject: (service: string) => Promise<unknown>;
      call: (message: unknown) => Promise<unknown>;
      disconnect: () => void;
      disconnected: boolean;
    };
    const daemon = new EventEmitter();
    Object.assign(daemon, {
      GetNameOwner: async (name: string) =>
        name === COMPUTER_SERVICE && options.owner ? options.owner : ":0.0",
      RequestName: async () => 1,
      GetId: async () => `test-${process.pid}`,
      authenticate: async () => "test-instance",
    });
    Object.assign(bus, {
      daemon,
      pinged: [] as string[],
      disconnected: false,
      getProxyObject: async () => ({ getInterface: () => daemon }),
      call: async (message: { destination: string }) => {
        bus.pinged.push(message.destination);
        return undefined;
      },
      disconnect: () => {
        bus.disconnected = true;
      },
    });
    return bus;
  }

  class FakeMessage {
    constructor(readonly fields: Record<string, unknown>) {
      Object.assign(this, fields);
    }
  }

  it("survives a bus error that arrives after close", async () => {
    const bus = emitterBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    await dbus.close();
    expect(bus.disconnected).toBe(true);
    // A release write from a `finally` can land on the socket after close;
    // dbus-next reports the ECONNRESET on the bus object, and with no listener
    // left it would have been an uncaught exception ending the server.
    expect(() => bus.emit("error", new Error("read ECONNRESET"))).not.toThrow();
    expect(() => bus.emit("disconnect")).not.toThrow();
  });

  it("stops fanning out disconnects after close but keeps listening", async () => {
    const bus = emitterBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    const disconnected = vi.fn();
    dbus.onDisconnect(disconnected);
    bus.emit("error", new Error("first"));
    expect(disconnected).toHaveBeenCalledTimes(1);
    await dbus.close();
    bus.emit("error", new Error("late"));
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("announces a new owner of the plugin service and nothing else", async () => {
    const bus = emitterBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    const owners: Array<string | undefined> = [];
    const unsubscribe = dbus.onServiceOwnerChanged!((owner) => owners.push(owner));
    bus.daemon.emit("NameOwnerChanged", "org.kde.KWin", ":1.1", ":1.2");
    bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, ":1.42", ":1.43");
    bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, ":1.43", "");
    expect(owners).toEqual([":1.43", undefined]);
    unsubscribe();
    bus.daemon.emit("NameOwnerChanged", COMPUTER_SERVICE, "", ":1.44");
    expect(owners).toHaveLength(2);
    await dbus.close();
  });

  it("pings the plugin owner's unique name through the Peer interface", async () => {
    const bus = emitterBus({ owner: ":1.42" });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never, Message: FakeMessage as never },
    });
    await expect(dbus.pingOwner!(":1.42")).resolves.toBe(true);
    expect(bus.pinged).toEqual([":1.42"]);
    bus.call = async () => {
      throw new Error("no reply");
    };
    await expect(dbus.pingOwner!(":1.42")).resolves.toBe(false);
    await dbus.close();
  });

  it("reads the running KWin version out of the compositor's support information", async () => {
    const bus = emitterBus({ owner: ":1.42" });
    Object.assign(bus.daemon, {
      supportInformation: async () =>
        "KWin Support Information:\n\nVersion\n=======\nKWin version: 6.7.3\nQt Version: 6.9.1\n",
    });
    const dbus = await createSessionKWinComputerDbus({
      dbusModule: { sessionBus: () => bus as never },
    });
    await expect(dbus.kwinVersion!()).resolves.toBe("6.7.3");
    await dbus.close();
  });
});

describe("capture deadlines", () => {
  it("scales with the source area, between the floor and the ceiling", () => {
    expect(captureTimeoutMs(undefined)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS);
    expect(captureTimeoutMs(0)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS);
    expect(captureTimeoutMs(1_000_000)).toBe(KWIN_DBUS_CAPTURE_TIMEOUT_MS + 2_000);
    expect(captureTimeoutMs(5_120 * 2_880)).toBeGreaterThan(captureTimeoutMs(1_920 * 1_080));
    expect(captureTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(KWIN_DBUS_CAPTURE_MAX_TIMEOUT_MS);
  });

  it("reads the KWin version line and ignores the rest", () => {
    expect(parseKwinSupportVersion("Qt Version: 6.9.1\nKWin version: 6.8.0\n")).toBe("6.8.0");
    expect(parseKwinSupportVersion("nothing here")).toBeUndefined();
  });
});
