import { afterEach, expect, it, vi } from "vitest";
import { observeUserMessageOverflow } from "./userMessageOverflowObserver";

afterEach(() => vi.unstubAllGlobals());

it("shares the observer and coalesces natural content heights without layout reads", () => {
  let deliver: ResizeObserverCallback | undefined;
  let frame: FrameRequestCallback | undefined;
  let observers = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        deliver = callback;
        observers++;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {
    frame = undefined;
  });
  const element = {
    get scrollHeight() {
      throw new Error("Forced layout");
    },
  } as unknown as HTMLElement;
  const other = {} as HTMLElement;
  const heights: number[] = [];
  const stop = observeUserMessageOverflow(element, (height) => heights.push(height));
  const stopOther = observeUserMessageOverflow(other, () => {});
  const resize = (height: number) =>
    deliver!(
      [
        {
          target: element,
          contentRect: {
            x: 0,
            y: 0,
            top: 0,
            bottom: height,
            left: 0,
            right: 1,
            width: 1,
            height,
            toJSON: () => ({ height }),
          },
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        },
      ],
      {} as ResizeObserver,
    );
  expect(observers).toBe(1);
  expect(heights).toEqual([]);
  resize(400);
  resize(600);
  frame!(0);
  expect(heights).toEqual([600]);
  resize(100);
  frame!(0);
  expect(heights).toEqual([600, 100]);
  resize(900);
  stop();
  frame!(0);
  expect(heights).toEqual([600, 100]);
  stopOther();
});
