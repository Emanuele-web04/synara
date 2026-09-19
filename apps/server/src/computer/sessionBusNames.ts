/**
 * "Is anyone answering to this bus name?" — the cheapest question you can ask a
 * Linux desktop about what it is.
 *
 * Backend selection uses it to decide whether the compositor is KWin, and the
 * plugin backends' probes use it to see whether their service is up. It lives
 * here rather than in any one caller because all of them need the same three
 * properties: a fresh short-lived connection (a probe must not hold
 * a bus connection open for the life of the process), a bounded wait (an
 * unreachable bus must fail rather than hang startup), and a rejection rather
 * than a `false` when the bus itself is the problem — "nobody owns that name"
 * and "there is no bus" lead to different messages and different tiers.
 */
import { createRequire } from "node:module";
import type { EventEmitter } from "node:events";

import type dbusModule from "dbus-next";

import {
  DBUS_INTERFACE,
  DBUS_OBJECT_PATH,
  DBUS_SERVICE,
  KWIN_DBUS_DEFAULT_TIMEOUT_MS,
  invokeKWinDbusMethod,
  type KWinComputerDbusOptions,
} from "./kwinDbus.ts";

/** Whether a name is owned on the session bus. Rejects if the bus is unreachable. */
export async function sessionBusNameHasOwner(
  name: string,
  options: KWinComputerDbusOptions = {},
): Promise<boolean> {
  const [owned] = await sessionBusNamesHaveOwners([name], options);
  return owned === true;
}

/**
 * `NameHasOwner` for several names on ONE throwaway connection, answered in
 * the order asked. A probe that asks two questions must not pay two bus
 * handshakes for them: the availability probe runs on every thread publish.
 */
export async function sessionBusNamesHaveOwners(
  names: readonly string[],
  options: KWinComputerDbusOptions = {},
): Promise<readonly boolean[]> {
  if (names.length === 0) return [];
  return await withSessionBus(options, async (bus) => {
    const daemon = await withBusTimeout(
      Promise.resolve(bus.getProxyObject(DBUS_SERVICE, DBUS_OBJECT_PATH)),
      "getProxyObject",
    );
    const iface = daemon.getInterface(DBUS_INTERFACE);
    const answers: boolean[] = [];
    for (const name of names) {
      answers.push((await invokeKWinDbusMethod(iface, "NameHasOwner", name)) === true);
    }
    return answers;
  });
}

/** One `org.freedesktop.DBus.Properties.Get`, on a connection that does not outlive it. */
export async function readSessionBusProperty(
  spec: {
    readonly busName: string;
    readonly objectPath: string;
    readonly interfaceName: string;
    readonly propertyName: string;
  },
  options: KWinComputerDbusOptions = {},
): Promise<unknown> {
  return await withSessionBus(options, async (bus) => {
    const object = await withBusTimeout(
      Promise.resolve(bus.getProxyObject(spec.busName, spec.objectPath)),
      "getProxyObject",
    );
    const properties = object.getInterface("org.freedesktop.DBus.Properties");
    return await invokeKWinDbusMethod(properties, "Get", spec.interfaceName, spec.propertyName);
  });
}

/**
 * Runs one operation on a throwaway session-bus connection.
 *
 * The `error`/`disconnect` listeners are the load-bearing part: dbus-next emits
 * connection failures on the bus object itself, and an unhandled `error` event
 * takes the whole process down. A probe that can crash the server the first
 * time it runs on a host with no session bus is worse than no probe.
 */
async function withSessionBus<T>(
  options: KWinComputerDbusOptions,
  operation: (bus: ReturnType<typeof dbusModule.sessionBus>) => Promise<T>,
): Promise<T> {
  // Keep the optional Linux runtime out of test imports; this resolves only on
  // the production path, after the platform gate. Tests inject a fake.
  const require = createRequire(import.meta.url);
  const dbus = options.dbusModule ?? (require("dbus-next") as typeof dbusModule);
  const bus = dbus.sessionBus();
  const eventBus = bus as unknown as EventEmitter;
  let connectionError: unknown;
  const onError = (error: unknown) => {
    connectionError ??= error;
  };
  eventBus.on("error", onError);
  eventBus.on("disconnect", onError);
  try {
    return await operation(bus);
  } catch (error) {
    throw asError(connectionError ?? error);
  } finally {
    // Disconnecting can itself surface as an 'error' event on the bus
    // (ECONNRESET during close is routine), so the handlers stay attached
    // through it — removing them first would turn that into an unhandled
    // 'error' on a bare EventEmitter, which crashes the process.
    bus.disconnect();
    eventBus.off("error", onError);
    eventBus.off("disconnect", onError);
  }
}

function withBusTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${KWIN_DBUS_DEFAULT_TIMEOUT_MS} ms`));
    }, KWIN_DBUS_DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(asError(error));
      },
    );
  });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
