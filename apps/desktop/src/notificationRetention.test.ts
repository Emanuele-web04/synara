// FILE: notificationRetention.test.ts
// Purpose: Guards the notification retainer: toasts stay referenced until an
//          event proves they can no longer be clicked, and the set stays bounded.

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { createDesktopNotificationRetainer } from "./notificationRetention";

class FakeNotification extends EventEmitter {}

describe("createDesktopNotificationRetainer", () => {
  it("holds a notification until it is clicked", () => {
    const retainer = createDesktopNotificationRetainer<FakeNotification>();
    const notification = new FakeNotification();
    retainer.retain(notification);
    expect(retainer.size).toBe(1);

    notification.emit("click");
    expect(retainer.size).toBe(0);
  });

  it("keeps a timed-out toast clickable from the notification center", () => {
    const retainer = createDesktopNotificationRetainer<FakeNotification>();
    const notification = new FakeNotification();
    retainer.retain(notification);

    notification.emit("close", { reason: "timedOut" });
    expect(retainer.size).toBe(1);

    notification.emit("click");
    expect(retainer.size).toBe(0);
  });

  it("releases on explicit dismissal, on close without a reason, and on failure", () => {
    const retainer = createDesktopNotificationRetainer<FakeNotification>();
    const dismissed = new FakeNotification();
    const closed = new FakeNotification();
    const failed = new FakeNotification();
    retainer.retain(dismissed);
    retainer.retain(closed);
    retainer.retain(failed);

    dismissed.emit("close", { reason: "userCanceled" });
    closed.emit("close");
    failed.emit("failed");
    expect(retainer.size).toBe(0);
  });

  it("evicts the oldest notification past the limit", () => {
    const retainer = createDesktopNotificationRetainer<FakeNotification>(2);
    const first = new FakeNotification();
    retainer.retain(first);
    retainer.retain(new FakeNotification());
    retainer.retain(new FakeNotification());
    expect(retainer.size).toBe(2);

    // The evicted notification is no longer tracked, so its late click is a no-op.
    first.emit("click");
    expect(retainer.size).toBe(2);
  });
});
