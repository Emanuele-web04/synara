// Shared pieces of the web-boot scripts: variant specs, the isolated server, the warm
// browser, network profiles and summary statistics.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const HARNESS_REPO = path.resolve(import.meta.dirname, "../..");
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// "name=<checkout>" serves <checkout>/apps/web/dist; "name=<checkout>@<dist>" serves <dist>.
// The server always comes from <checkout>, so `main` runs main's server.
export function parseVariant(spec) {
  const match = /^([^=]+)=([^@]+)(?:@(.+))?$/.exec(spec);
  if (!match) throw new Error(`bad --variant ${spec}; expected name=<checkout>[@<dist>]`);
  const [, name, repo, dist] = match;
  const variant = {
    name,
    repo: path.resolve(repo),
    dist: path.resolve(dist ?? path.join(repo, "apps/web/dist")),
  };
  for (const file of [
    path.join(variant.repo, "apps/server/src/index.ts"),
    path.join(variant.dist, "index.html"),
  ]) {
    if (!existsSync(file)) throw new Error(`${name}: missing ${file}`);
  }
  return variant;
}

// Round r starts at variant r mod n, so every variant takes every position equally often.
export function rotation(variants, round) {
  const start = round % variants.length;
  return [...variants.slice(start), ...variants.slice(0, start)];
}

export function assertPortFree(port) {
  let out = "";
  try {
    out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  } catch {
    // lsof exits 1 when nothing listens.
  }
  if (out.trim()) throw new Error(`port ${port} is in use:\n${out}`);
}

// CDP Network.emulateNetworkConditions values. Throughput is bytes per second.
export const NETWORK_PROFILES = {
  none: null,
  // R6 remote-host case: 40 ms round trip, 20 Mbit/s down, 10 Mbit/s up.
  slow: { offline: false, latency: 40, downloadThroughput: 20e6 / 8, uploadThroughput: 10e6 / 8 },
};

// Data directory layout (seed.mjs creates it): template/ is the seeded SYNARA_HOME,
// workspaces/ the project folders it points at. Each sample restores template/ into
// home-active/ and starts the variant's own server on it. fake-home/ is HOME for the
// server, with provider config and secure-store roots inside it, so no provider can
// find the operator's credentials (no usage fetches, no model calls).
export async function startServer({ variant, data, port, homeKind = "seeded" }) {
  const home = path.join(data, "home-active");
  const fakeHome = path.join(data, "fake-home");
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (homeKind === "seeded") cpSync(path.join(data, "template"), home, { recursive: true });
  else mkdirSync(home, { recursive: true });
  for (const dir of [".codex", ".claude", ".claude-secure"]) {
    mkdirSync(path.join(fakeHome, dir), { recursive: true });
  }
  const env = {
    ...process.env,
    HOME: fakeHome,
    CODEX_HOME: path.join(fakeHome, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(fakeHome, ".claude"),
    CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(fakeHome, ".claude-secure"),
    SYNARA_HOME: home,
    SYNARA_STATIC_DIR: variant.dist,
    SYNARA_PORT: String(port),
    SYNARA_MODE: "web",
    SYNARA_NO_BROWSER: "1",
  };
  delete env.SYNARA_AUTH_TOKEN;
  const startedAt = performance.now();
  // Own process group, so stop() also ends anything the server spawned (provider probes).
  const child = spawn("bun", [path.join(variant.repo, "apps/server/src/index.ts")], {
    cwd: path.join(data, "workspaces"),
    env,
    stdio: "ignore",
    detached: true,
  });
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false; // group already gone
    }
  };
  const stop = async () => {
    if (child.exitCode === null) {
      signalGroup("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          signalGroup("SIGKILL");
          resolve();
        }, 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // Children that outlive the server would keep writing into the data home.
    for (let i = 0; i < 20 && signalGroup(0); i += 1) await sleep(100);
    signalGroup("SIGKILL");
    await sleep(300);
  };
  let readyMs = null;
  for (let i = 0; i < 3000 && readyMs === null; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.ok) {
        await res.arrayBuffer();
        readyMs = performance.now() - startedAt;
      }
    } catch {
      // not listening yet
    }
    if (readyMs === null) await sleep(10);
  }
  if (readyMs === null) {
    await stop();
    throw new Error(`${variant.name}: server did not start on ${port}`);
  }
  // Let server start-up work settle so it does not compete with the page load.
  await sleep(1500);
  return { readyMs, stop, url: `http://127.0.0.1:${port}/` };
}

// One browser for the whole run, warmed with a blank page: a browser launched per sample
// adds process start-up to the first paint.
export async function launchWarmBrowser() {
  const { chromium } = await import(
    pathToFileURL(path.join(HARNESS_REPO, "apps/web/node_modules/playwright/index.mjs")).href
  );
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("about:blank");
  await context.close();
  return browser;
}

// Nearest-rank quantile.
export function quantile(values, p) {
  const sorted = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  sorted.sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1) + 0.5))];
}
