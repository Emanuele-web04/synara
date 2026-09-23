import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { withFakeDbusTransport } from "./computerPluginTestDoubles.ts";
import {
  DbusConnectionClosedError,
  unwrapDbusValue,
  watchDbusConnection,
  withDbusTimeout,
} from "./dbusPlumbing.ts";
import { isConnectionLevelFailure } from "./KWinComputerBackend.ts";

/** Stands in for a call site's own error type, recovery marker and all. */
class SiteError extends Error {
  readonly connectionLevel = true;
}

describe("unwrapping a D-Bus value", () => {
  it("sees through however many variant layers wrapped it", () => {
    const nested = { signature: "v", value: { signature: "s", value: "ok" } };
    expect(unwrapDbusValue(nested)).toBe("ok");
  });

  it("leaves a plain value, and a look-alike without a signature, alone", () => {
    expect(unwrapDbusValue(["a", "b"])).toEqual(["a", "b"]);
    expect(unwrapDbusValue({ value: "not a variant" })).toEqual({ value: "not a variant" });
    expect(unwrapDbusValue(null)).toBeNull();
  });
});

describe("racing a D-Bus call against a timeout", () => {
  it("rejects with exactly the error the caller's factory built", async () => {
    vi.useFakeTimers();
    try {
      const pending = withDbusTimeout(new Promise(() => undefined), 5_000, {
        onTimeout: () => new SiteError("Method timed out after 5000 ms."),
      });
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(5_000);
      const error = (await settled) as SiteError;
      expect(error).toBeInstanceOf(SiteError);
      expect(error.message).toBe("Method timed out after 5000 ms.");
      expect(error.connectionLevel).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire early, and builds the error only on expiry", async () => {
    vi.useFakeTimers();
    try {
      let built = 0;
      const pending = withDbusTimeout(new Promise(() => undefined), 5_000, {
        onTimeout: () => {
          built += 1;
          return new SiteError("late");
        },
      });
      const settled = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(built).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(built).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timer when the call answers, leaving nothing pending", async () => {
    vi.useFakeTimers();
    try {
      const call = withDbusTimeout(Promise.resolve("ok"), 5_000, {
        onTimeout: () => new SiteError("no"),
      });
      await expect(call).resolves.toBe("ok");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a reported failure through untouched when no mapper is given", async () => {
    const reported = { type: "org.freedesktop.DBus.Error.ServiceUnknown" };
    const call = withDbusTimeout(Promise.reject(reported), 5_000, {
      onTimeout: () => new SiteError("no"),
    });
    await expect(call).rejects.toBe(reported);
  });

  it("hands a reported failure to the mapper when there is one", async () => {
    const reported = { type: "org.freedesktop.portal.Error.Cancelled" };
    const call = withDbusTimeout(Promise.reject(reported), 5_000, {
      onTimeout: () => new SiteError("no"),
      onRejected: (error) => new SiteError(`failed: ${JSON.stringify(error)}`),
    });
    await expect(call).rejects.toThrow(/portal.Error.Cancelled/);
  });

  it("clears the timer on a rejection too", async () => {
    vi.useFakeTimers();
    try {
      const call = withDbusTimeout(Promise.reject(new Error("nope")), 5_000, {
        onTimeout: () => new SiteError("no"),
      });
      await expect(call).rejects.toThrow("nope");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

const never = () => new Promise<never>(() => undefined);

describe("watching a D-Bus connection", () => {
  it("fails a waiting call and everything after it the moment the transport ends", async () => {
    const bus = withFakeDbusTransport(new EventEmitter());
    const watch = watchDbusConnection(bus);
    const closed = vi.fn();
    watch.onClosed(closed);
    const waiting = watch.guard(never);

    bus.dropTransport();

    // dbus-next reports none of this itself: no `disconnect`, no rejection.
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbusConnectionClosedError);
    expect(isConnectionLevelFailure(error)).toBe(true);
    // `end` then the socket's `close`, and a late bus error: one closure.
    bus.emit("error", new Error("read ECONNRESET"));
    expect(closed).toHaveBeenCalledTimes(1);
    expect(watch.isClosed()).toBe(true);

    const start = vi.fn(never);
    await expect(watch.guard(start)).rejects.toBeInstanceOf(DbusConnectionClosedError);
    expect(start).not.toHaveBeenCalled();
  });

  it("treats a bus error as the connection closing, with the error as its cause", async () => {
    const bus = new EventEmitter();
    const watch = watchDbusConnection(bus);
    const reset = new Error("read ECONNRESET");
    const waiting = watch.guard(never);
    bus.emit("error", reset);
    await expect(waiting).rejects.toMatchObject({ cause: reset, connectionLevel: true });
  });

  it("keeps the connection through errors about one message", async () => {
    const bus = withFakeDbusTransport(new EventEmitter());
    const watch = watchDbusConnection(bus);
    const closed = vi.fn();
    watch.onClosed(closed);
    let answer!: (value: string) => void;
    const waiting = watch.guard(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );

    // An undecodable message: dbus-next adds a description and reads on.
    bus.emit("error", new TypeError("bad variant"), "There was an error receiving a message");
    // A failed AddMatch/RemoveMatch reply: a DBusError, named by `type`.
    const refused = Object.assign(new Error("match rule refused"), {
      name: "DBusError",
      type: "org.freedesktop.DBus.Error.MatchRuleInvalid",
      reply: null,
    });
    bus.emit("error", refused);

    expect(watch.isClosed()).toBe(false);
    expect(closed).not.toHaveBeenCalled();
    answer("still here");
    await expect(waiting).resolves.toBe("still here");

    // A socket error still ends it.
    bus.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    expect(watch.isClosed()).toBe(true);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("settles a released connection's calls with the releaser's reason and tells no one", async () => {
    const bus = withFakeDbusTransport(new EventEmitter());
    const watch = watchDbusConnection(bus);
    const closed = vi.fn();
    watch.onClosed(closed);
    const waiting = watch.guard(never);
    const reason = new Error("released");

    watch.release(() => reason);
    bus.dropTransport();

    await expect(waiting).rejects.toBe(reason);
    await expect(watch.guard(never)).rejects.toBe(reason);
    expect(closed).not.toHaveBeenCalled();
  });

  it("passes answers through and forgets settled calls", async () => {
    const bus = new EventEmitter();
    const watch = watchDbusConnection(bus);
    await expect(watch.guard(() => Promise.resolve("ok"))).resolves.toBe("ok");
    const refused = new Error("org.freedesktop.DBus.Error.InvalidArgs");
    await expect(watch.guard(() => Promise.reject(refused))).rejects.toBe(refused);
    await expect(
      watch.guard(() => {
        throw refused;
      }),
    ).rejects.toBe(refused);
  });

  it("keeps a throwing listener from escaping into the socket's emit", () => {
    const bus = withFakeDbusTransport(new EventEmitter());
    const watch = watchDbusConnection(bus);
    watch.onClosed(() => {
      throw new Error("listener bug");
    });
    expect(() => bus.dropTransport()).not.toThrow();
  });
});
