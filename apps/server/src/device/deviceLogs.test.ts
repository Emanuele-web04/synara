import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseCrashReport,
  readCrashReports,
  tailLines,
  unifiedLogArguments,
} from "./deviceLogs.ts";

const UDID = "375CE30B-AC7C-4334-9059-59B6704D430E";

function crashReport(input: { readonly procPath: string; readonly signal?: string }): string {
  const header = JSON.stringify({ app_name: "Shop", bug_type: "309" });
  const body = JSON.stringify({
    procPath: input.procPath,
    exception: { type: "EXC_CRASH", signal: input.signal ?? "SIGABRT" },
    asi: { "libswiftCore.dylib": ["Fatal error: Unexpectedly found nil"] },
    termination: { indicator: "Abort trap: 6" },
  });
  return `${header}\n${body}`;
}

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("unifiedLogArguments", () => {
  const query = { bundleId: "com.example.shop", sinceSeconds: 120, limit: 50 } as const;

  it("scopes to the process and keeps Apple subsystems only at error level", () => {
    const args = unifiedLogArguments("Shop", { ...query, level: "default" });

    expect(args.slice(0, 5)).toEqual(["show", "--last", "120s", "--style", "compact"]);
    expect(args.at(-1)).toBe(
      'process == "Shop" AND eventType == logEvent AND (NOT subsystem BEGINSWITH "com.apple." OR messageType == error OR messageType == fault)',
    );
  });

  it("adds info and debug flags for the lower levels", () => {
    expect(unifiedLogArguments("Shop", { ...query, level: "debug" })).toContain("--debug");
    expect(unifiedLogArguments("Shop", { ...query, level: "info" })).toContain("--info");
    expect(unifiedLogArguments("Shop", { ...query, level: "error" }).at(-1)).toContain(
      "(messageType == error OR messageType == fault)",
    );
  });

  it("escapes quotes in the executable name", () => {
    expect(unifiedLogArguments('My "App"', { ...query, level: "error" }).at(-1)).toContain(
      'process == "My \\"App\\""',
    );
  });
});

describe("tailLines", () => {
  it("keeps the newest lines and cuts long ones", () => {
    const result = tailLines(["a", "b", "c", "x".repeat(600)], 2);

    expect(result.omitted).toBe(2);
    expect(result.lines[0]).toBe("c");
    expect(result.lines[1]).toHaveLength(500);
  });
});

describe("crash reports", () => {
  it("parses the exception and the abort message", () => {
    const parsed = parseCrashReport(crashReport({ procPath: `/x/${UDID}/Shop.app/Shop` }));

    expect(parsed.exception).toBe("EXC_CRASH (SIGABRT)");
    expect(parsed.reason).toBe("Fatal error: Unexpectedly found nil");
  });

  it("returns only recent reports for this simulator, newest first", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "synara-crash-"));
    const now = Date.now();
    const write = async (name: string, contents: string, ageMs: number) => {
      const file = path.join(directory!, name);
      await writeFile(file, contents);
      const time = new Date(now - ageMs);
      await utimes(file, time, time);
    };
    await write("Shop-2026-10-14-010101.ips", crashReport({ procPath: `/d/${UDID}/Shop` }), 5_000);
    await write(
      "Shop-2026-10-14-010202.ips",
      crashReport({ procPath: `/d/${UDID}/Shop`, signal: "SIGSEGV" }),
      1_000,
    );
    await write(
      "Shop-2026-10-13-000000.ips",
      crashReport({ procPath: `/d/${UDID}/Shop` }),
      3_600_000,
    );
    await write("Shop-other.ips", crashReport({ procPath: "/d/OTHER-DEVICE/Shop" }), 1_000);
    await write("Mail-2026.ips", crashReport({ procPath: `/d/${UDID}/Mail` }), 1_000);

    const reports = await readCrashReports({
      directory,
      executable: "Shop",
      udid: UDID,
      sinceMs: now - 60_000,
    });

    expect(reports.map((report) => path.basename(report.path))).toEqual([
      "Shop-2026-10-14-010202.ips",
      "Shop-2026-10-14-010101.ips",
    ]);
    expect(reports[0]?.exception).toBe("EXC_CRASH (SIGSEGV)");
  });

  it("reads nothing from a directory that does not exist", async () => {
    await expect(
      readCrashReports({
        directory: "/nonexistent/synara",
        executable: "Shop",
        udid: UDID,
        sinceMs: 0,
      }),
    ).resolves.toEqual([]);
  });
});
