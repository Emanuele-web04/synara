import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ComputerUiNode } from "@synara/contracts";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import {
  COMPUTER_RECORDING_FORMAT_VERSION,
  ComputerRecordingError,
  ComputerRecordingStore,
  computerRecordingHistoryLines,
  isProtectedComputerRole,
  parseRecordingText,
  redactComputerRecordingArgs,
  redactComputerRecordingResult,
  sha256Hex,
  uiTreeNodeAtPath,
  uiTreeNodePath,
  uiTreeShapeHash,
  type ComputerRecordingStepInput,
} from "./computerRecording.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "computer-recording-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function stepInput(
  overrides: Partial<ComputerRecordingStepInput> = {},
): ComputerRecordingStepInput {
  return {
    tool: "computer_click",
    actionClass: "pointer",
    threadId: "thread-1",
    approval: { required: true, decision: "granted" },
    resolutions: [],
    args: { x: 10, y: 20 },
    dispatches: [],
    effect: "dispatched-unknown",
    latencyMs: 4,
    ...overrides,
  };
}

function environment() {
  return { platform: "linux", osRelease: "6.1.0", apps: [] };
}

async function startStore(
  dir: string,
  options: ConstructorParameters<typeof ComputerRecordingStore>[0] = {},
) {
  const store = new ComputerRecordingStore({ dir, ...options });
  return store;
}

describe("redactComputerRecordingArgs", () => {
  it("hashes payload fields at redacted fidelity and keeps structure verbatim", () => {
    const redacted = redactComputerRecordingArgs(
      { text: "hunter2 -- a typed secret", x: 10, y: 20, window_id: "w1" },
      { fidelity: "redacted" },
    );
    expect(JSON.stringify(redacted.args)).not.toContain("hunter2");
    expect(redacted.args.x).toBe(10);
    expect(redacted.args.window_id).toBe("w1");
    const text = redacted.args.text as { chars: number; sha256: string };
    expect(text.chars).toBe(25);
    expect(text.sha256).toBe(sha256Hex("hunter2 -- a typed secret"));
    expect(redacted.payload).toEqual({ chars: 25, sha256: sha256Hex("hunter2 -- a typed secret") });
  });

  it("keeps payloads verbatim at full fidelity and marks them captured", () => {
    const redacted = redactComputerRecordingArgs(
      { text: "typed verbatim", key: "Return" },
      { fidelity: "full" },
    );
    expect(redacted.args.text).toBe("typed verbatim");
    expect(redacted.args.key).toBe("Return");
    expect(redacted.payload).toEqual({
      chars: 14,
      sha256: sha256Hex("typed verbatim"),
      captured: true,
    });
  });

  it("hashes the payload even at full fidelity when the target is protected", () => {
    const redacted = redactComputerRecordingArgs(
      { text: "a password", value: "another" },
      { fidelity: "full", protected: true },
    );
    expect(JSON.stringify(redacted.args)).not.toContain("a password");
    expect(JSON.stringify(redacted.args)).not.toContain("another");
    const text = redacted.args.text as { chars: number; sha256: string; protected?: true };
    expect(text.chars).toBe(10);
    expect(text.protected).toBe(true);
    expect(redacted.payload?.protected).toBe(true);
    expect(redacted.payload).not.toHaveProperty("captured");
  });

  it("summarizes sensitive arrays by count and hash at redacted fidelity", () => {
    const redacted = redactComputerRecordingArgs(
      { arguments: ["--password=s3cret", "--user=me"], app: "Terminal" },
      { fidelity: "redacted" },
    );
    expect(JSON.stringify(redacted.args)).not.toContain("s3cret");
    expect(redacted.args.app).toBe("Terminal");
    expect(redacted.args.arguments).toEqual({
      items: 2,
      sha256: sha256Hex("--password=s3cret--user=me"),
    });
  });

  it("keeps a computer_run step list as count and types only", () => {
    const redacted = redactComputerRecordingArgs(
      {
        steps: [
          { type: "click", x: 1, y: 2 },
          { type: "type_text", text: "password" },
        ],
      },
      { fidelity: "full" },
    );
    expect(redacted.args.steps).toEqual({ count: 2, types: ["click", "type_text"] });
    expect(JSON.stringify(redacted.args)).not.toContain("password");
  });

  it("redacts sensitive keys nested inside a target object", () => {
    const redacted = redactComputerRecordingArgs(
      { target: { windowId: "w1", value: "field payload", x: 5 } },
      { fidelity: "redacted" },
    );
    const target = redacted.args.target as Record<string, unknown>;
    expect(target.windowId).toBe("w1");
    expect(JSON.stringify(target)).not.toContain("field payload");
    expect((target.value as { chars: number }).chars).toBe(13);
  });

  it("clamps long non-payload strings rather than storing them whole", () => {
    const longLabel = "l".repeat(400);
    const redacted = redactComputerRecordingArgs({ label: longLabel }, { fidelity: "redacted" });
    expect((redacted.args.label as string).length).toBeLessThan(300);
  });
});

