import fs from "node:fs/promises";
import path from "node:path";
import tls from "node:tls";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CloudflareClient } from "../../../api/src/remote/cloudflare";
import { createTunnelCoordinator } from "../../../api/src/remote/tunnels";
import { bindEphemeralHttpServer } from "./network";

/** Public TLS termination + opaque byte forwarding, with the production connector lifecycle. */
export async function createCloudflareFixture(baseDir: string) {
  const dir = path.join(baseDir, "edge-fixture");
  await fs.mkdir(dir, { mode: 0o700 });
  const cert = path.join(dir, "public.pem");
  const key = path.join(dir, "public-key.pem");
  const pause = path.join(dir, "paused");
  const pid = path.join(dir, "connector.pid");
  const executable = path.join(dir, "cloudflared");
  await fs.copyFile(path.join(import.meta.dirname, "cloudflaredFixture.mjs"), executable);
  await fs.chmod(executable, 0o755);
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  await fs.chmod(key, 0o600);
  const previousCa = tls.getCACertificates();
  tls.setDefaultCACertificates([...previousCa, await fs.readFile(cert, "utf8")]);
  const reservation = await bindEphemeralHttpServer();
  const port = Number(new URL(reservation.origin).port);
  await reservation.close();
  const origin = `https://127.0.0.1:${port}`;
  const tunnels = new Map<
    string,
    { id: string; name: string; hostname?: string; originPort?: number }
  >();
  const client: CloudflareClient = {
    async findTunnel(name) {
      return [...tunnels.values()].find((row) => row.name === name);
    },
    async createTunnel(name) {
      const row = { id: randomUUID(), name };
      tunnels.set(row.id, row);
      return row;
    },
    async configure(id, hostname, originPort) {
      Object.assign(tunnels.get(id)!, { hostname, originPort });
    },
    async ensureDns() {
      return randomUUID();
    },
    async token(id) {
      return Buffer.from(
        JSON.stringify({ ...tunnels.get(id), port, cert, key, pause, pid }),
      ).toString("base64url");
    },
    async deleteDns() {},
    async deleteTunnel(id) {
      tunnels.delete(id);
    },
  };
  return {
    origin,
    executable,
    cert,
    coordinator: ((db, _client, domain) => {
      const coordinator = createTunnelCoordinator(db, client, domain);
      return {
        ...coordinator,
        async endpoints(ids) {
          const endpoints = await coordinator.endpoints(ids);
          return new Map([...endpoints].map(([hostId]) => [hostId, origin]));
        },
      };
    }) satisfies typeof createTunnelCoordinator,
    async waitReady() {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          if ((await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) })).ok) return;
        } catch {
          /* Starting */
        }
        await delay(100);
      }
      throw new Error("Cloudflare fixture connector did not become ready");
    },
    async stopConnector() {
      await fs.writeFile(pause, "paused");
      try {
        process.kill(Number(await fs.readFile(pid, "utf8")), "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    },
    async restartConnector() {
      await fs.rm(pause, { force: true });
      await this.waitReady();
    },
    async close() {
      tls.setDefaultCACertificates(previousCa);
    },
  };
}
