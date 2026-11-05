import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { spawnProcess } from "@synara/shared/processRuntime";
import { teardownChildProcessTree } from "../platform/supervisedProcessTeardown";

async function metricsPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Owns one connector child at a time, including verified teardown before replacement. */
export function startCloudflareConnector(options: {
  executable: (signal: AbortSignal) => Promise<string>;
  home: string;
  configurationFile: string;
  token: (signal: AbortSignal) => Promise<string>;
  ready: (value: boolean) => void;
  signal: AbortSignal;
}) {
  const lifetime = new AbortController();
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const wait = (ms: number) => delay(ms, undefined, { signal }).catch(() => {});
  const done = (async () => {
    let failures = 0;
    while (!signal.aborted) {
      options.ready(false);
      let token: string;
      let executable: string;
      let port: number;
      try {
        token = await options.token(signal);
        if (signal.aborted) break;
        executable = await options.executable(signal);
        if (signal.aborted) break;
        port = await metricsPort();
      } catch {
        await wait(
          Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6)) * (0.8 + Math.random() * 0.4),
        );
        continue;
      }
      if (signal.aborted) break;
      const started = Date.now();
      const child = spawnProcess(
        executable,
        [
          "tunnel",
          "--config",
          options.configurationFile,
          "--no-autoupdate",
          "--metrics",
          `127.0.0.1:${port}`,
          "run",
        ],
        {
          // No inherited provider credentials. The per-tunnel credential never appears in argv or logs.
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: options.home,
            USERPROFILE: options.home,
            TUNNEL_TOKEN: token,
          },
          cwd: options.home,
          stdio: "ignore",
        },
      );
      let exited = false;
      child.once("error", () => {
        exited = true;
        options.ready(false);
      });
      child.once("exit", () => {
        exited = true;
        options.ready(false);
      });
      try {
        // Exit/error callbacks update this fence while awaiting readiness.
        // eslint-disable-next-line no-unmodified-loop-condition
        while (!signal.aborted && !exited) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/ready`, {
              redirect: "error",
              signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
            });
            await response.body?.cancel();
            if (!signal.aborted && !exited) options.ready(response.ok);
          } catch {
            options.ready(false);
          }
          await wait(2_000);
        }
      } finally {
        options.ready(false);
        // A teardown failure rejects done and prevents spawning another child.
        await teardownChildProcessTree(child);
      }
      if (Date.now() - started > 30_000) failures = 0;
      await wait(
        Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6)) * (0.8 + Math.random() * 0.4),
      );
    }
  })();
  // Keep an owned rejection boundary even when a caller stops much later.
  void done.catch(() => options.ready(false));
  return {
    done,
    stop: async () => {
      lifetime.abort();
      await done;
    },
  };
}
