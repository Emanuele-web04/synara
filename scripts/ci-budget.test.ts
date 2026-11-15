import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./ci-budget.ts", import.meta.url));
const budget = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe.skipIf(process.platform === "win32")("CI budget", () => {
  it("passes a command that finishes within its budget and keeps its exit code", () => {
    expect(budget(["run", "5", "--", "true"]).status).toBe(0);
    expect(budget(["run", "5", "--", "false"]).status).toBe(1);
  });

  it("stops and fails a command that exceeds its budget", () => {
    const started = Date.now();
    const result = budget(["run", "1", "--", "sleep", "10"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("::error title=Over budget::");
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("fails a job phase that ran longer than its budget since the first step", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(budget(["since", "30", "setup"], { CI_BUDGET_START: String(now - 5) }).status).toBe(0);
    const late = budget(["since", "30", "setup"], { CI_BUDGET_START: String(now - 31) });
    expect(late.status).toBe(1);
    expect(late.stderr).toContain("setup exceeded its 30 s budget");
    expect(budget(["since", "30", "setup"], { CI_BUDGET_START: "" }).status).toBe(1);
  });

  it("rejects malformed budgets", () => {
    expect(budget(["run", "0", "--", "true"]).status).toBe(1);
    expect(budget(["run", "abc", "--", "true"]).status).toBe(1);
  });
});
