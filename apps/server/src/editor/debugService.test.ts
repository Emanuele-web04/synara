import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { EditorDebugService } from "./debugService";
import { ensureDebugAdapter } from "./debugAdapterInstaller";
import type { EditorDebugEvent, EditorDebugStartInput } from "@synara/contracts";

const owned: { service: EditorDebugService; directory: string }[] = [];
afterEach(async () => {
  for (const entry of owned.splice(0)) {
    try {
      await entry.service.dispose();
    } finally {
      await rm(entry.directory, { recursive: true, force: true });
    }
  }
});
async function setup(adapter?: (signal: AbortSignal) => Promise<string>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "synara-dap-"));
  const cwd = path.join(directory, "project");
  await mkdir(cwd);
  const service = new EditorDebugService(path.join(directory, "state"), adapter);
  owned.push({ service, directory });
  const input: EditorDebugStartInput = {
    cwd,
    request: "launch",
    program: "index.js",
    args: [],
    port: 9229,
    stopOnEntry: false,
    breakpoints: [],
  };
  return { service, directory, cwd, input };
}

it("cancels an outstanding adapter installation without spawning a debuggee", async () => {
  let complete!: (entry: string) => void;
  const loading = new Promise<string>((resolve) => {
    complete = resolve;
  });
  let entered!: () => void;
  const installing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { service, cwd, input } = await setup(() => {
    entered();
    return loading;
  });
  await writeFile(path.join(cwd, "index.js"), "console.log('must not execute');");
  const controller = new AbortController();
  const pending = service.start("owner", input, controller.signal);
  await installing;
  controller.abort();
  await expect(pending).rejects.toThrow();
  complete("not-an-executable");
  await service.dispose();
});

// Opt-in downloads the checksum-pinned upstream adapter. A preinstalled path can
// be supplied by an offline verification workspace; neither mode uses a fake DAP peer.
const live =
  process.env.SYNARA_TEST_JS_DEBUG === "1" || Boolean(process.env.SYNARA_TEST_JS_DEBUG_PATH);
describe.runIf(live)("actual Microsoft JavaScript debugger", () => {
  async function actual() {
    const fixture = await setup(
      async (signal) =>
        process.env.SYNARA_TEST_JS_DEBUG_PATH ??
        ensureDebugAdapter(path.join(os.tmpdir(), "synara-js-debug-test-cache"), signal),
    );
    return fixture;
  }
  async function wait(
    service: EditorDebugService,
    sessionId: string,
    after: number,
    event: string,
  ): Promise<EditorDebugEvent> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const snapshot = service.poll("owner", sessionId, after);
      const found = snapshot.events.find((item) => item.event === event);
      if (found) return found;
      const error = snapshot.events.find((item) => item.event === "error");
      if (error) throw new Error(error.text);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`The real adapter did not emit ${event}.`);
  }
  it("launches, hits a breakpoint, steps, evaluates variables and watches, pauses and stops its process", async () => {
    const { service, cwd, input } = await actual();
    const source =
      "function increment(value) {\n  return value + 1;\n}\nconst answer = increment(41);\nconsole.log(answer);\nsetInterval(() => {}, 100);\n";
    await writeFile(path.join(cwd, "index.js"), source);
    const { sessionId } = await service.start("owner", {
      ...input,
      breakpoints: [{ relativePath: "index.js", line: 4 }],
    });
    expect(() => service.poll("another-owner", sessionId, 0)).toThrow("connection");
    const stopped = await wait(service, sessionId, 0, "stopped");
    const target = { sessionId, connectionId: stopped.connectionId };
    const threadId =
      stopped.threadId ??
      (await service.action("owner", { ...target, action: "threads" })).threads![0]!.id;
    let sequence = service.poll("owner", sessionId, 0).sequence;
    await service.action("owner", { ...target, action: "stepIn", threadId });
    await wait(service, sessionId, sequence, "stopped");
    let frames = (await service.action("owner", { ...target, action: "stackTrace", threadId }))
      .frames!;
    expect(frames[0]).toMatchObject({ relativePath: "index.js", line: 2 });
    const frameId = frames[0]!.id;
    const scopes = (await service.action("owner", { ...target, action: "scopes", frameId }))
      .scopes!;
    const variables = (
      await service.action("owner", {
        ...target,
        action: "variables",
        variablesReference: scopes[0]!.variablesReference,
      })
    ).variables!;
    expect(variables).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "value", value: "41" })]),
    );
    expect(
      (
        await service.action("owner", {
          ...target,
          action: "evaluate",
          frameId,
          expression: "value + 1",
          context: "watch",
        })
      ).evaluation?.value,
    ).toBe("42");
    sequence = service.poll("owner", sessionId, 0).sequence;
    await service.action("owner", { ...target, action: "stepOut", threadId });
    await wait(service, sessionId, sequence, "stopped");
    sequence = service.poll("owner", sessionId, 0).sequence;
    await service.action("owner", { ...target, action: "next", threadId });
    await wait(service, sessionId, sequence, "stopped");
    await service.action("owner", { ...target, action: "continue", threadId });
    await wait(service, sessionId, sequence, "output");
    sequence = service.poll("owner", sessionId, 0).sequence;
    await service.action("owner", { ...target, action: "pause", threadId });
    await wait(service, sessionId, sequence, "stopped");
    frames = (await service.action("owner", { ...target, action: "stackTrace", threadId })).frames!;
    const pid = Number(
      (
        await service.action("owner", {
          ...target,
          action: "evaluate",
          frameId: frames[0]!.id,
          expression: "process.pid",
          context: "repl",
        })
      ).evaluation?.value,
    );
    expect(pid).toBeGreaterThan(0);
    await service.action("owner", { sessionId, action: "disconnect" });
    expect(service.poll("owner", sessionId, 0).terminated).toBe(true);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
    expect(await readFile(path.join(cwd, "index.js"), "utf8")).toBe(source);
  }, 40_000);

  it("attaches to a separately owned Node process and leaves that process alive on detach", async () => {
    const { service, cwd, input } = await actual();
    await writeFile(path.join(cwd, "index.js"), "setInterval(() => {}, 100);\n");
    const child = spawn(process.execPath, ["--inspect=127.0.0.1:0", "index.js"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Inspector port was not announced.")),
          8_000,
        );
        let text = "";
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.stderr.on("data", (chunk: Buffer) => {
          text += chunk.toString();
          const match = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(text);
          if (match) {
            clearTimeout(timer);
            resolve(Number(match[1]));
          }
        });
      });
      const { sessionId } = await service.start("owner", {
        ...input,
        request: "attach",
        program: "",
        port,
      });
      await expect
        .poll(() =>
          service
            .poll("owner", sessionId, 0)
            .connections.some((item) => item.id !== "root" && item.ready),
        )
        .toBe(true);
      await service.action("owner", { sessionId, action: "disconnect" });
      expect(child.pid).toBeGreaterThan(0);
      expect(child.exitCode).toBeNull();
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve();
        else child.once("exit", () => resolve());
      });
    }
  }, 30_000);
});
