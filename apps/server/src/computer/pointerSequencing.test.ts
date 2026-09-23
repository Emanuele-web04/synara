import { describe, expect, it } from "vitest";

import {
  EVDEV_BUTTON_CODES,
  EVDEV_KEY_CODES,
  keyStrokeForKey,
  qwertyTextKeyStrokes,
} from "./evdevInput.ts";
import {
  BUTTON_HOLD_MS,
  GLIDE_FRAME_INTERVAL_MS,
  glidePointerToDeadline,
  keysHeldAfter,
  keyStrokeEvents,
  POINTER_SEQUENCE_OPERATIONS,
  pointerGlideSteps,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
  TYPING_BATCH_MAX_EVENTS,
  typeStrokesInBatches,
  typingBatches,
  type ComputerInputSink,
  type KeyEvent,
} from "./pointerSequencing.ts";

/** Records every event a sequence emits, in order, with its operation name. */
function recordingSink(options: { readonly failOn?: (call: string) => boolean } = {}): {
  readonly sink: ComputerInputSink;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const push = (call: string) => {
    calls.push(call);
    if (options.failOn?.(call)) return Promise.reject(new Error(`refused ${call}`));
    return Promise.resolve();
  };
  return {
    calls,
    sink: {
      movePointer: (x, y, operation) => push(`${operation} ${x},${y}`),
      button: (code, pressed, operation) => push(`${operation} ${code} ${pressed}`),
      key: (code, pressed, operation) => push(`${operation} ${code} ${pressed}`),
    },
  };
}

describe("pointerGlideSteps", () => {
  const origin = { x: 0, y: 0 };

  it("schedules the last sample at the requested duration with even spacing", () => {
    const steps = pointerGlideSteps(origin, { x: 200, y: 0 }, 1_500);
    const offsets = steps.map((step) => step.offsetMs);

    expect(offsets.at(-1)).toBeCloseTo(1_500, 6);
    // The gaps are what a paced caller actually waits, so they must add up to
    // the requested duration rather than to steps x a fixed sleep.
    const gaps = offsets.map((offset, index) => offset - (offsets[index - 1] ?? 0));
    expect(gaps.reduce((total, gap) => total + gap, 0)).toBeCloseTo(1_500, 6);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GLIDE_FRAME_INTERVAL_MS);
  });

  it("keeps every sample gap inside one frame interval for a long duration", () => {
    // A 1500ms drag used to be sampled at 40ms and then walked with fixed 8ms
    // sleeps, so it ran in a fraction of the duration it asked for.
    const steps = pointerGlideSteps(origin, { x: 10, y: 10 }, 1_500);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(1_500 / GLIDE_FRAME_INTERVAL_MS));
    for (const step of steps) expect(step.offsetMs).toBeLessThanOrEqual(1_500);
  });

  it("keeps the smoothstep easing", () => {
    const steps = pointerGlideSteps(origin, { x: 100, y: 200 }, 0, 4);

    expect(steps).toEqual([
      { point: { x: 15.625, y: 31.25 }, offsetMs: 0 },
      { point: { x: 50, y: 100 }, offsetMs: 0 },
      { point: { x: 84.375, y: 168.75 }, offsetMs: 0 },
      { point: { x: 100, y: 200 }, offsetMs: 0 },
    ]);
  });

  it("moves once, at once, when the pointer is already within a pixel of the target", () => {
    // Twelve samples over 180 ms used to cross zero pixels on every click at
    // the cursor's own position and every wheel notch from the pane.
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 10.4, y: 10.3 }, 180)).toEqual([
      { point: { x: 10.4, y: 10.3 }, offsetMs: 0 },
    ]);
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 10, y: 10 }, 1_500)).toHaveLength(1);
    // A real pixel still glides.
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 11, y: 10 }, 180).length).toBeGreaterThan(1);
  });

  it("keeps the distance minimum so a fast glide over a long path stays smooth", () => {
    const steps = pointerGlideSteps(origin, { x: 800, y: 0 }, 0);

    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    expect(steps.at(-1)?.point).toEqual({ x: 800, y: 0 });
  });

  it("treats a negative or non-finite duration as immediate", () => {
    for (const duration of [-1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const steps = pointerGlideSteps(origin, { x: 40, y: 0 }, duration);
      expect(steps).toHaveLength(2);
      expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    }
  });
});

