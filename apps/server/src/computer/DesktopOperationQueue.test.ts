import { describe, expect, it } from "vitest";

import {
  DESKTOP_OPERATION_QUEUE_LIMIT,
  DesktopOperationQueue,
  desktopOperationSignal,
  withDesktopOperationSignal,
} from "./DesktopOperationQueue.ts";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("DesktopOperationQueue", () => {
  it("holds the desktop until input and observation finish, then recovers after a failure", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const events: string[] = [];
    const first = queue.run(async () => {
      await queue.run(async () => {
        events.push("input");
      });
      entered.resolve();
      await held.promise;
      events.push("observation");
      throw new Error("capture failed");
    });
    const failed = expect(first).rejects.toThrow("capture failed");
    await entered.promise;
    const second = queue.run(async () => {
      events.push("next input");
    });
    expect(events).toEqual(["input"]);
    held.resolve();
    await failed;
    await second;
    expect(events).toEqual(["input", "observation", "next input"]);
  });

  it("skips an aborted operation before it can send input", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const first = queue.run(() => held.promise);
    const controller = new AbortController();
    let ran = false;
    const second = queue.run(async () => {
      ran = true;
    }, controller.signal);
    const rejected = expect(second).rejects.toThrow();
    controller.abort();
    held.resolve();
    await first;
    await rejected;
    expect(ran).toBe(false);
  });

  it.each(["inherited", "explicit"] as const)(
    "preserves %s cancellation when an operation also has the other signal",
    async (cancelledScope) => {
      const queue = new DesktopOperationQueue();
      const held = deferred();
      const first = queue.run(() => held.promise);
      const inherited = new AbortController();
      const explicit = new AbortController();
      let ran = false;
      const second = withDesktopOperationSignal(inherited.signal, () =>
        queue.run(async () => {
          ran = true;
        }, explicit.signal),
      );
      const rejected = expect(second).rejects.toThrow();
      (cancelledScope === "inherited" ? inherited : explicit).abort();
      held.resolve();
      await first;
      await rejected;
      expect(ran).toBe(false);
      await queue.close();
    },
  );

  it("composes reentrant cancellation without losing the outer transaction", async () => {
    const queue = new DesktopOperationQueue();
    const inner = new AbortController();
    await queue.run(async () => {
      const outerSignal = desktopOperationSignal();
      await queue.run(async () => {
        const nestedSignal = desktopOperationSignal();
        expect(nestedSignal?.aborted).toBe(false);
        inner.abort();
        expect(nestedSignal?.aborted).toBe(true);
      }, inner.signal);
      expect(desktopOperationSignal()).toBe(outerSignal);
      expect(outerSignal?.aborted).toBe(false);
    });
    await queue.close();
  });

  it("runs independent scoped targets concurrently and orders the same target", async () => {
    const queue = new DesktopOperationQueue();
    const releaseA = deferred();
    const releaseB = deferred();
    const enteredA = deferred();
    const enteredB = deferred();
    const events: string[] = [];

    const firstA = queue.runScoped("window-a", async () => {
      events.push("a1");
      enteredA.resolve();
      await releaseA.promise;
    });
    const secondA = queue.runScoped("window-a", async () => {
      events.push("a2");
    });
    const firstB = queue.runScoped("window-b", async () => {
      events.push("b1");
      enteredB.resolve();
      await releaseB.promise;
    });

    await Promise.all([enteredA.promise, enteredB.promise]);
    expect(events).toEqual(["a1", "b1"]);
    releaseA.resolve();
    await firstA;
    await secondA;
    expect(events).toEqual(["a1", "b1", "a2"]);
    releaseB.resolve();
    await firstB;
    await queue.close();
  });

  it("keeps exclusive work ahead of later scoped admissions", async () => {
    const queue = new DesktopOperationQueue();
    const releaseScoped = deferred();
    const enteredScoped = deferred();
    const events: string[] = [];
    const scoped = queue.runScoped("window-a", async () => {
      events.push("scoped");
      enteredScoped.resolve();
      await releaseScoped.promise;
    });
    await enteredScoped.promise;

    const exclusive = queue.run(async () => {
      events.push("exclusive");
    });
    const laterScoped = queue.runScoped("window-b", async () => {
      events.push("later scoped");
    });
    await Promise.resolve();
    expect(events).toEqual(["scoped"]);

    releaseScoped.resolve();
    await Promise.all([scoped, exclusive, laterScoped]);
    expect(events).toEqual(["scoped", "exclusive", "later scoped"]);
    await queue.close();
  });

  it("does not let exclusive work overtake an earlier same-target operation", async () => {
    const queue = new DesktopOperationQueue();
    const releaseFirst = deferred();
    const enteredFirst = deferred();
    const events: string[] = [];
    const first = queue.runScoped("window-a", async () => {
      events.push("first");
      enteredFirst.resolve();
      await releaseFirst.promise;
    });
    await enteredFirst.promise;
    const second = queue.runScoped("window-a", async () => {
      events.push("second");
    });
    const exclusive = queue.run(async () => {
      events.push("exclusive");
    });

    releaseFirst.resolve();
    await Promise.all([first, second, exclusive]);
    expect(events).toEqual(["first", "second", "exclusive"]);
    await queue.close();
  });

  it("bounds the backlog and drains active input before closing", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const first = queue.run(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    let queuedRuns = 0;
    const waiting = Array.from({ length: DESKTOP_OPERATION_QUEUE_LIMIT - 1 }, () =>
      expect(
        queue.run(async () => {
          queuedRuns += 1;
        }),
      ).rejects.toThrow("closed"),
    );
    await expect(queue.run(async () => undefined)).rejects.toThrow("Too many");
    const closed = queue.close();
    held.resolve();
    await first;
    await closed;
    await Promise.all(waiting);
    expect(queuedRuns).toBe(0);
    await expect(queue.run(async () => undefined)).rejects.toThrow("closed");
  });
});

it("cancels running native work before completing shutdown", async () => {
  const queue = new DesktopOperationQueue();
  const entered = deferred();
  const running = queue.run(async () => {
    const signal = desktopOperationSignal()!;
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    entered.resolve();
    await aborted;
    expect(signal.aborted).toBe(true);
  });
  await entered.promise;
  await queue.close();
  await running;
});

it("does not retain a cancelled turn's signal in detached background work", async () => {
  const queue = new DesktopOperationQueue();
  const controller = new AbortController();
  const release = deferred();
  let detached!: Promise<AbortSignal | undefined>;
  await queue.run(async () => {
    detached = release.promise.then(() => desktopOperationSignal());
    expect(desktopOperationSignal()?.aborted).toBe(false);
  }, controller.signal);
  controller.abort();
  release.resolve();
  expect(await detached).toBeUndefined();
  await queue.close();
});

it("expires a composed operation signal before detached cosmetic work resumes", async () => {
  const { withDesktopOperationSignal } = await import("./DesktopOperationQueue.ts");
  const controller = new AbortController();
  const release = deferred();
  let detached!: Promise<AbortSignal | undefined>;
  await withDesktopOperationSignal(controller.signal, async () => {
    detached = release.promise.then(() => desktopOperationSignal());
    expect(desktopOperationSignal()).toBe(controller.signal);
  });
  controller.abort();
  release.resolve();
  expect(await detached).toBeUndefined();
});
