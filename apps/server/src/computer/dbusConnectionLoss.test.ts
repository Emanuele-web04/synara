/**
 * A bus that dies under a live session, end to end.
 *
 * dbus-next 0.10.2 never emits `disconnect` and fails nothing when its socket
 * reaches EOF, so a dead bus used to go unnoticed: health stayed "connected"
 * and a call already waiting sat out its whole timeout (up to a minute for a
 * capture). These drive the real connection code — first over a fake
 * transport under the real backend engine, then over a real private
 * `dbus-daemon` that is SIGKILLed mid-call.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FakePlugin, withFakeDbusTransport } from "./computerPluginTestDoubles.ts";
import { DbusConnectionClosedError } from "./dbusPlumbing.ts";
import { isConnectionLevelFailure, KWinComputerBackend } from "./KWinComputerBackend.ts";
import {
  COMPUTER_INTERFACE,
  COMPUTER_OBJECT_PATH,
  COMPUTER_SERVICE,
  createSessionKWinComputerDbus,
  KWIN_PLUGINS_INTERFACE,
  openComputerSessionBus,
  waitForSessionBusName,
} from "./kwinDbus.ts";

const PLUGIN_ID = "SynaraComputerUsePluginV10";
const never = () => new Promise<never>(() => undefined);

/**
 * A dbus-next bus as `createSessionKWinComputerDbus` sees it, serving KWin's
 * plugin manager and a Synara plugin that delegates to `plugin` — or, while
 * `hang` is set, answers nothing at all.
 */
function kwinOverFakeTransport(plugin: FakePlugin, state: { hang: boolean }) {
  const daemon = Object.assign(new EventEmitter(), {
    RequestName: async () => 1,
    GetId: async () => `r2-${process.pid}`,
    // The plugin registers on KWin's own connection, so both names share it.
    GetNameOwner: async (name: string) =>
      name === COMPUTER_SERVICE || name === "org.kde.KWin" ? plugin.owner : ":1.1",
    Get: async (iface: string, property: string) =>
      iface === KWIN_PLUGINS_INTERFACE && property === "LoadedPlugins" ? [PLUGIN_ID] : undefined,
    LoadPlugin: async () => true,
    UnloadPlugin: async () => true,
  });
  const pluginInterface = new Proxy(
    {},
    {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined;
        if (key === "authenticate") return async () => plugin.instanceId;
        const method = (plugin as unknown as Record<string, unknown>)[key];
        if (typeof method !== "function") return undefined;
        return (...args: unknown[]) =>
          state.hang ? never() : (method as (...a: unknown[]) => unknown).apply(plugin, args);
      },
    },
  );
  return withFakeDbusTransport(
    Object.assign(new EventEmitter(), {
      getProxyObject: async () => ({
        getInterface: (name: string) => (name === COMPUTER_INTERFACE ? pluginInterface : daemon),
      }),
      disconnect: () => undefined,
    }),
  );
}

describe("a bus that dies under the backend", () => {
  it("reports reconnecting and fails the waiting call at once", async () => {
    const plugin = new FakePlugin();
    const state = { hang: false };
    const buses: Array<ReturnType<typeof kwinOverFakeTransport>> = [];
    const backend = new KWinComputerBackend({
      platform: "linux",
      sessionType: "wayland",
      linuxDistribution: () => ({ id: "arch" }),
      clipboardToolsPresent: () => true,
      atspi: { readTrees: async () => [], setText: async () => false, dispose: async () => {} },
      installedPluginIds: async () => [PLUGIN_ID],
      provisionPlugin: async () => {
        throw new Error("provisionPlugin was not stubbed in this test");
      },
      runningKwinVersion: async () => undefined,
      installedKwinVersion: async () => undefined,
      busNamesHaveOwners: async (names) => names.map(() => false),
      prebuiltRoot: () => undefined,
      buildToolingPresent: () => false,
      installStampPath: join(tmpdir(), "synara-absent-install.stamp"),
      sleep: async () => undefined,
      dbusFactory: () => {
        const bus = kwinOverFakeTransport(plugin, state);
        buses.push(bus);
        return createSessionKWinComputerDbus({ dbusModule: { sessionBus: () => bus as never } });
      },
    });
    try {
      await expect(backend.listWindows()).resolves.toHaveLength(1);
      expect(backend.health().status).toBe("connected");

      state.hang = true;
      const startedAt = Date.now();
      const waiting = backend.listWindows().catch((error: unknown) => error);
      await new Promise((resolve) => setTimeout(resolve, 20));
      buses[0]!.dropTransport();

      const error = await waiting;
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(error).toMatchObject({ retryable: true });
      expect(backend.health().status).toBe("reconnecting");
    } finally {
      state.hang = false;
      await backend.dispose();
    }
  });
});

/** `dbus-daemon` on PATH, or undefined — the real-bus tests skip without it. */
function findDbusDaemon(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "dbus-daemon");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * The service half of dbus-next, which the app's own declaration of the
 * module leaves out: only this test serves anything on a bus.
 */
interface DbusServiceModule {
  sessionBus(options: { readonly busAddress: string }): {
    export(path: string, iface: object): void;
    requestName(name: string, flags: number): Promise<number>;
    on(event: "error", listener: () => void): void;
    disconnect(): void;
  };
  readonly interface: {
    readonly Interface: {
      new (name: string): object;
      configureMembers(members: {
        readonly methods: Record<string, { inSignature: string; outSignature: string }>;
      }): void;
    };
  };
}