describe("redactComputerRecordingResult", () => {
  it("summarizes a read-back payload without storing it, at any fidelity", () => {
    const summary = redactComputerRecordingResult("clipboard contents with a token");
    expect(summary).toEqual({
      chars: 31,
      sha256: sha256Hex("clipboard contents with a token"),
    });
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(summary).not.toHaveProperty("captured");
  });
});

describe("isProtectedComputerRole", () => {
  it("marks secure and password roles protected, loosely", () => {
    expect(isProtectedComputerRole("AXSecureTextField")).toBe(true);
    expect(isProtectedComputerRole("password")).toBe(true);
    expect(isProtectedComputerRole("AXTextField")).toBe(false);
    expect(isProtectedComputerRole(undefined)).toBe(false);
  });
});

function treeNode(overrides: Partial<ComputerUiNode> = {}): ComputerUiNode {
  return {
    role: "window",
    label: null,
    value: null,
    description: null,
    frame: { x: 0, y: 0, width: 100, height: 100 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: [],
    ...overrides,
  };
}

describe("uiTree path helpers", () => {
  const child = treeNode({ role: "button", label: "OK", windowId: "w1" });
  const root = treeNode({
    role: "desktop",
    children: [
      treeNode({ role: "window", windowId: "w0" }),
      treeNode({ role: "window", windowId: "w1", children: [child] }),
    ],
  });

  it("computes the child-index path and resolves it back", () => {
    const path = uiTreeNodePath(root, child);
    expect(path).toEqual([1, 0]);
    expect(uiTreeNodeAtPath(root, path!)).toBe(child);
    expect(uiTreeNodeAtPath(root, [9])).toBeUndefined();
  });

  it("prefers the backend-provided nodePath when one rides the node", () => {
    const marked = treeNode({ role: "field", nodePath: [4, 2] });
    expect(uiTreeNodePath(root, marked)).toEqual([4, 2]);
  });

  it("hashes tree shape without labels, values, or window ids", () => {
    const hash = uiTreeShapeHash(root);
    expect(hash.startsWith("sha256:")).toBe(true);
    const renamed = treeNode({
      role: "desktop",
      children: [
        treeNode({ role: "window", windowId: "w0", label: "different title" }),
        treeNode({ role: "window", windowId: "w1", children: [treeNode({ role: "button" })] }),
      ],
    });
    // Same roles in the same structure: the shape hash does not move.
    expect(uiTreeShapeHash(renamed)).toBe(hash);
    const reordered = treeNode({
      role: "desktop",
      children: [
        treeNode({ role: "window", windowId: "w1", children: [treeNode({ role: "button" })] }),
        treeNode({ role: "window", windowId: "w0" }),
      ],
    });
    expect(uiTreeShapeHash(reordered)).not.toBe(hash);
  });
});

describe("ComputerRecordingStore", () => {
  it("writes header, step, and end lines in order", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep("thread-1", stepInput({ tool: "computer_click" }));
    store.appendStep("thread-1", stepInput({ tool: "computer_type_text", actionClass: "text" }));
    const closed = await store.stop(summary.recordingId, "stopped");
    expect(closed?.closed).toBe(true);
    expect(closed?.reason).toBe("stopped");
    expect(closed?.steps).toBe(2);

    const contents = await readFile(join(dir, `${summary.recordingId}.jsonl`), "utf8");
    const lines = contents.trim().split("\n");
    expect(lines).toHaveLength(4);
    const header = JSON.parse(lines[0]!);
    expect(header.kind).toBe("header");
    expect(header.formatVersion).toBe(COMPUTER_RECORDING_FORMAT_VERSION);
    expect(header.recordingId).toBe(summary.recordingId);
    expect(header.fidelity).toBe("redacted");
    const first = JSON.parse(lines[1]!);
    expect(first.kind).toBe("step");
    expect(first.seq).toBe(1);
    const second = JSON.parse(lines[2]!);
    expect(second.seq).toBe(2);
    expect(second.tool).toBe("computer_type_text");
    const end = JSON.parse(lines[3]!);
    expect(end.kind).toBe("end");
    expect(end.reason).toBe("stopped");
    expect(end.steps).toBe(2);
    const fileStat = await stat(join(dir, `${summary.recordingId}.jsonl`));
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  });

  it("refuses a second open session on the same thread", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    await store.start({ threadId: "thread-1", fidelity: "redacted", environment: environment() });
    await expect(
      store.start({ threadId: "thread-1", fidelity: "full", environment: environment() }),
    ).rejects.toBeInstanceOf(ComputerRecordingError);
    // A second thread opens its own session fine.
    const other = await store.start({
      threadId: "thread-2",
      fidelity: "full",
      environment: environment(),
    });
    expect(other.fidelity).toBe("full");
    await store.stopAll("disposed");
  });

  it("drops steps appended after the step cap closes the session", async () => {
    const dir = await tempDir();
    const store = await startStore(dir, { maxSteps: 2 });
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep("thread-1", stepInput());
    store.appendStep("thread-1", stepInput());
    // The cap already closed the session: this step is dropped, not written.
    store.appendStep("thread-1", stepInput());
    await store.flush();
    expect(store.activeForThread("thread-1")).toBeUndefined();
    const parsed = parseRecordingText(
      await readFile(join(dir, `${summary.recordingId}.jsonl`), "utf8"),
    );
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.end?.reason).toBe("step-cap");
    expect(parsed.end?.steps).toBe(2);
  });

  it("closes on the byte cap and records the reason", async () => {
    const dir = await tempDir();
    const store = await startStore(dir, { maxBytes: 400 });
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    for (let index = 0; index < 50; index += 1) {
      store.appendStep("thread-1", stepInput({ args: { index, filler: "x".repeat(200) } }));
    }
    await store.flush();
    const parsed = parseRecordingText(
      await readFile(join(dir, `${summary.recordingId}.jsonl`), "utf8"),
    );
    expect(parsed.end?.reason).toBe("byte-cap");
    expect(parsed.steps.length).toBeLessThan(50);
  });

  it("lists open sessions first, then newest closed", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const first = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    await store.stop(first.recordingId, "stopped");
    const open = await store.start({
      threadId: "thread-1",
      fidelity: "full",
      environment: environment(),
    });
    const list = await store.list();
    expect(list[0]?.recordingId).toBe(open.recordingId);
    expect(list[0]?.closed).toBe(false);
    expect(list[1]?.recordingId).toBe(first.recordingId);
    expect(list[1]?.closed).toBe(true);
    await store.stopAll("disposed");
  });

  it("reads back a full document and refuses an unknown id", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep("thread-1", stepInput());
    await store.stop(summary.recordingId, "stopped");
    const document = await store.read(summary.recordingId);
    expect(document.header.threadId).toBe("thread-1");
    expect(document.steps).toHaveLength(1);
    expect(document.end?.reason).toBe("stopped");
    await expect(store.read("crec-missing")).rejects.toBeInstanceOf(ComputerRecordingError);
    // A path-shaped id can never escape the recording directory.
    await expect(store.read("../computer-control")).rejects.toBeInstanceOf(ComputerRecordingError);
  });

  it("exports the raw NDJSON and deletes the file", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep("thread-1", stepInput());
    await store.stop(summary.recordingId, "stopped");
    const exported = await store.export(summary.recordingId);
    expect(exported).toContain('"kind":"header"');
    expect(exported).toContain('"kind":"step"');
    expect(await store.delete(summary.recordingId)).toBe(true);
    expect(await readdir(dir)).toHaveLength(0);
  });

  it("sweeps aged closed sessions but never an open one", async () => {
    const dir = await tempDir();
    const store = await startStore(dir, { maxAgeMs: 1_000 });
    const old = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    await store.stop(old.recordingId, "stopped");
    // The closed file is backdated past the age cap — file mtimes are the
    // clock the sweep trusts, not the session's injected one.
    const aged = new Date(Date.now() - 60_000);
    await utimes(join(dir, `${old.recordingId}.jsonl`), aged, aged);
    const open = await store.start({
      threadId: "thread-2",
      fidelity: "redacted",
      environment: environment(),
    });
    const fresh = await store.start({
      threadId: "thread-3",
      fidelity: "redacted",
      environment: environment(),
    });
    await store.flush();
    const names = (await readdir(dir)).toSorted();
    expect(names).not.toContain(`${old.recordingId}.jsonl`);
    expect(names).toContain(`${open.recordingId}.jsonl`);
    expect(names).toContain(`${fresh.recordingId}.jsonl`);
    await store.stopAll("disposed");
  });

  it("sweeps oldest-first past the session count cap", async () => {
    const dir = await tempDir();
    const store = await startStore(dir, { maxSessions: 2 });
    const kept: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const summary = await store.start({
        threadId: `thread-${index}`,
        fidelity: "redacted",
        environment: environment(),
      });
      kept.push(summary.recordingId);
      await store.stop(summary.recordingId, "stopped");
    }
    const names = await readdir(dir);
    // The two oldest were swept; the two newest remain.
    expect(names).toHaveLength(2);
    expect(names).toContain(`${kept[3]}.jsonl`);
    expect(names).toContain(`${kept[2]}.jsonl`);
    await store.stopAll("disposed");
  });

  it("tolerates a malformed trailing line when parsing", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep("thread-1", stepInput());
    await store.stop(summary.recordingId, "stopped");
    const filePath = join(dir, `${summary.recordingId}.jsonl`);
    await writeFile(filePath, `${await readFile(filePath, "utf8")}{"kind":"step","seq":`, "utf8");
    const document = await store.read(summary.recordingId);
    expect(document.steps).toHaveLength(1);
    expect(document.end?.reason).toBe("stopped");
  });

  it("is disabled without a directory and reports it on start", async () => {
    const store = new ComputerRecordingStore();
    expect(store.enabled).toBe(false);
    await expect(
      store.start({ threadId: "t", fidelity: "redacted", environment: environment() }),
    ).rejects.toBeInstanceOf(ComputerRecordingError);
  });

  it("swallows append failures instead of failing the recorded action", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    // The file vanished mid-session: the append must still not throw, and the
    // close must still answer — evidence collection never fails the action.
    await rm(join(dir, `${summary.recordingId}.jsonl`), { force: true });
    expect(() => store.appendStep("thread-1", stepInput())).not.toThrow();
    await expect(store.stop(summary.recordingId, "stopped")).resolves.toBeDefined();
    await store.stopAll("disposed");
  });

  it("reports a directory that can never be created on start", async () => {
    const dir = await tempDir();
    // A file sits where the recording directory would go — mkdir cannot help.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const store = new ComputerRecordingStore({ dir: join(blocker, "recordings") });
    await expect(
      store.start({ threadId: "t", fidelity: "redacted", environment: environment() }),
    ).rejects.toThrow();
  });
});

