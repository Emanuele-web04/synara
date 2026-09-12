import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPermissionSetupState } from "@synara/contracts";
const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));
import { NativePermissionGuide } from "./nativePermissionGuide";

function child() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}
const state: DesktopPermissionSetupState = {
  feature: "computer",
  phase: "waiting",
  required: ["accessibility", "screenRecording"],
  grants: { accessibility: "denied", screenRecording: "denied" },
  current: "accessibility",
  appName: "Synara Cua",
  appPath: "/Applications/Synara Cua.app",
  message: null,
};
afterEach(() => {
  spawn.mockReset();
  vi.useRealTimers();
});

describe("native permission guide lifetime", () => {
  it("reuses one presentation child, emits only changed state and cannot synthesize a grant", async () => {
    const process = child();
    spawn.mockReturnValue(process);
    const onAction = vi.fn();
    const guide = new NativePermissionGuide({
      helperPath: "/helper",
      appPath: state.appPath!,
      appName: state.appName,
      onAction,
      onError: vi.fn(),
    });
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk.toString();
    });
    guide.show(state);
    guide.show(state);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      "/helper",
      ["--permission-guide", "--app-path", state.appPath, "--app-name", state.appName],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(input.trim().split("\n")).toHaveLength(1);
    process.stdout.write('{"action":"grant"}\n');
    expect(onAction).not.toHaveBeenCalled();
    process.stdout.write('{"action":"re');
    process.stdout.write('veal"}\n');
    expect(onAction).toHaveBeenCalledExactlyOnceWith("reveal");
    const closing = guide.close();
    process.emit("close", 0);
    await closing;
    expect(input).toContain("close\n");
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it("does not start a replacement until the old UI helper has closed", async () => {
    vi.useFakeTimers();
    const first = child();
    const second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const guide = new NativePermissionGuide({
      helperPath: "/helper",
      appPath: state.appPath!,
      appName: state.appName,
      onAction: vi.fn(),
      onError: vi.fn(),
    });
    guide.show(state);
    const closing = guide.close();
    guide.show(state);
    expect(spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(first.kill).toHaveBeenCalledWith("SIGKILL");
    first.emit("close", 0);
    await closing;
    guide.show(state);
    expect(spawn).toHaveBeenCalledTimes(2);
    const next = guide.close();
    second.emit("close", 0);
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows another setup after a timed-out guide eventually closes", async () => {
    vi.useFakeTimers();
    const first = child();
    const second = child();
    spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const guide = new NativePermissionGuide({
      helperPath: "/helper",
      appPath: state.appPath!,
      appName: state.appName,
      onAction: vi.fn(),
      onError: vi.fn(),
    });
    guide.show(state);
    const closing = expect(guide.close()).rejects.toThrow("did not close");
    await vi.advanceTimersByTimeAsync(2_500);
    await closing;
    guide.show(state);
    expect(spawn).toHaveBeenCalledTimes(1);
    first.emit("close", 0);
    guide.show(state);
    expect(spawn).toHaveBeenCalledTimes(2);
    const next = guide.close();
    second.emit("close", 0);
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });
});
