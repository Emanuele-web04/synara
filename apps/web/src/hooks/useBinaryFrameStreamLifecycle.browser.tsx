// FILE: useBinaryFrameStreamLifecycle.browser.tsx
// Purpose: Pin the reconnect and teardown policy both frame-stream panes share.
// Layer: Browser hook test
//
// This is the half of the Computer pane's image stream and the device pane's
// video stream that used to be written twice. The reconnect backoff in
// particular is the sort of thing that silently diverges: a frame source is
// single-use, so a socket that closes under a mounted pane leaves nothing to
// reopen it, and the pane spins forever if this is wrong.

import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  FRAME_RECONNECT_MAX_DELAY_MS,
  useBinaryFrameStreamLifecycle,
  type BinaryFrameStreamHandlers,
  type BinaryFrameStreamStatus,
} from "./useBinaryFrameStreamLifecycle";

type Reset = "closed" | "decode-failed";

interface Harness {
  readonly opens: number;
  readonly closes: number;
  readonly resets: number;
  reset(): void;
  fire(reason: Reset): void;
  frame(value: number): void;
}

function createHarness() {
  let handlers: BinaryFrameStreamHandlers<number, Reset> | null = null;
  const seen: number[] = [];
  const state = { opens: 0, closes: 0, resets: 0 };
  const status: { current: BinaryFrameStreamStatus } = { current: { kind: "idle" } };

  function Probe(props: { streamKey: string | null }) {
    const result = useBinaryFrameStreamLifecycle<number, Reset, string>({
      enabled: true,
      streamKey: props.streamKey,
      isSupported: () => true,
      openSource: (_key, next) => {
        state.opens += 1;
        handlers = next;
        return {
          close: () => {
            state.closes += 1;
          },
          requestResync: () => undefined,
        };
      },
      createDecoder: (_key, controls) => ({
        onFrame: (value) => {
          seen.push(value);
          controls.setStatus({ kind: "streaming" });
        },
        reset: () => {
          state.resets += 1;
        },
      }),
      resetMessage: () => "the stream disconnected",
    });
    status.current = result.status;
    return null;
  }

  const harness: Harness = {
    get opens() {
      return state.opens;
    },
    get closes() {
      return state.closes;
    },
    get resets() {
      return state.resets;
    },
    reset: () => {
      state.opens = 0;
      state.closes = 0;
      state.resets = 0;
      seen.length = 0;
    },
    fire: (reason) => handlers?.onReset(reason),
    frame: (value) => handlers?.onFrame(value),
  };
  return { Probe, harness, seen, status };
}

it("reopens a closed socket with a doubling backoff and resets it after a frame", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { Probe, harness, status } = createHarness();
  const screen = await render(<Probe streamKey="alpha" />);
  await expect.poll(() => harness.opens).toBe(1);

  harness.fire("closed");
  expect(status.current.kind).toBe("connecting");
  // 500ms for the first attempt, then 1000ms for the second.
  await vi.advanceTimersByTimeAsync(499);
  expect(harness.opens).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.opens).toBe(2);

  harness.fire("closed");
  await vi.advanceTimersByTimeAsync(999);
  expect(harness.opens).toBe(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(harness.opens).toBe(3);

  // A delivered frame proves the socket is healthy, so the next drop starts
  // its backoff over rather than from where the last streak left off.
  harness.frame(7);
  harness.fire("closed");
  await vi.advanceTimersByTimeAsync(500);
  expect(harness.opens).toBe(4);

  await screen.unmount();
  vi.useRealTimers();
});

it("caps the backoff so a server that stays down is not hammered", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { Probe, harness } = createHarness();
  const screen = await render(<Probe streamKey="alpha" />);
  await expect.poll(() => harness.opens).toBe(1);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    harness.fire("closed");
    await vi.advanceTimersByTimeAsync(FRAME_RECONNECT_MAX_DELAY_MS);
  }
  expect(harness.opens).toBe(13);

  await screen.unmount();
  vi.useRealTimers();
});

it("reports a reset it will not reconnect from, and drops decoder state on every reset", async () => {
  const { Probe, harness, status } = createHarness();
  const screen = await render(<Probe streamKey="alpha" />);
  await expect.poll(() => harness.opens).toBe(1);

  harness.fire("decode-failed");
  await expect
    .poll(() => status.current)
    .toEqual({
      kind: "error",
      message: "the stream disconnected",
    });
  expect(harness.resets).toBe(1);

  await screen.unmount();
});

it("closes the source and drops decoder state when the stream goes away", async () => {
  const { Probe, harness, seen, status } = createHarness();
  const screen = await render(<Probe streamKey="alpha" />);
  await expect.poll(() => harness.opens).toBe(1);

  harness.frame(1);
  await expect.poll(() => status.current.kind).toBe("streaming");

  await screen.rerender(<Probe streamKey={null} />);
  await expect.poll(() => status.current.kind).toBe("idle");
  expect(harness.closes).toBe(1);
  expect(harness.resets).toBe(1);

  // A message that raced the teardown must not paint over the next stream.
  harness.frame(2);
  expect(seen).toEqual([1]);

  await screen.unmount();
});
