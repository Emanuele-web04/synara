// Local fixed-day spool receipts for the existing product sender.
// The daily hash crosses the wire; the product UUID and consent generation stay local.
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  statSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HOST_USAGE_RECEIPT_DAYS, type HostUsageWindow } from "@synara/contracts/hostUsage";
import {
  HOST_USAGE_DAY_MS,
  HOST_USAGE_DIRECTORY,
  HOST_USAGE_POLICY_FILE,
  HOST_USAGE_RECEIPTS_FILE,
  normalizeHostUsageWindow,
} from "@synara/shared/hostUsage";

type Policy = { enabled: true; policyId: string; since: string };
export class HostUsageRelay {
  private readonly root: string;
  private policy: Policy | null = null;
  constructor(
    homeDir: string,
    private readonly channel: "stable" | "beta" | "remote",
  ) {
    this.root = join(homeDir, "product-analytics");
  }

  /** Restarts preserve the cutoff; a new opt-in begins a new consent generation. */
  enable(): void {
    const saved = this.read(HOST_USAGE_POLICY_FILE);
    this.policy =
      saved?.enabled === true &&
      typeof saved.policyId === "string" &&
      /^[0-9a-f-]{36}$/.test(saved.policyId) &&
      typeof saved.since === "string" &&
      Number.isFinite(Date.parse(saved.since)) &&
      Date.parse(saved.since) <= Date.now()
        ? (saved as Policy)
        : { enabled: true, policyId: randomUUID(), since: new Date().toISOString() };
    this.write(HOST_USAGE_POLICY_FILE, this.policy);
  }

  /** Consent/identity reset invalidates both frozen snapshots and local delivery receipts. */
  clear(): void {
    this.policy = null;
    for (const name of [HOST_USAGE_POLICY_FILE, HOST_USAGE_RECEIPTS_FILE, HOST_USAGE_DIRECTORY])
      rmSync(join(this.root, name), { force: true, recursive: name === HOST_USAGE_DIRECTORY });
  }

  /** Reconstruct a pending window with a day-scoped hash, never an account or installation key. */
  peek(installId: string): HostUsageWindow | null {
    const policy = this.policy;
    if (!policy) return null;
    const receipts = this.read(HOST_USAGE_RECEIPTS_FILE);
    const delivered =
      receipts?.policyId === policy.policyId && Array.isArray(receipts.days)
        ? new Set(receipts.days)
        : new Set();
    let files: string[];
    try {
      files = readdirSync(join(this.root, HOST_USAGE_DIRECTORY)).sort();
    } catch {
      return null;
    }
    for (const name of files) {
      if (!/^[0-9a-f-]{36}-\d{4}-\d\d-\d\d\.json$/.test(name)) continue;
      const raw = this.read(join(HOST_USAGE_DIRECTORY, name));
      if (
        !raw ||
        raw.policyId !== policy.policyId ||
        typeof raw.windowStart !== "string" ||
        delivered.has(raw.windowStart.slice(0, 10))
      )
        continue;
      const windowId = createHash("sha256")
        .update(`${installId}\n${raw.windowStart}\n${raw.windowEnd}`)
        .digest("hex");
      const window = normalizeHostUsageWindow({ ...raw, windowId, channel: this.channel });
      if (
        window &&
        window.coveredFrom ===
          new Date(Math.max(Date.parse(window.windowStart), Date.parse(policy.since))).toISOString()
      )
        return window;
    }
    return null;
  }

  /** Persist the receipt before removing the spool, so retry/restart cannot change its window. */
  acknowledge(window: HostUsageWindow): void {
    const policy = this.policy;
    if (!policy) return;
    const raw = this.read(HOST_USAGE_RECEIPTS_FILE);
    const days =
      raw?.policyId === policy.policyId && Array.isArray(raw.days)
        ? raw.days.filter((day): day is string => typeof day === "string")
        : [];
    const cutoff = Date.now() - HOST_USAGE_RECEIPT_DAYS * HOST_USAGE_DAY_MS;
    const kept = [...new Set([...days, window.windowStart.slice(0, 10)])]
      .filter((day) => Date.parse(`${day}T00:00:00.000Z`) + HOST_USAGE_DAY_MS >= cutoff)
      .sort();
    this.write(HOST_USAGE_RECEIPTS_FILE, { policyId: policy.policyId, days: kept });
    rmSync(
      join(
        this.root,
        HOST_USAGE_DIRECTORY,
        `${policy.policyId}-${window.windowStart.slice(0, 10)}.json`,
      ),
      { force: true },
    );
  }
  private read(name: string): Record<string, unknown> | null {
    try {
      if (statSync(join(this.root, name)).size > 128 * 1024) return null;
      const value: unknown = JSON.parse(readFileSync(join(this.root, name), "utf8"));
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  private write(name: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const target = join(this.root, name),
      staging = `${target}.tmp-${process.pid}`;
    try {
      writeFileSync(staging, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      renameSync(staging, target);
    } finally {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}
