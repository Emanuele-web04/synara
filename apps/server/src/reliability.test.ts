import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReliabilityCode } from "@synara/contracts";
import { reportReliabilityIssue } from "./reliability";

const connected = Object.getOwnPropertyDescriptor(process, "connected");
const send = Object.getOwnPropertyDescriptor(process, "send");
afterEach(() => {
  for (const [key, descriptor] of [
    ["connected", connected],
    ["send", send],
  ] as const) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
});

function ipc(isConnected: boolean, sendMessage: unknown): void {
  Object.defineProperty(process, "connected", { configurable: true, value: isConnected });
  Object.defineProperty(process, "send", { configurable: true, value: sendMessage });
}

describe("server reliability IPC", () => {
  it("bounds socket-error bursts without suppressing other failure categories", () => {
    const sendMessage = vi.fn();
    ipc(true, sendMessage);
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    try {
      for (let count = 0; count < 100; count++) {
        reportReliabilityIssue("remote.ingress_socket_error");
        reportReliabilityIssue("remote.tunnel_socket_error");
      }
      reportReliabilityIssue("recovery.crash_resume_failed");
      reportReliabilityIssue("recovery.crash_resume_failed");
      expect(sendMessage).toHaveBeenCalledTimes(4);
      now = 29_999;
      reportReliabilityIssue("remote.ingress_socket_error");
      expect(sendMessage).toHaveBeenCalledTimes(4);
      now = 30_000;
      reportReliabilityIssue("remote.ingress_socket_error");
      reportReliabilityIssue("remote.tunnel_socket_error");
      expect(sendMessage.mock.calls.map(([message]) => message.issue.code)).toEqual([
        "remote.ingress_socket_error",
        "remote.tunnel_socket_error",
        "recovery.crash_resume_failed",
        "recovery.crash_resume_failed",
        "remote.ingress_socket_error",
        "remote.tunnel_socket_error",
      ]);
    } finally {
      clock.mockRestore();
    }
  });

  it("sends only a fixed code to the desktop and rejects arbitrary error text", () => {
    const sendMessage = vi.fn();
    ipc(true, sendMessage);
    reportReliabilityIssue("account.refresh_uncertain");
    reportReliabilityIssue("private error /Users/customer/project" as ReliabilityCode);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      { type: "synara:reliability", issue: { code: "account.refresh_uncertain" } },
      expect.any(Function),
    );
  });

  it("does not enqueue reports without a connected desktop", () => {
    const sendMessage = vi.fn();
    ipc(false, sendMessage);
    reportReliabilityIssue("provider.event_retry");
    expect(sendMessage).not.toHaveBeenCalled();
    ipc(true, undefined);
    expect(() => reportReliabilityIssue("provider.event_retry")).not.toThrow();
  });

  it("contains synchronous and asynchronous IPC shutdown errors", () => {
    ipc(true, () => {
      throw new Error("channel closed");
    });
    expect(() => reportReliabilityIssue("recovery.shutdown_event_timeout")).not.toThrow();
    ipc(true, (_message: unknown, callback: (error: Error) => void) => {
      callback(new Error("channel closed"));
    });
    expect(() => reportReliabilityIssue("recovery.shutdown_event_timeout")).not.toThrow();
  });
});
