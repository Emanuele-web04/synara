import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { PassThrough } from "node:stream";
import type * as ChildProcess from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAppSnapHelperMessage } from "./appSnapManager";
import type { DesktopNotchIslandSnapshot } from "@synara/contracts";

import {
  createNotchIslandController,
  encodeNotchIslandLabelsCommand,
  NOTCH_ISLAND_LABEL_KEYS,
  NotchIslandHost,
  type NotchIslandLabels,
  parseNotchIslandPreference,
  readNotchIslandPreference,
  writeNotchIslandPreference,
} from "./notchIsland";
import {
  EMPTY_NOTCH_ISLAND_SNAPSHOT,
  encodeNotchIslandIconsCommand,
  encodeNotchIslandSnapshotCommand,
} from "./notchIslandSnapshot";

/** A stand-in for the `--island` helper: NDJSON out, JSON lines in. */
class FakeHelper extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly written: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signalCode = signal;
    this.emit("exit", null, signal);
    this.emit("close", null, signal);
    return true;
  });

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.written.push(chunk.toString("utf8")));
  }

  emitLine(payload: unknown): void {
    this.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  crash(code = 1): void {
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

const LABELS = Object.fromEntries(
  NOTCH_ISLAND_LABEL_KEYS.map((key) => [key, `label ${key}`]),
) as NotchIslandLabels;

const SNAPSHOT: DesktopNotchIslandSnapshot = {
  needsYou: 1,
  working: 2,
  done: 0,
  failed: 0,
  rows: [
    { threadId: "t-1", title: "Ship it", project: "synara", provider: "codex", state: "approval" },
  ],
  icons: { codex: "<svg>codex</svg>" },
};
const flushLines = () => new Promise((resolve) => setImmediate(resolve));

function makeHost() {
  const helpers: FakeHelper[] = [];
  const spawnArgs: unknown[][] = [];
  const openedThreads: string[] = [];
  const errors: string[] = [];
  let openedApp = 0;
  const spawn = ((...args: unknown[]) => {
    spawnArgs.push(args);
    const helper = new FakeHelper();
    helpers.push(helper);
    return helper;
  }) as unknown as typeof ChildProcess.spawn;
  const host = new NotchIslandHost({
    helperPath: "/fixture/appsnap",
    labels: () => LABELS,
    onOpenThread: (threadId) => openedThreads.push(threadId),
    onOpenApp: () => {
      openedApp += 1;
    },
    onError: (message) => errors.push(message),
    spawn,
  });
  return { host, helpers, spawnArgs, openedThreads, errors, openedApp: () => openedApp };
}

describe("notch island preference", () => {
  let directory: string;

  beforeEach(() => {
    directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "synara-notch-island-"));
  });

  afterEach(() => {
    FS.rmSync(directory, { recursive: true, force: true });
  });

  it("defaults to on and round-trips the saved choice", () => {
    const file = Path.join(directory, "nested", "notch-island.json");
    expect(readNotchIslandPreference(file)).toEqual({ version: 1, enabled: true });
    writeNotchIslandPreference(file, { version: 1, enabled: false });
    expect(readNotchIslandPreference(file)).toEqual({ version: 1, enabled: false });
  });

  it("falls back to the default for malformed or foreign files", () => {
    const file = Path.join(directory, "notch-island.json");
    FS.writeFileSync(file, "{not json");
    expect(readNotchIslandPreference(file)).toEqual({ version: 1, enabled: true });
    expect(parseNotchIslandPreference({ version: 2, enabled: false })).toBeNull();
    expect(parseNotchIslandPreference({ version: 1, enabled: "no" })).toBeNull();
  });
});