describe("glidePointerToDeadline", () => {
  it("sleeps only the remainder up to each deadline, so transport latency is absorbed", async () => {
    // A transport that costs 10ms a hop against 16ms deadlines must leave 6ms
    // of sleep, not 16 — otherwise a slow desktop stretches every drag.
    const sleeps: number[] = [];
    let clock = 0;
    const { sink } = recordingSink();
    await glidePointerToDeadline({
      sink: {
        movePointer: async (...args) => {
          clock += 10;
          await sink.movePointer(...args);
        },
      },
      from: { x: 0, y: 0 },
      to: { x: 4, y: 0 },
      durationMs: 64,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    expect(sleeps).toHaveLength(4);
    for (const slept of sleeps) expect(slept).toBeCloseTo(6, 6);
    expect(clock).toBe(64);
  });

  it("abandons the glide when beforeStep throws, without emitting that step", async () => {
    const { sink, calls } = recordingSink();
    let steps = 0;
    await expect(
      glidePointerToDeadline({
        sink,
        from: { x: 0, y: 0 },
        to: { x: 400, y: 0 },
        durationMs: 0,
        now: () => 0,
        sleep: async () => undefined,
        beforeStep: () => {
          steps += 1;
          if (steps > 2) throw new Error("disposed");
        },
      }),
    ).rejects.toThrow("disposed");

    expect(calls).toHaveLength(2);
  });
});

describe("pressKeyStroke", () => {
  it("wraps a shifted stroke in a shift press and release", async () => {
    const { sink, calls } = recordingSink();
    await pressKeyStroke({ sink, stroke: keyStrokeForKey("A") });

    expect(calls).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftShift} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.A} false`,
      `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
    ]);
  });

  it("still releases shift when the stroke it wrapped was refused", async () => {
    // A shift left latched down is the worst failure this feature has: it
    // silently rewrites everything the human types next.
    const { sink, calls } = recordingSink({
      failOn: (call) =>
        call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true`,
    });
    await expect(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") })).rejects.toThrow("refused");

    expect(calls.at(-1)).toBe(
      `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
    );
  });

  it("reports the stroke failure when the shift release refuses on top of it", async () => {
    const { sink } = recordingSink({
      failOn: (call) =>
        call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true` ||
        call === `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
    });
    await expect(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") })).rejects.toThrow(
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A}`,
    );
  });
});

describe("pressHotkeyStrokes", () => {
  it("releases the chord in the reverse of the order it went down", async () => {
    const { sink, calls } = recordingSink();
    await pressHotkeyStrokes({ sink, strokes: ["ctrl", "shift", "t"].map(keyStrokeForKey) });

    expect(calls).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftControl} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftShift} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.T} false`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
    ]);
  });

  it("releases exactly the keys that went down when a later key is refused", async () => {
    const { sink, calls } = recordingSink({
      failOn: (call) =>
        call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
    });
    await expect(
      pressHotkeyStrokes({ sink, strokes: ["ctrl", "t"].map(keyStrokeForKey) }),
    ).rejects.toThrow("refused");

    expect(calls).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftControl} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
    ]);
  });

  /**
   * Each release is one D-Bus notify that can fail transiently while the
   * session survives; aborting the loop on the first refusal would leave every
   * modifier behind it latched on the human's keyboard until disposal.
   */
  it("runs every chord release even after one refuses, and surfaces the first refusal", async () => {
    const refusedRelease = `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftShift} false`;
    const { sink, calls } = recordingSink({ failOn: (call) => call === refusedRelease });
    await expect(
      pressHotkeyStrokes({ sink, strokes: ["ctrl", "shift", "t"].map(keyStrokeForKey) }),
    ).rejects.toThrow(`refused ${refusedRelease}`);

    // Shift's release refused, but T's and Ctrl's still happened.
    expect(calls.slice(-3)).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.T} false`,
      refusedRelease,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
    ]);
  });

  it("keeps reporting the press failure when a chord release also refuses", async () => {
    const { sink } = recordingSink({
      failOn: (call) =>
        call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true` ||
        call === `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
    });
    await expect(
      pressHotkeyStrokes({ sink, strokes: ["ctrl", "t"].map(keyStrokeForKey) }),
    ).rejects.toThrow(`${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T}`);
  });
});

describe("pressButtonOnce", () => {
  it("holds the button long enough for a toolkit to register the press", async () => {
    const held: number[] = [];
    const { sink, calls } = recordingSink();
    await pressButtonOnce({
      sink,
      code: EVDEV_BUTTON_CODES.left,
      sleep: async (milliseconds) => {
        held.push(milliseconds);
      },
    });

    expect(held).toEqual([BUTTON_HOLD_MS]);
    expect(calls).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.buttonPress} ${EVDEV_BUTTON_CODES.left} true`,
      `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`,
    ]);
  });

  it("releases a button whose hold was interrupted", async () => {
    // A button left down drags the desktop under every later pointer move, so
    // the release has to survive anything that goes wrong during the hold.
    const { sink, calls } = recordingSink();
    await expect(
      pressButtonOnce({
        sink,
        code: EVDEV_BUTTON_CODES.left,
        sleep: () => Promise.reject(new Error("aborted")),
      }),
    ).rejects.toThrow("aborted");

    expect(calls.at(-1)).toBe(
      `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`,
    );
  });

  it("reports an interrupted hold rather than a refused release on top of it", async () => {
    // Both halves failed; the hold's abort is the cause worth acting on.
    const { sink } = recordingSink({
      failOn: (call) => call.includes(POINTER_SEQUENCE_OPERATIONS.buttonRelease),
    });
    await expect(
      pressButtonOnce({
        sink,
        code: EVDEV_BUTTON_CODES.left,
        sleep: () => Promise.reject(new Error("aborted")),
      }),
    ).rejects.toThrow("aborted");
  });
});

