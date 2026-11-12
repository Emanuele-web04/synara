// FILE: scripts/measure-perf.ts
// Purpose: Reproducible latency and traffic measurements for the account API.
// Two modes, both read-only:
//   public  Times unauthenticated endpoints from this machine: a new connection,
//           a kept-alive request with no database work (/instance) and one with
//           exactly one query (/profiles/<missing>). The difference isolates one
//           database round trip; the kept-alive floor is network plus the
//           Worker -> Durable Object -> container hop.
//   tail    Aggregates live production requests per route from `wrangler tail`
//           (needs `wrangler login`): request rate, wall time p50/p95/max. Raw
//           events stay in memory; only route patterns and numbers are printed.
// Layer: API dev tooling (never imported by the service).
// Usage: bun run scripts/measure-perf.ts public [--base <url>] [--runs 3] [--samples 8]
//        bun run scripts/measure-perf.ts tail   [--worker <name>] [--seconds 180] [--runs 3]

import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

const DEFAULT_BASE = "https://synara-account-api-trial.synara-orgs.workers.dev";
const DEFAULT_WORKER = "synara-account-api-trial";

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function percentile(values: readonly number[], q: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}
const median = (values: readonly number[]) => percentile(values, 0.5);
const spread = (values: readonly number[]) =>
  values.length === 0
    ? "n/a"
    : `${Math.round(Math.min(...values))}-${Math.round(Math.max(...values))}`;

function printEnvironment() {
  const bun = (globalThis as { Bun?: { version: string } }).Bun?.version;
  console.log(
    `machine: ${os.platform()} ${os.release()} ${os.arch()}, ${os.cpus()[0]?.model ?? "cpu"} x${os.cpus().length}` +
      `, ${bun ? `bun ${bun}` : `node ${process.version}`}, ${new Date().toISOString()}`,
  );
}

/** One curl process per call; several URLs in one call share a connection. */
function curlTimes(
  urls: readonly string[],
): { status: number; connectMs: number; ttfbMs: number }[] {
  const format = "%{http_code} %{time_connect} %{time_starttransfer}\\n";
  const args = ["-s", "--max-time", "20"];
  for (const url of urls) args.push("-o", "/dev/null", "-w", format, url);
  const result = spawnSync("curl", args, { encoding: "utf8" });
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [status, connect, ttfb] = line.split(" ");
      return {
        status: Number(status),
        connectMs: Number(connect) * 1000,
        ttfbMs: Number(ttfb) * 1000,
      };
    });
}

function measurePublic() {
  const base = option("base", DEFAULT_BASE).replace(/\/$/, "");
  const runs = Number(option("runs", "3"));
  const samples = Number(option("samples", "8"));
  const instance = `${base}/api/v1/instance`;
  const oneQuery = `${base}/api/v1/profiles/zz-perf-probe-missing`;
  console.log(`target: ${base} (${samples} samples per case, ${runs} runs)`);
  const table: Record<string, number[]> = { cold: [], warmNoDb: [], warmOneQuery: [] };
  for (let run = 1; run <= runs; run += 1) {
    const cold = Array.from({ length: samples }, () => curlTimes([instance])[0]!.ttfbMs);
    // First response of a shared connection pays the handshake; drop it.
    const warm = curlTimes([instance, ...Array.from({ length: samples }, () => instance)])
      .slice(1)
      .map((sample) => sample.ttfbMs);
    const query = curlTimes([instance, ...Array.from({ length: samples }, () => oneQuery)])
      .slice(1)
      .map((sample) => sample.ttfbMs);
    table.cold!.push(median(cold));
    table.warmNoDb!.push(median(warm));
    table.warmOneQuery!.push(median(query));
    console.log(
      `run ${run}: new-connection /instance ${Math.round(median(cold))} ms | kept-alive /instance ` +
        `${Math.round(median(warm))} ms | kept-alive 1-query ${Math.round(median(query))} ms`,
    );
  }
  console.log("\ncase                           median-of-runs  spread(ms)");
  for (const [name, label] of [
    ["cold", "new connection, no DB"],
    ["warmNoDb", "kept-alive, no DB"],
    ["warmOneQuery", "kept-alive, 1 DB query"],
  ] as const)
    console.log(
      `${label.padEnd(30)} ${String(Math.round(median(table[name]!))).padStart(8)} ms   ${spread(table[name]!)}`,
    );
  console.log(
    `one DB round trip ~= ${Math.round(median(table.warmOneQuery!) - median(table.warmNoDb!))} ms (difference of medians; within noise if small)`,
  );
}

