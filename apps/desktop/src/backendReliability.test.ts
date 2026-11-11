import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";

import { attachBackendReliability } from "./backendReliability";

function makeChild(report: Parameters<typeof attachBackendReliability>[1]["report"]) {
  const child = new EventEmitter();
  attachBackendReliability(child as ChildProcess, { report });
  return child;
}

const message = (code: string) => ({ type: "synara:reliability", issue: { code } });

it("relays only fixed backend issue codes without private envelope or issue fields", () => {
  const report = vi.fn();
  const child = makeChild(report);
  child.emit("message", { type: "unrelated", issue: { code: "provider.event_retry" } });
  child.emit("message", message("private diagnosis"));
  child.emit("message", { ...message("provider.event_retry"), path: "/private/path" });
  child.emit("message", {
    type: "synara:reliability",
    issue: { code: "provider.event_retry", threadId: "private thread" },
  });
  child.emit("message", message("provider.event_quarantined"));
  expect(report.mock.calls).toEqual([[{ code: "provider.event_quarantined" }]]);
});

it("accepts the retiring child's final report and removes only its listener at close", () => {
  const report = vi.fn();
  const retiring = makeChild(report);
  const unrelated = vi.fn();
  retiring.on("message", unrelated);
  retiring.emit("exit", 0, null);

  const replacement = makeChild(report);
  retiring.emit("message", message("recovery.shutdown_event_timeout"));
  retiring.emit("close", 0, null);
  expect(retiring.listenerCount("message")).toBe(1);
  retiring.emit("message", message("recovery.crash_resume_failed"));
  replacement.emit("message", message("provider.event_retry"));
  expect(report.mock.calls).toEqual([
    [{ code: "recovery.shutdown_event_timeout" }],
    [{ code: "provider.event_retry" }],
  ]);
  expect(unrelated).toHaveBeenCalledTimes(2);
  replacement.emit("close", 0, null);
  expect(replacement.listenerCount("message")).toBe(0);
});