describe("createNotchIslandController", () => {
  function makeController(supported: boolean, saved = { version: 1 as const, enabled: true }) {
    const host = {
      setWanted: vi.fn(),
      setSnapshot: vi.fn(),
      dispose: vi.fn(),
    };
    const load = vi.fn(() => saved);
    const save = vi.fn();
    const onError = vi.fn();
    const controller = createNotchIslandController({ supported, host, load, save, onError });
    return { controller, host, load, save, onError };
  }

  it("never reads, writes, or starts anything where it is unsupported", () => {
    const { controller, host, load, save } = makeController(false);
    expect(load).not.toHaveBeenCalled();
    expect(host.setWanted).toHaveBeenLastCalledWith(false);
    expect(controller.setEnabled(true)).toEqual({
      supported: false,
      enabled: false,
      entitled: false,
    });
    expect(controller.setEntitled(true)).toEqual({
      supported: false,
      enabled: false,
      entitled: false,
    });
    expect(save).not.toHaveBeenCalled();
    expect(host.setWanted).not.toHaveBeenCalledWith(true);
  });

  it("forwards snapshots only where the island is supported", () => {
    const unsupported = makeController(false);
    unsupported.controller.setSnapshot(SNAPSHOT);
    expect(unsupported.host.setSnapshot).not.toHaveBeenCalled();

    const supported = makeController(true);
    supported.controller.setSnapshot(SNAPSHOT);
    expect(supported.host.setSnapshot).toHaveBeenCalledWith(SNAPSHOT);
  });

  it("stays off until Synara Alto access is reported, and stops when it ends", () => {
    const { controller, host } = makeController(true);
    expect(host.setWanted).toHaveBeenLastCalledWith(false);
    expect(controller.getState()).toEqual({ supported: true, enabled: true, entitled: false });

    expect(controller.setEntitled(true)).toEqual({
      supported: true,
      enabled: true,
      entitled: true,
    });
    expect(host.setWanted).toHaveBeenLastCalledWith(true);

    controller.setEntitled(false);
    expect(host.setWanted).toHaveBeenLastCalledWith(false);
  });

  it("starts the saved choice and persists changes", () => {
    const { controller, host, save } = makeController(true);
    controller.setEntitled(true);
    expect(host.setWanted).toHaveBeenLastCalledWith(true);
    expect(controller.getState()).toEqual({ supported: true, enabled: true, entitled: true });

    expect(controller.setEnabled(false)).toEqual({
      supported: true,
      enabled: false,
      entitled: true,
    });
    expect(save).toHaveBeenCalledWith({ version: 1, enabled: false });
    expect(host.setWanted).toHaveBeenLastCalledWith(false);

    controller.setEnabled(false);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("keeps following the new value when saving fails", () => {
    const { controller, host, save, onError } = makeController(true);
    save.mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(controller.setEnabled(false)).toEqual({
      supported: true,
      enabled: false,
      entitled: false,
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(host.setWanted).toHaveBeenLastCalledWith(false);
  });
});

describe("NotchIslandHost", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawns the island mode and sends the labels first", async () => {
    const { host, helpers, spawnArgs } = makeHost();
    host.setWanted(true);
    await flushLines();

    expect(spawnArgs).toEqual([
      ["/fixture/appsnap", ["--island"], { stdio: ["pipe", "pipe", "pipe"] }],
    ]);
    expect(helpers[0]?.written.join("")).toBe(
      encodeNotchIslandLabelsCommand(LABELS) +
        encodeNotchIslandSnapshotCommand(EMPTY_NOTCH_ISLAND_SNAPSHOT),
    );
    expect(host.isRunning).toBe(true);
  });

  it("forwards clicks and ignores malformed lines", async () => {
    const { host, helpers, openedThreads, openedApp } = makeHost();
    host.setWanted(true);
    const helper = helpers[0]!;
    helper.emitLine({ type: "ready" });
    helper.emitLine({ type: "island-open-thread", threadId: "thread-1" });
    helper.emitLine({ type: "island-open-thread", threadId: "" });
    helper.emitLine({ type: "island-open-app" });
    helper.stdout.write("not json\n");
    await flushLines();

    expect(host.isReady).toBe(true);
    expect(openedThreads).toEqual(["thread-1"]);
    expect(openedApp()).toBe(1);
  });

  it("respawns an exited helper with backoff and replays the labels", async () => {
    const { host, helpers } = makeHost();
    host.setWanted(true);
    helpers[0]!.crash();
    expect(host.isRunning).toBe(false);

    vi.advanceTimersByTime(999);
    expect(helpers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(helpers).toHaveLength(2);
    await flushLines();
    expect(helpers[1]?.written.join("")).toBe(
      encodeNotchIslandLabelsCommand(LABELS) +
        encodeNotchIslandSnapshotCommand(EMPTY_NOTCH_ISLAND_SNAPSHOT),
    );

    helpers[1]!.crash();
    vi.advanceTimersByTime(1_999);
    expect(helpers).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(helpers).toHaveLength(3);
  });

  it("replaces a helper that never reports ready", () => {
    const { host, helpers, errors } = makeHost();
    host.setWanted(true);
    vi.advanceTimersByTime(10_000);

    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    expect(errors.at(-1)).toMatch(/did not report ready/);
    vi.advanceTimersByTime(1_000);
    expect(helpers).toHaveLength(2);
  });

  it("stops the helper when no longer wanted and does not respawn", async () => {
    const { host, helpers } = makeHost();
    host.setWanted(true);
    helpers[0]!.emitLine({ type: "ready" });
    await flushLines();

    host.setWanted(false);
    expect(helpers[0]!.stdin.writableEnded).toBe(true);
    expect(helpers[0]!.kill).toHaveBeenCalledWith("SIGTERM");
    vi.advanceTimersByTime(60_000);
    expect(helpers).toHaveLength(1);
    expect(host.isRunning).toBe(false);
  });

  it("sends each provider glyph once and replays everything after a respawn", async () => {
    const { host, helpers } = makeHost();
    host.setWanted(true);
    const first = helpers[0]!;
    await flushLines();
    first.written.length = 0;

    host.setSnapshot(SNAPSHOT);
    host.setSnapshot({ ...SNAPSHOT, working: 3 });
    await flushLines();
    expect(first.written.join("")).toBe(
      encodeNotchIslandIconsCommand(SNAPSHOT.icons) +
        encodeNotchIslandSnapshotCommand(SNAPSHOT) +
        encodeNotchIslandSnapshotCommand({ ...SNAPSHOT, working: 3 }),
    );

    first.crash();
    vi.advanceTimersByTime(1_000);
    await flushLines();
    expect(helpers[1]?.written.join("")).toBe(
      encodeNotchIslandLabelsCommand(LABELS) +
        encodeNotchIslandIconsCommand(SNAPSHOT.icons) +
        encodeNotchIslandSnapshotCommand({ ...SNAPSHOT, working: 3 }),
    );
  });

  it("ignores every request after dispose", () => {
    const { host, helpers } = makeHost();
    host.setWanted(true);
    host.dispose();
    host.setWanted(true);
    vi.advanceTimersByTime(60_000);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]!.kill).toHaveBeenCalled();
  });
});

