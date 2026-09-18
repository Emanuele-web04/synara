#!/usr/bin/env bun
/**
 * Standalone Cua driver host — runs the same {@link CuaDriverHost} the macOS
 * desktop embeds, outside Electron, against a provisioned upstream
 * `cua-driver`. This is the Windows/Linux deployment path: the Synara server
 * reaches the socket this host listens on through `SYNARA_CUA_HOST_SOCKET`
 * and authenticates every request with the shared capability
 * (`SYNARA_BROWSER_HOST_CAPABILITY`).
 *
 *   bun apps/desktop/src/cuaDriverHostStandalone.ts \
 *     --driver /opt/synara/cua-driver [--socket /run/synara-cua/host.sock]
 *
 * What the standalone host is not: a port of the macOS safety layer. The
 * provisioned driver is the unpatched upstream build (`nativeRevision: null`
 * below), so the compact cursor and the Synara observation-timing envs do
 * not exist — the host reports `driverNativeRevision: 0` on every reply and
 * the backend narrows advertised capabilities accordingly. Upstream also
 * implements no `cancel_input` method: cancels on a reads-only generation
 * kill and respawn the driver, while a generation that dispatched input
 * fails closed ("admission closed; driver not killed") — the next action
 * respawns cleanly, but held OS input cannot be released without the
 * macOS-only `releaseHeldInput` helper. There is no AppSnap helper, so no
 * masked-activation shield, no frame tap, and no permission setup path;
 * `check_permissions` falls through to the driver's own platform report.
 */

import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { CuaDriverHost, sweepOrphanedCuaDrivers } from "./cuaDriverHost";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function usage(message: string): never {
  console.error(`cua-driver-host: ${message}`);
  console.error(
    "usage: cua-driver-host --driver <binary-or-bundle-dir> " +
      "[--socket <unix-path|\\\\.\\pipe\\name>] [--capability-file <path>]",
  );
  process.exit(2);
}

/**
 * A unix socket path that survives the host is safe to replace only when
 * nothing answers on it — unlinking a live listener would strand every
 * client without killing the owning process.
 */
async function clearStaleSocket(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await access(endpoint);
  } catch {
    return;
  }
  const live = await new Promise<boolean>((resolve) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
  if (live) throw new Error(`A live host already listens on ${endpoint}.`);
  await unlink(endpoint);
}

const driverOption = option("--driver") ?? process.env.SYNARA_CUA_DRIVER;
if (!driverOption) usage("--driver is required (provisioned cua-driver binary or bundle dir).");

let binaryPath = driverOption;
if ((await stat(driverOption).catch(() => undefined))?.isDirectory()) {
  binaryPath = join(driverOption, process.platform === "win32" ? "cua-driver.exe" : "cua-driver");
}
await access(binaryPath).catch(() => usage(`driver not found or not readable: ${binaryPath}`));

// The capability is the authority boundary on this socket — it must never
// travel through argv, which every process on the machine can read.
const capabilityFile = option("--capability-file");
let capability = process.env.SYNARA_CUA_HOST_CAPABILITY?.trim() ?? "";
let capabilitySource = "environment";
if (!capability && capabilityFile) {
  capability = (await readFile(capabilityFile, "utf8").catch(() => "")).trim();
  capabilitySource = capabilityFile;
}
if (!capability) {
  capability = randomBytes(32).toString("base64url");
  if (capabilityFile) {
    await writeFile(capabilityFile, capability + "\n", { mode: 0o600 });
    capabilitySource = capabilityFile;
  } else {
    capabilitySource = "generated-below";
  }
}
if (Buffer.byteLength(capability, "utf8") < 32)
  usage("capability must be at least 32 bytes (SYNARA_CUA_HOST_CAPABILITY or --capability-file).");

const endpoint = option("--socket");
if (endpoint) await clearStaleSocket(endpoint);

sweepOrphanedCuaDrivers();
const host = new CuaDriverHost({
  binaryPath,
  // TCC's bundle identity has no meaning off macOS; the string still labels
  // this host in permission replies that surface it.
  bundleId: `synara-cua-standalone-${process.platform}`,
  capability,
  nativeRevision: null,
  ...(endpoint ? { hostEndpoint: endpoint } : {}),
  setup: async () => {
    throw new Error(
      `This host cannot request ${process.platform} permissions. Grant the driver host ` +
        "whatever display-server or automation access the platform requires, then retry.",
    );
  },
});

const bound = await host.listen();
const shutdown = async (signal: string) => {
  console.info(`[cua-driver-host] ${signal} received; disposing`);
  await host.dispose().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Everything the operator needs to wire the server, on stdout. The
// capability value itself only prints when it was generated with nowhere
// to store it — a bootstrap path, not a logging channel.
console.info(`CUA_HOST_ENDPOINT=${bound}`);
if (capabilitySource === "generated-below") {
  console.info(`CUA_CAPABILITY=${capability}`);
  console.info(
    "[cua-driver-host] generated an ephemeral capability (above). Set it on the server as " +
      "SYNARA_BROWSER_HOST_CAPABILITY; it dies with this host.",
  );
} else {
  console.info(`[cua-driver-host] capability source: ${capabilitySource}`);
}
console.info(
  "[cua-driver-host] server wiring: SYNARA_CUA_HOST_SOCKET=" +
    bound +
    " SYNARA_BROWSER_HOST_CAPABILITY=<capability>",
);
console.info(`[cua-driver-host] driver: ${basename(binaryPath)} (unpatched upstream)`);
