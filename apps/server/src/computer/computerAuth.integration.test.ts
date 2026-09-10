import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import {
  COMPUTER_INTERFACE,
  COMPUTER_OBJECT_PATH,
  COMPUTER_SERVICE,
  openComputerSessionBus,
} from "./kwinDbus";

it.skipIf(!process.env.SYNARA_COMPUTER_AUTH_PROBE)(
  "authenticates one server and refuses unrelated callers on an isolated bus",
  async () => {
    const daemon = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const address = String((await once(daemon.stdout, "data"))[0]).trim();
    const fixture = spawn(process.env.SYNARA_COMPUTER_AUTH_PROBE!, [], {
      env: {
        ...process.env,
        TMPDIR: "/different-compositor-tmpdir",
        DBUS_SESSION_BUS_ADDRESS: address,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const dbus = createRequire(import.meta.url)("dbus-next") as typeof import("dbus-next");
    const stranger = dbus.sessionBus({ busAddress: address });
    let server: Awaited<ReturnType<typeof openComputerSessionBus>> | undefined;
    try {
      await once(fixture.stdout, "data");
      const proxy = await stranger.getProxyObject(COMPUTER_SERVICE, COMPUTER_OBJECT_PATH);
    const plugin = proxy.getInterface(COMPUTER_INTERFACE) as unknown as {
        stateJson(): Promise<string>;
        authenticate(token: string): Promise<string>;
      };
      await expect(plugin.stateJson()).rejects.toThrow(/Authenticate/);
      await expect(plugin.authenticate("0".repeat(64))).resolves.toBe("");
      const options = {
        dbusModule: { sessionBus: () => dbus.sessionBus({ busAddress: address }) },
      };
      server = await openComputerSessionBus(options);
      const authenticated = await server.connectPlugin();
      await expect(authenticated.stateJson()).resolves.toBe("authorized");
      await expect(plugin.stateJson()).rejects.toThrow(/Authenticate/);
      await expect(openComputerSessionBus(options)).rejects.toThrow(/Another Synara server/);
      await server.close();
      server = await openComputerSessionBus(options);
      await expect((await server.connectPlugin()).stateJson()).resolves.toBe("authorized");
    } finally {
      await server?.close();
      stranger.disconnect();
      fixture.kill();
      daemon.kill();
    }
  },
  15_000,
);