describe("island helper messages", () => {
  it("parses the island events and rejects malformed ones", () => {
    expect(
      parseAppSnapHelperMessage(
        '{"type":"island-placement","kind":"notch","notchWidth":185,"notchHeight":32}',
      ),
    ).toEqual({ type: "island-placement", kind: "notch", notchWidth: 185, notchHeight: 32 });
    expect(
      parseAppSnapHelperMessage('{"type":"island-placement","kind":"menu","notchWidth":1}'),
    ).toBeNull();
    expect(parseAppSnapHelperMessage('{"type":"island-open-thread","threadId":"t-1"}')).toEqual({
      type: "island-open-thread",
      threadId: "t-1",
    });
    expect(
      parseAppSnapHelperMessage(
        JSON.stringify({ type: "island-open-thread", threadId: "x".repeat(257) }),
      ),
    ).toBeNull();
    expect(parseAppSnapHelperMessage('{"type":"island-open-app"}')).toEqual({
      type: "island-open-app",
    });
  });

  it("clamps label text sent to the helper", () => {
    const line = encodeNotchIslandLabelsCommand({ ...LABELS, empty: ` ${"a".repeat(200)} ` });
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line) as Record<string, string>;
    expect(parsed.empty).toBe("a".repeat(80));
    expect(parsed.review).toBe("label review");
    expect(Object.keys(parsed)).toHaveLength(NOTCH_ISLAND_LABEL_KEYS.length + 1);
  });
});
