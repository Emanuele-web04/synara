import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverServerRuntime, verifyServerRuntime } from "../../../server/src/externalMcp/bridge";
import { bindEphemeralHttpServer } from "./network";

/** A built application, isolated from operator homes, credentials and inherited policy. */
export async function startWorkspace(
  baseDir: string,
  remote: { connectorExecutable: string; publicCa: string },
  requestedOrigin?: string,
) {
  const reservation = requestedOrigin ? undefined : await bindEphemeralHttpServer();
  const origin = requestedOrigin ?? reservation!.origin;
  await reservation?.close();
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });
  const log = await fs.open(path.join(baseDir, "workspace.log"), "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      path.resolve(import.meta.dirname, "../../../server/dist/index.mjs"),
      "--home-dir",
      baseDir,
      "--port",
      new URL(origin).port,
      "--host",
      "127.0.0.1",
      "--no-browser",
      "--no-auto-bootstrap-project-from-cwd",
    ],
    {
      cwd: baseDir,
      env: {
        PATH: [path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: baseDir,
        TMPDIR: process.env.TMPDIR,
        SYNARA_REMOTE_CONNECTIONS: "1",
        SYNARA_DESKTOP_BUNDLE_ID: "",
        SYNARA_CLOUDFLARED_PATH: remote.connectorExecutable,
        NODE_EXTRA_CA_CERTS: remote.publicCa,
      },
      stdio: ["ignore", log.fd, log.fd],
    },
  );
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try {
      await exited;
      if (child.signalCode !== null) {
        throw new Error(`Workspace exited by ${child.signalCode} before proving graceful shutdown`);
      }
    } finally {
      clearTimeout(kill);
      await log.close();
      if (process.env.SYNARA_E2E_EVIDENCE) {
        await fs.mkdir(process.env.SYNARA_E2E_EVIDENCE, { recursive: true });
        await fs.copyFile(
          path.join(baseDir, "workspace.log"),
          path.join(process.env.SYNARA_E2E_EVIDENCE, `${path.basename(baseDir)}.log`),
        );
      }
    }
  };
  try {
    const deadline = Date.now() + 30_000;
    while (true) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null)
        throw new Error(
          `Workspace exited: ${await fs.readFile(path.join(baseDir, "workspace.log"), "utf8")}`,
        );
      try {
        const runtime = discoverServerRuntime(baseDir);
        await verifyServerRuntime(runtime, globalThis.fetch);
        break;
      } catch {
        if (Date.now() > deadline)
          throw new Error(
            `Workspace did not become ready: ${await fs.readFile(path.join(baseDir, "workspace.log"), "utf8")}`,
          );
        await delay(100);
      }
    }
    return { baseDir, origin, stop, [Symbol.asyncDispose]: stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
