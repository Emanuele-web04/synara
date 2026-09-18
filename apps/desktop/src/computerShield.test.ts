import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerShield } from "./computerShield";

/**
 * The fake helper mirrors the real `--shield` protocol: it logs every stdin
 * command, answers `engage`/`release` with the NDJSON events the real helper
 * emits, and exits on `quit` or stdin EOF. `mode` variations cover the
 * refusal, silent-wedge, and crash shapes.
 */
async function fixture(options: { mode?: "ok" | "refuse" | "silent" | "die" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "synara-shield-test-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "commands.jsonl");
  const binary = join(directory, "helper");
  await writeFile(
    binary,
    `#!${process.execPath}
const fs = require("node:fs");
const mode = ${JSON.stringify(options.mode ?? "ok")};
const log = (event) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + "\\n");
const say = (payload) => process.stdout.write(JSON.stringify(payload) + "\\n");
say({ type: "ready" });
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) return;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const parts = line.split(" ");
    log({ command: parts[0], line });
    if (mode === "die") process.exit(1);
    if (parts[0] === "engage" && mode !== "silent") {
      say({ type: "shield", id: parts[1], state: mode === "refuse" ? "refused" : "engaged", ...(mode === "refuse" ? { reason: "shield-limit" } : {}) });
    } else if (parts[0] === "release") {
      say({ type: "shield", id: parts[1], state: "released", reason: "explicit" });
    } else if (parts[0] === "release-all") {
      say({ type: "shield", id: "none", state: "released", reason: "explicit" });
    } else if (parts[0] === "quit") {
      process.exit(0);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  await chmod(binary, 0o755);
  const shield = new ComputerShield({
    helperPath: binary,
    engageTimeoutMs: 400,
    onError: () => undefined,
  });
  cleanups.push(async () => {
    await shield.dispose().catch(() => undefined);
  });
  const commands = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row));
  // A written command resolves locally; the fake only logs it once the line
  // crosses the pipe, so assertions that count commands poll for delivery.
  const waitForCommands = async (expected: number) => {
    const deadline = Date.now() + 2_000;
    let rows: Array<{ command?: string; line?: string }> = [];
    for (;;) {
      rows = await commands();
      if (rows.length >= expected || Date.now() > deadline) return rows;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  };
  return { shield, commands, waitForCommands, binary };
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const FRAME = { x: 100, y: 50, width: 400, height: 300 };
const TASK = { threadId: "thread-1", turnId: "turn-1", label: "agent" };

describe("ComputerShield", () => {
  it("engages on first use and confirms before resolving", async () => {
    const f = await fixture();
    await f.shield.engage(
      { shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7, label: "Synara activating Calc" },
      TASK,
    );
    const lines = (await f.commands()).map((row) => row.line);
    expect(lines).toEqual(["engage shield-1 100 50 400 300 Synara activating Calc"]);
  });

  it("releases a live shield by id", async () => {
    const f = await fixture();
    await f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK);
    await f.shield.release("shield-1");
    const commands = (await f.waitForCommands(2)).map((row) => row.command);
    expect(commands).toEqual(["engage", "release"]);
  });

  it("refuses an engage the helper declines instead of resolving", async () => {
    const f = await fixture({ mode: "refuse" });
    await expect(
      f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK),
    ).rejects.toThrow("refused");
  });

  it("times out a wedged helper rather than waiting forever", async () => {
    const f = await fixture({ mode: "silent" });
    await expect(
      f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK),
    ).rejects.toThrow("did not confirm");
  });

  it("helper death fails a pending engage and clears the live set", async () => {
    const f = await fixture({ mode: "die" });
    await expect(
      f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK),
    ).rejects.toThrow();
    // The process is gone: a later releaseAll counts nothing because the
    // live set was cleared by the death — the windows died with the helper.
    expect(await f.shield.releaseAll()).toBe(0);
  });

  it("endTask releases the matching task's shields and remembers the end", async () => {
    const f = await fixture();
    await f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK);
    await f.shield.engage(
      { shieldId: "shield-2", frame: FRAME, windowId: 43, pid: 8 },
      { threadId: "other", turnId: "turn-9" },
    );
    await f.shield.endTask({ threadId: "thread-1", turnId: "turn-1" });
    const commands = await f.waitForCommands(3);
    const releases = commands.filter((row) => row.command === "release").map((row) => row.line);
    expect(releases).toEqual(["release shield-1"]);
    // shield-2 belongs to another task and is still live.
    expect(await f.shield.releaseAll()).toBe(1);
  });

  it("a shield confirmed after its task ended is released on arrival", async () => {
    const f = await fixture();
    // Engage without awaiting confirmation so endTask lands first.
    const pending = f.shield.engage(
      { shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 },
      TASK,
    );
    await f.shield.endTask(TASK);
    await pending;
    const commands = await f.waitForCommands(2);
    const releases = commands.filter((row) => row.command === "release").map((row) => row.line);
    expect(releases).toEqual(["release shield-1"]);
  });

  it("releaseAll drops every live shield and reports the count", async () => {
    const f = await fixture();
    await f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK);
    await f.shield.engage(
      { shieldId: "shield-2", frame: FRAME, windowId: 43, pid: 8 },
      { threadId: "other" },
    );
    expect(await f.shield.releaseAll()).toBe(2);
    expect(await f.shield.releaseAll()).toBe(0);
    const commands = await f.waitForCommands(4);
    expect(commands.filter((row) => row.command === "release-all")).toHaveLength(2);
  });

  it("stop terminates the helper so its windows die with it", async () => {
    const f = await fixture();
    await f.shield.engage({ shieldId: "shield-1", frame: FRAME, windowId: 42, pid: 7 }, TASK);
    await f.shield.stop();
    const commands = await f.commands();
    expect(commands.map((row) => row.command)).toEqual(["engage", "quit"]);
    // The next engage lazily respawns a fresh helper.
    await f.shield.engage({ shieldId: "shield-3", frame: FRAME, windowId: 42, pid: 7 }, TASK);
    expect((await f.commands()).map((row) => row.command)).toEqual(["engage", "quit", "engage"]);
  });

  it("a shield engage after dispose is refused", async () => {
    const f = await fixture();
    await f.shield.dispose();
    await expect(
      f.shield.engage({ shieldId: "shield-9", frame: FRAME, windowId: 42, pid: 7 }, TASK),
    ).rejects.toThrow("closed");
  });
});