describe("computerRecordingHistoryLines", () => {
  it("renders one plain-English line per step without payload text", async () => {
    const dir = await tempDir();
    const store = await startStore(dir);
    const summary = await store.start({
      threadId: "thread-1",
      fidelity: "redacted",
      environment: environment(),
    });
    store.appendStep(
      "thread-1",
      stepInput({
        tool: "computer_type_text",
        actionClass: "text",
        args: { text: { chars: 8, sha256: "sha256:abc" } },
        declaredTarget: { label: "Search", role: "AXTextField" },
        resolutions: [{ via: "semantic", windowId: "w1", app: "Finder", role: "AXTextField" }],
        payload: { chars: 8, sha256: "sha256:abc" },
      }),
    );
    await store.stop(summary.recordingId, "stopped");
    const document = await store.read(summary.recordingId);
    const lines = computerRecordingHistoryLines(document);
    expect(lines[0]).toContain("recording");
    expect(lines[0]).toContain("thread-1");
    expect(lines[1]).toContain("#1");
    expect(lines[1]).toContain("computer_type_text");
    expect(lines[1]).toContain('"Search"');
    expect(lines[1]).toContain("Finder");
    expect(lines[1]).toContain("payload 8 chars hashed");
    expect(lines.at(-1)).toContain("stopped");
    expect(lines.join("\n")).not.toContain("hunter2");
    await store.stopAll("disposed");
  });
});

