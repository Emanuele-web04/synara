import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnParentBoundProcess } from "@synara/shared/parentBoundProcess";
import { isProcessRunning } from "../platform/processTreeController";

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  description: string,
): Promise<T> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function killOwner(owner: ChildProcess): Promise<void> {
  if (owner.exitCode !== null || owner.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
  owner.kill("SIGKILL");
  await exited;
}

// The fixture uses an executable shebang and real POSIX termination signals.
describe.skipIf(process.platform === "win32")("Cloudflare connector owner lifetime", () => {
  let directory: string;
  let ownerBundle: string;
  beforeAll(async () => {
    directory = await fsp.mkdtemp(join(tmpdir(), "synara-connector-fixture-"));
    ownerBundle = join(directory, "owner.mjs");
    const fixture = fileURLToPath(
      new URL("../fixtures/cloudflareConnectorOwner.ts", import.meta.url),
    );
    execFileSync("bun", ["build", fixture, "--target=node", "--outfile", ownerBundle]);
  });
  afterAll(async () => {
    if (directory) await fsp.rm(directory, { recursive: true, force: true });
  });

  it.each([
    "stop",
    "stubborn-stop",
    "wrapper-stop",
    "wrapper-stubborn-stop",
    "crash",
    "kill",
    "stubborn",
  ] as const)(
    "retires its actual connector after owner %s",
    async (mode) => {
      const home = await fsp.mkdtemp(join(directory, "home-"));
      const executable = join(home, "connector.mjs");
      await fsp.writeFile(
        executable,
        `#!${process.execPath}\n` +
          `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import http from 'node:http';
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--metrics') + 1].split(':').at(-1));
${mode.includes("stubborn") ? "process.on('SIGTERM', () => {});" : ""}
http.createServer((_req, res) => res.writeHead(200).end()).listen(port, '127.0.0.1', () => {
  writeFileSync(join(process.env.HOME, 'child.json'), JSON.stringify({
    pid: process.pid, parentPid: process.ppid,
    privateToken: process.env.TUNNEL_TOKEN === 'fixture-only-token',
    tokenInArgv: args.some(arg => arg.includes('fixture-only-token'))
  }));
});\n`,
        { mode: 0o700 },
      );
      const command = mode.startsWith("wrapper") ? join(home, "wrapper.sh") : executable;
      if (command !== executable) {
        await fsp.writeFile(command, `#!/bin/sh\n"${executable}" "$@"\nexit $?\n`, {
          mode: 0o700,
        });
      }
      const owner = spawn(process.execPath, [ownerBundle, command, home], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      const ownerExited = new Promise<number | null>((resolve) => owner.once("exit", resolve));
      let child:
        | { pid: number; parentPid: number; privateToken: boolean; tokenInArgv: boolean }
        | undefined;
      let stderr = "";
      owner.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      try {
        child = await waitFor(() => {
          if (owner.exitCode !== null || owner.signalCode !== null)
            throw new Error(`Connector owner exited before readiness: ${stderr}`);
          if (!fs.existsSync(join(home, "ready"))) return undefined;
          return JSON.parse(fs.readFileSync(join(home, "child.json"), "utf8"));
        }, "connector readiness");
        expect(child?.privateToken).toBe(true);
        expect(child?.tokenInArgv).toBe(false);
        expect(isAlive(child!.pid)).toBe(true);
        if (mode === "stop" || mode.endsWith("-stop")) owner.send("stop");
        else if (mode === "crash") owner.send(mode);
        else owner.kill("SIGKILL");
        const code = await ownerExited;
        if (mode === "stop" || mode.endsWith("-stop")) expect(code, stderr).toBe(0);
        if (mode === "kill" || mode === "stubborn") expect(owner.signalCode).toBe("SIGKILL");
        if (mode === "crash") {
          expect(code).toBe(1);
          expect(stderr).toContain("Intentional backend crash fixture");
        }
        await waitFor(
          () => (isAlive(child!.pid) ? undefined : true),
          "connector exit after backend death",
        );
        if (child!.parentPid !== owner.pid)
          await waitFor(
            async () => ((await isProcessRunning(child!.parentPid)) ? undefined : true),
            "guardian exit",
          );
      } finally {
        await killOwner(owner);
        if (child && isAlive(child.pid)) process.kill(child.pid, "SIGKILL");
        if (child && child.parentPid !== owner.pid && isAlive(child.parentPid))
          process.kill(child.parentPid, "SIGKILL");
        owner.stderr?.destroy();
        await fsp.rm(home, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it.each(["early-stop", "guardian-killed"] as const)(
    "requires native exit proof during %s",
    async (mode) => {
      const home = await fsp.mkdtemp(join(directory, "guardian-"));
      const marker = join(home, "pid");
      const leaf = join(home, "leaf.cjs");
      await fsp.writeFile(
        leaf,
        `process.on('SIGTERM', () => {});
require('node:fs').writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);`,
      );
      const owned = spawnParentBoundProcess(process.execPath, [leaf, marker], {
        cwd: home,
        env: { PATH: process.env.PATH },
      });
      let leafPid: number | undefined;
      try {
        if (mode === "guardian-killed") {
          leafPid = await waitFor(
            () => (fs.existsSync(marker) ? Number(fs.readFileSync(marker, "utf8")) : undefined),
            "native child before guardian failure",
          );
          await killOwner(owned.child);
          await expect(owned.stop()).rejects.toThrow("without confirming child exit");
          expect(isAlive(leafPid)).toBe(true);
        } else {
          // Stop in the same tick as spawn, before any guardian startup signal.
          // A receipt must cover a child that starts after this request as well.
          await owned.stop();
          await owned.stop();
          expect(owned.child.signalCode).toBeNull();
          if (fs.existsSync(marker)) {
            leafPid = Number(fs.readFileSync(marker, "utf8"));
            expect(isAlive(leafPid)).toBe(false);
          }
        }
      } finally {
        await killOwner(owned.child);
        if (leafPid && isAlive(leafPid)) process.kill(leafPid, "SIGKILL");
        await fsp.rm(home, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