describe("input cleanup failures", () => {
  it("reports a refused shift release after a successful stroke", async () => {
    const release = `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`;
    const { sink, calls } = recordingSink({ failOn: (call) => call === release });

    await expect(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") })).rejects.toThrow(
      `refused ${release}`,
    );
    expect(calls.at(-1)).toBe(release);
  });

  it("reports a refused button release after a successful hold", async () => {
    const release = `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`;
    const { sink, calls } = recordingSink({ failOn: (call) => call === release });

    await expect(
      pressButtonOnce({
        sink,
        code: EVDEV_BUTTON_CODES.left,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow(`refused ${release}`);
    expect(calls.at(-1)).toBe(release);
  });

  it.each([undefined, null, "interrupted"])(
    "preserves a non-Error action rejection of %s when cleanup also fails",
    async (failure) => {
      const calls: string[] = [];
      const sink: ComputerInputSink = {
        movePointer: async () => undefined,
        key: async (code, pressed, operation) => {
          calls.push(operation);
          if (!pressed) throw new Error("release refused");
          if (code === EVDEV_KEY_CODES.A) throw failure;
        },
        button: async (_code, pressed, operation) => {
          calls.push(operation);
          if (!pressed) throw new Error("release refused");
        },
      };

      await expect(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") })).rejects.toBe(failure);
      expect(calls.at(-1)).toBe(POINTER_SEQUENCE_OPERATIONS.shiftRelease);
      await expect(
        pressHotkeyStrokes({ sink, strokes: ["ctrl", "A"].map(keyStrokeForKey) }),
      ).rejects.toBe(failure);
      expect(calls.slice(-2)).toEqual([
        POINTER_SEQUENCE_OPERATIONS.keyRelease,
        POINTER_SEQUENCE_OPERATIONS.keyRelease,
      ]);
      await expect(
        pressButtonOnce({
          sink,
          code: EVDEV_BUTTON_CODES.left,
          sleep: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(calls.at(-1)).toBe(POINTER_SEQUENCE_OPERATIONS.buttonRelease);
    },
  );
});

describe("batched typing", () => {
  const SHIFT = EVDEV_KEY_CODES.LeftShift;

  it("wraps a shifted stroke in Shift and leaves a plain one bare", () => {
    const [upper, lower] = qwertyTextKeyStrokes("Aa");
    expect(keyStrokeEvents(upper!)).toEqual([
      [SHIFT, true],
      [upper!.code, true],
      [upper!.code, false],
      [SHIFT, false],
    ]);
    expect(keyStrokeEvents(lower!)).toEqual([
      [lower!.code, true],
      [lower!.code, false],
    ]);
  });

  it("batches a word per call, bounded, never splitting a character", () => {
    const text = "Hello world, " + "x".repeat(40);
    const characters = [...text];
    const batches = typingBatches(characters, qwertyTextKeyStrokes(text));
    const texts: string[] = [];
    let at = 0;
    for (const batch of batches) {
      texts.push(characters.slice(at, at + batch.length).join(""));
      at += batch.length;
      const events = batch.flatMap(keyStrokeEvents).length;
      expect(events).toBeLessThanOrEqual(TYPING_BATCH_MAX_EVENTS);
    }
    expect(texts).toEqual(["Hello ", "world, ", "x".repeat(16), "x".repeat(16), "x".repeat(8)]);
  });

  it("names the keys a cut-short batch left held, newest first", () => {
    const events: KeyEvent[] = [
      [SHIFT, true],
      [30, true],
      [30, false],
      [SHIFT, false],
    ];
    expect(keysHeldAfter(events, 2)).toEqual([30, SHIFT]);
    expect(keysHeldAfter(events, 3)).toEqual([SHIFT]);
    expect(keysHeldAfter(events, 4)).toEqual([]);
  });

  it("releases what a refused batch left held and reports the characters that landed", async () => {
    const text = "ab CD";
    const { sink, calls } = recordingSink();
    const batches: KeyEvent[][] = [];
    const progress: number[] = [];
    const refusal = new Error("refused");
    const error = await typeStrokesInBatches({
      sink: {
        key: sink.key,
        // The first word lands; the second stops after C's key press.
        keys: async (events) => {
          batches.push([...events]);
          return batches.length === 1 ? events.length : 6;
        },
      },
      characters: [...text],
      strokes: qwertyTextKeyStrokes(text),
      onProgress: (typed) => progress.push(typed),
      refused: () => refusal,
    }).catch((caught: unknown) => caught);
    expect(error).toBe(refusal);
    expect(batches).toHaveLength(2);
    // "ab " landed, then C in full (4 events) and D's Shift and press (2).
    expect(progress).toEqual([3, 4]);
    const d = qwertyTextKeyStrokes("D")[0]!.code;
    expect(calls).toEqual([
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${d} false`,
      `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${SHIFT} false`,
    ]);
  });

  it("stops between words when the operation is cancelled", async () => {
    const text = "one two three";
    let sent = 0;
    const cancelled = new Error("cancelled");
    const error = await typeStrokesInBatches({
      sink: {
        key: async () => undefined,
        keys: async (events) => {
          sent += 1;
          return events.length;
        },
      },
      characters: [...text],
      strokes: qwertyTextKeyStrokes(text),
      beforeBatch: () => {
        if (sent === 2) throw cancelled;
      },
      onProgress: () => undefined,
      refused: () => new Error("refused"),
    }).catch((caught: unknown) => caught);
    expect(error).toBe(cancelled);
    expect(sent).toBe(2);
  });
});