describe("ComputerManager recording seam", () => {
  it("a thread whose control is off records nothing", async () => {
    const dir = await tempDir();
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, recordingDir: dir, actionSettleMs: 0 });
    const threadId = "disabled-thread";
    // The session opens before control is revoked — it must close with the
    // control and record no further steps.
    const session = await manager.startComputerRecording({ threadId });
    await manager.setControlEnabled(threadId, false);
    manager.recordComputerStep(threadId, stepInput({ threadId }));
    await manager.dispose();
    const document = await manager
      .readComputerRecording(session.recordingId)
      .catch(() => undefined);
    // The file exists with its header and end — the control-revoked close —
    // and no step line ever landed.
    expect(document?.steps).toHaveLength(0);
    expect(document?.end?.reason).toBe("control-revoked");
  });

  it("recordingCaptureFor is absent without an open session and present with one", async () => {
    const dir = await tempDir();
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, recordingDir: dir, actionSettleMs: 0 });
    expect(manager.recordingCaptureFor("thread-1")).toBeUndefined();
    await manager.startComputerRecording({ threadId: "thread-1", fidelity: "full" });
    const capture = manager.recordingCaptureFor("thread-1");
    expect(capture).toBeDefined();
    expect(manager.recordingFidelityFor("thread-1")).toBe("full");
    await manager.stopComputerRecordingForThread("thread-1");
    expect(manager.recordingCaptureFor("thread-1")).toBeUndefined();
    await manager.dispose();
  });

  it("recording is disabled without a directory and the tools path reports it", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    expect(manager.recordingEnabled).toBe(false);
    await expect(manager.startComputerRecording({ threadId: "t" })).rejects.toBeInstanceOf(
      ComputerRecordingError,
    );
    await manager.dispose();
  });
});