const DBUS_DAEMON = findDbusDaemon();
const TEST_SERVICE = "org.synara.ConnectionLossTest";
/** Everything below races this; each case must settle far inside it. */
const PROMPT_MS = 1_500;

describe.skipIf(DBUS_DAEMON === undefined)("a real bus daemon killed mid-call", () => {
  const require = createRequire(import.meta.url);
  const dbus = require("dbus-next") as DbusServiceModule;
  let directory: string | undefined;
  let daemon: ChildProcess | undefined;
  const clients: Array<{ disconnect(): void }> = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      try {
        client.disconnect();
      } catch {
        // Already gone with its daemon.
      }
    }
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill("SIGKILL");
      await new Promise((resolve) => daemon!.once("exit", resolve));
    }
    daemon = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
  });

  /** A private session bus: no service activation, nothing of the host's. */
  async function startDaemon(): Promise<string> {
    directory = await mkdtemp(join(tmpdir(), "synara-r2-bus-"));
    const config = join(directory, "bus.conf");
    await writeFile(
      config,
      [
        '<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"',
        ' "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">',
        "<busconfig><type>session</type>",
        `<listen>unix:dir=${directory}</listen>`,
        '<policy context="default"><allow send_destination="*" eavesdrop="true"/>',
        '<allow eavesdrop="true"/><allow own="*"/></policy>',
        "</busconfig>",
      ].join("\n"),
    );
    // `exec` keeps the pid the daemon's own, so SIGKILL reaches it; the ulimit
    // keeps a crash from raising a core-dump notification on the desktop.
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        'ulimit -c 0; exec "$0" --config-file="$1" --print-address=1 --nofork',
        DBUS_DAEMON!,
        config,
      ],
      { stdio: ["ignore", "pipe", "inherit"], env: { PATH: process.env.PATH ?? "" } },
    );
    daemon = child;
    return await new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const line = output.split("\n")[0];
        if (output.includes("\n") && line) resolve(line.trim());
      });
      child.once("exit", (code) => reject(new Error(`dbus-daemon exited (${code})`)));
    });
  }

  /** Owns `name` and exports `iface` at `path`, whose methods may never answer. */
  async function serve(
    address: string,
    name: string,
    path: string,
    interfaceName: string,
    methods: Record<
      string,
      { readonly in: string; readonly out: string; readonly fn: (...args: never[]) => unknown }
    >,
  ): Promise<void> {
    const { Interface } = dbus.interface;
    class Served extends Interface {}
    const members: Record<string, { inSignature: string; outSignature: string }> = {};
    for (const [method, spec] of Object.entries(methods)) {
      (Served.prototype as unknown as Record<string, unknown>)[method] = spec.fn;
      members[method] = { inSignature: spec.in, outSignature: spec.out };
    }
    Served.configureMembers({ methods: members });
    const service = dbus.sessionBus({ busAddress: address });
    // The daemon's death reaches this client too; unheard, it would be fatal.
    service.on("error", () => undefined);
    clients.push(service);
    service.export(path, new Served(interfaceName));
    await service.requestName(name, 0);
  }

  function killDaemon(): void {
    daemon!.kill("SIGKILL");
  }

  function withinPrompt<T>(promise: Promise<T>): Promise<T | "still waiting"> {
    return Promise.race([
      promise,
      new Promise<"still waiting">((resolve) =>
        setTimeout(() => resolve("still waiting"), PROMPT_MS),
      ),
    ]);
  }

  it("fails a waiting plugin call as connection-level and fires onDisconnect once", async () => {
    const address = await startDaemon();
    await serve(address, COMPUTER_SERVICE, COMPUTER_OBJECT_PATH, COMPUTER_INTERFACE, {
      authenticate: { in: "s", out: "s", fn: () => "r2-instance" },
      healthJson: { in: "", out: "s", fn: never },
    });
    const session = await openComputerSessionBus({ busAddress: address });
    clients.push({ disconnect: () => void session.close() });
    const disconnected = vi.fn();
    session.onDisconnect(disconnected);
    const plugin = await session.connectPlugin();
    const waiting = plugin.healthJson().catch((error: unknown) => error);
    // The call is on the wire, and the service is sitting on it.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const killedAt = Date.now();
    killDaemon();
    const error = await withinPrompt(waiting);

    expect(error).toBeInstanceOf(DbusConnectionClosedError);
    expect(isConnectionLevelFailure(error)).toBe(true);
    expect(Date.now() - killedAt).toBeLessThan(PROMPT_MS);
    expect(disconnected).toHaveBeenCalledTimes(1);
    // A call started after the drop fails at once as well.
    await expect(withinPrompt(plugin.healthJson())).rejects.toBeInstanceOf(
      DbusConnectionClosedError,
    );
    expect(disconnected).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("ends a bus-name wait when the daemon dies, not at its deadline", async () => {
    const address = await startDaemon();
    // The bus answers: a name that is there is found.
    await serve(address, TEST_SERVICE, "/org/synara/Test", "org.synara.Test", {});
    await expect(
      waitForSessionBusName({ busAddress: address, name: TEST_SERVICE, timeoutMs: 5_000 }),
    ).resolves.toBe(true);
    const waiting = waitForSessionBusName({
      busAddress: address,
      name: `${TEST_SERVICE}.Absent`,
      timeoutMs: 30_000,
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 150));

    killDaemon();
    await expect(withinPrompt(waiting)).resolves.toBeInstanceOf(DbusConnectionClosedError);
  }, 20_000);
});
