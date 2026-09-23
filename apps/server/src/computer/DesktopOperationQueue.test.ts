import { AsyncLocalStorage } from "node:async_hooks";

import { describe, expect, it } from "vitest";

import {
  DESKTOP_OPERATION_QUEUE_LIMIT,
  DesktopOperationQueue,
  desktopOperationSignal,
  withDesktopDeliveryMode,
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

/** Lets every already-queued continuation run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("DesktopOperationQueue pane input", () => {
  it("runs pane input while an agent observes, and resumes the agent only after it", async () => {
    const queue = new DesktopOperationQueue();
    const observing = deferred();
    const observed = deferred();
    const paneHeld = deferred();
    const events: string[] = [];
    const agent = queue.run(async () => {
      events.push("agent input");
      await queue.observing(async () => {
        observing.resolve();
        await observed.promise;
        events.push("agent observed");
      });
      events.push("agent next input");
    });
    await observing.promise;
    const pane = queue.runPaneInput(async () => {
      events.push("pane input");
      await paneHeld.promise;
      events.push("pane done");
    });
    await settle();
    // Latency: the pane did not wait for the observation to finish.
    expect(events).toEqual(["agent input", "pane input"]);
    observed.resolve();
    await settle();
    // Ordering: the agent does not continue past its observation while the
    // pane's input is still in flight.
    expect(events).toEqual(["agent input", "pane input", "agent observed"]);
    paneHeld.resolve();
    await Promise.all([agent, pane]);
    expect(events).toEqual([
      "agent input",
      "pane input",
      "agent observed",
      "pane done",
      "agent next input",
    ]);
    await queue.close();
  });

  it("never lands pane input inside the agent's input", async () => {
    const queue = new DesktopOperationQueue();
    const inInput = deferred();
    const inputHeld = deferred();
    const events: string[] = [];
    const agent = queue.run(async () => {
      // Input nested in an observation region still holds the desktop.
      await queue.observing(() =>
        queue.inputting(async () => {
          events.push("agent press");
          inInput.resolve();
          await inputHeld.promise;
          events.push("agent release");
        }),
      );
    });
    await inInput.promise;
    const pane = queue.runPaneInput(async () => {
      events.push("pane input");
    });
    await settle();
    expect(events).toEqual(["agent press"]);
    inputHeld.resolve();
    await Promise.all([agent, pane]);
    expect(events).toEqual(["agent press", "agent release", "pane input"]);
    await queue.close();
  });

  it("waits out a transaction that never yields, then goes ahead of queued work", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const events: string[] = [];
    const first = queue.run(async () => {
      entered.resolve();
      await held.promise;
      events.push("agent 1");
    });
    await entered.promise;
    const second = queue.run(async () => {
      events.push("agent 2");
    });
    const pane = queue.runPaneInput(async () => {
      events.push("pane");
    });
    await settle();
    expect(events).toEqual([]);
    held.resolve();
    await Promise.all([first, second, pane]);
    expect(events).toEqual(["agent 1", "pane", "agent 2"]);
    await queue.close();
  });

  it("keeps foreground excursions exclusive", async () => {
    const queue = new DesktopOperationQueue();
    const observing = deferred();
    const observed = deferred();
    const events: string[] = [];
    const agent = queue.run(() =>
      withDesktopDeliveryMode("foreground", () =>
        queue.observing(async () => {
          observing.resolve();
          await observed.promise;
          events.push("agent observed");
        }),
      ),
    );
    await observing.promise;
    const pane = queue.runPaneInput(async () => {
      events.push("pane");
    });
    await settle();
    expect(events).toEqual([]);
    observed.resolve();
    await Promise.all([agent, pane]);
    expect(events).toEqual(["agent observed", "pane"]);
    await queue.close();
  });

  it("waits for every running scoped transaction to yield", async () => {
    const queue = new DesktopOperationQueue();
    const aObserving = deferred();
    const bHeld = deferred();
    const aDone = deferred();
    const events: string[] = [];
    const a = queue.runScoped("a", () =>
      queue.observing(async () => {
        aObserving.resolve();
        await aDone.promise;
      }),
    );
    const bEntered = deferred();
    const b = queue.runScoped("b", async () => {
      bEntered.resolve();
      await bHeld.promise;
      events.push("b input done");
    });
    await aObserving.promise;
    await bEntered.promise;
    const pane = queue.runPaneInput(async () => {
      events.push("pane");
    });
    await settle();
    expect(events).toEqual([]);
    bHeld.resolve();
    await b;
    await pane;
    expect(events).toEqual(["b input done", "pane"]);
    aDone.resolve();
    await a;
    await queue.close();
  });

  it("gives pane input its own context and transaction, joined by nested calls", async () => {
    const queue = new DesktopOperationQueue();
    const task = new AsyncLocalStorage<string>();
    const observing = deferred();
    const observed = deferred();
    const agent = task.run("agent", () =>
      queue.run(() =>
        queue.observing(async () => {
          observing.resolve();
          await observed.promise;
        }),
      ),
    );
    await observing.promise;
    const seen = await task.run("pane", () =>
      queue.runPaneInput(async () => {
        // A nested exclusive call joins the pane's transaction instead of
        // queueing behind the agent that is still observing.
        const nested = await queue.run(async () => task.getStore());
        return { outer: task.getStore(), nested, active: desktopOperationSignal() !== undefined };
      }),
    );
    expect(seen).toEqual({ outer: "pane", nested: "pane", active: true });
    observed.resolve();
    await agent;
    await queue.close();
  });

  it("starts queued agent work after the pane input it found, not after a stream of later input", async () => {
    const queue = new DesktopOperationQueue();
    const firstHeld = deferred();
    const firstEntered = deferred();
    const events: string[] = [];
    // Every pane input queues another one, as a steady wheel stream would.
    let stream = 6;
    const drained = deferred();
    const pane = (name: string): Promise<void> =>
      queue.runPaneInput(async () => {
        events.push(name);
        if (stream === 0) return drained.resolve();
        stream -= 1;
        void pane(`stream ${stream}`);
      });
    const first = queue.runPaneInput(async () => {
      events.push("pane 1");
      firstEntered.resolve();
      await firstHeld.promise;
    });
    await firstEntered.promise;
    const second = queue.runPaneInput(async () => {
      events.push("pane 2");
    });
    const agent = queue.run(async () => {
      events.push("agent");
    });
    await settle();
    const later = pane("pane 3");
    firstHeld.resolve();
    await Promise.all([agent, first, second, later, drained.promise]);
    // What arrived before the agent started waiting went first; what arrived
    // after did not, however much more of it kept coming.
    expect(events).toEqual([
      "pane 1",
      "pane 2",
      "agent",
      "pane 3",
      "stream 5",
      "stream 4",
      "stream 3",
      "stream 2",
      "stream 1",
      "stream 0",
    ]);
    await queue.close();
  });

  it("starts the agent's next input after the pane input it found, then lets the rest run", async () => {
    const queue = new DesktopOperationQueue();
    const observing = deferred();
    const observed = deferred();
    const paneHeld = deferred();
    const paneEntered = deferred();
    const inputHeld = deferred();
    const inputEntered = deferred();
    const lookingAgain = deferred();
    const done = deferred();
    const events: string[] = [];
    const agent = queue.run(() =>
      queue.observing(async () => {
        observing.resolve();
        await observed.promise;
        await queue.inputting(async () => {
          events.push("agent input");
          inputEntered.resolve();
          await inputHeld.promise;
        });
        // Observing again: pane input queued during the input may start.
        lookingAgain.resolve();
        await done.promise;
        events.push("agent done");
      }),
    );
    await observing.promise;
    const first = queue.runPaneInput(async () => {
      events.push("pane 1");
      paneEntered.resolve();
      await paneHeld.promise;
    });
    await paneEntered.promise;
    const second = queue.runPaneInput(async () => {
      events.push("pane 2");
    });
    observed.resolve();
    await settle();
    const later = queue.runPaneInput(async () => {
      events.push("pane 3");
    });
    paneHeld.resolve();
    await inputEntered.promise;
    await settle();
    expect(events).toEqual(["pane 1", "pane 2", "agent input"]);
    inputHeld.resolve();
    await lookingAgain.promise;
    await later;
    expect(events).toEqual(["pane 1", "pane 2", "agent input", "pane 3"]);
    done.resolve();
    await Promise.all([agent, first, second]);
    expect(events.at(-1)).toBe("agent done");
    await queue.close();
  });

  it("starts pane input queued during the agent's input once that input ends", async () => {
    const queue = new DesktopOperationQueue();
    const inputEntered = deferred();
    const inputHeld = deferred();
    const done = deferred();
    const events: string[] = [];
    const agent = queue.run(() =>
      queue.observing(async () => {
        await queue.inputting(async () => {
          inputEntered.resolve();
          await inputHeld.promise;
          events.push("agent input");
        });
        await done.promise;
        events.push("agent done");
      }),
    );
    await inputEntered.promise;
    const pane = queue.runPaneInput(async () => {
      events.push("pane");
    });
    await settle();
    expect(events).toEqual([]);
    inputHeld.resolve();
    // The agent is observing again and still has not finished.
    await expect(
      Promise.race([
        pane.then(() => "pane ran"),
        new Promise((resolve) => setTimeout(() => resolve("pane still queued"), 200)),
      ]),
    ).resolves.toBe("pane ran");
    expect(events).toEqual(["agent input", "pane"]);
    done.resolve();
    await agent;
    await queue.close();
  });

  it("limits pane input on its own lane, so a burst never refuses the agent's calls", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const running = queue.run(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    const burst = Array.from({ length: DESKTOP_OPERATION_QUEUE_LIMIT }, () =>
      queue.runPaneInput(async () => undefined),
    );
    await expect(queue.runPaneInput(async () => undefined)).rejects.toThrow("Too many");
    const agent = queue.run(async () => "agent");
    held.resolve();
    await running;
    await Promise.all(burst);
    await expect(agent).resolves.toBe("agent");
    await queue.close();
  });

  it("rejects queued pane input on close", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const running = queue.run(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    const pane = queue.runPaneInput(async () => undefined);
    const closed = queue.close();
    await expect(pane).rejects.toThrow("closed");
    held.resolve();
    await running;
    await closed;
  });
});

it("refuses an agent's input on Stop instead of waiting out the pane's", async () => {
  const queue = new DesktopOperationQueue();
  const stop = new AbortController();
  const observing = deferred();
  const paneHeld = deferred();
  const paneStarted = deferred();
  let sent = false;
  const agent = queue.run(async () => {
    await queue.observing(async () => {
      observing.resolve();
      await paneStarted.promise;
    });
    await queue.inputting(async () => {
      sent = true;
    });
  }, stop.signal);
  await observing.promise;
  const pane = queue.runPaneInput(async () => {
    paneStarted.resolve();
    await paneHeld.promise;
  });
  await paneStarted.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  const refused = expect(agent).rejects.toThrow();
  stop.abort(new Error("Stopped"));
  await refused;
  expect(sent).toBe(false);
  paneHeld.resolve();
  await pane;
  await queue.close();
});