type TailEvent = {
  executionModel?: string;
  wallTime?: number;
  eventTimestamp?: number;
  event?: { request?: { url?: string; method?: string }; response?: { status?: number } };
};

/** `wrangler tail --format json` prints pretty-printed objects back to back. */
function parseConcatenatedJson(raw: string): TailEvent[] {
  const events: TailEvent[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          events.push(JSON.parse(raw.slice(start, index + 1)) as TailEvent);
        } catch {
          // A truncated final object is dropped.
        }
        start = -1;
      }
    }
  }
  return events;
}

function routePattern(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return "unknown";
  }
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id")
    .replace(/REDACTED/g, ":id")
    .replace(/\/profiles\/[^/]+/, "/profiles/:handle")
    .replace(/\/sync-key-wraps\/[^/]+/, "/sync-key-wraps/:deviceId");
}

async function tailOnce(worker: string, seconds: number) {
  const child = spawn("wrangler", ["tail", worker, "--format", "json"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  // Registered before the window: a tail that exits early (not logged in,
  // missing binary) has already closed by the time the window would end.
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", () => resolve());
  });
  let raw = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    raw += chunk;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, seconds * 1000);
    }),
  ]);
  clearTimeout(timer);
  child.kill("SIGINT");
  await closed;
  const requests = parseConcatenatedJson(raw).filter(
    (event) => event.executionModel === "stateless" && event.event?.request?.url,
  );
  const stamps = requests.map((event) => event.eventTimestamp ?? 0).filter((stamp) => stamp > 0);
  const windowSeconds =
    stamps.length > 1 ? (Math.max(...stamps) - Math.min(...stamps)) / 1000 : seconds;
  const routes = new Map<string, number[]>();
  for (const event of requests) {
    const request = event.event!.request!;
    const status = event.event?.response?.status ?? 0;
    const key = `${request.method} ${routePattern(request.url!)} ${status}`;
    const walls = routes.get(key) ?? [];
    walls.push(event.wallTime ?? 0);
    routes.set(key, walls);
  }
  return { windowSeconds, total: requests.length, routes };
}

async function measureTail() {
  const worker = option("worker", DEFAULT_WORKER);
  const seconds = Number(option("seconds", "180"));
  const runs = Number(option("runs", "3"));
  console.log(
    `worker: ${worker} (${runs} windows of ${seconds}s; wall time is measured at the Worker)`,
  );
  const perRoute = new Map<
    string,
    { perMinute: number[]; p50: number[]; p95: number[]; max: number[] }
  >();
  const totals: number[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const { windowSeconds, total, routes } = await tailOnce(worker, seconds);
    const minutes = windowSeconds / 60;
    totals.push(total / minutes);
    console.log(
      `run ${run}: ${total} requests in ${Math.round(windowSeconds)}s = ${Math.round(total / minutes)}/min`,
    );
    for (const [key, walls] of routes) {
      const row = perRoute.get(key) ?? { perMinute: [], p50: [], p95: [], max: [] };
      row.perMinute.push(walls.length / minutes);
      row.p50.push(median(walls));
      row.p95.push(percentile(walls, 0.95));
      row.max.push(Math.max(...walls));
      perRoute.set(key, row);
    }
  }
  console.log(
    `\nall routes: median ${Math.round(median(totals))}/min, spread ${spread(totals)}/min`,
  );
  console.log("\n  /min  (spread)     p50ms   p95ms   maxms  route status   [medians across runs]");
  for (const [key, row] of [...perRoute].toSorted(
    (left, right) => median(right[1].perMinute) - median(left[1].perMinute),
  ))
    console.log(
      `${median(row.perMinute).toFixed(1).padStart(6)}  ${`(${spread(row.perMinute)})`.padEnd(11)} ` +
        `${String(Math.round(median(row.p50))).padStart(6)}  ${String(Math.round(median(row.p95))).padStart(6)}  ` +
        `${String(Math.round(Math.max(...row.max))).padStart(6)}  ${key}`,
    );
}

printEnvironment();
const mode = process.argv[2];
if (mode === "public") measurePublic();
else if (mode === "tail") await measureTail();
else {
  console.error("Usage: bun run scripts/measure-perf.ts <public|tail> [options]");
  process.exit(2);
}
