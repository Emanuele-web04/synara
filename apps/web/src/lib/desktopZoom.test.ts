import { afterEach, expect, it, vi } from "vitest";
import { readDesktopZoomFactor, subscribeDesktopZoomFactor } from "./desktopZoom";

afterEach(() => vi.unstubAllGlobals());

it("follows controller zoom changes in a workspace without native APIs", () => {
  let zoomFactor = 1.25;
  const listeners = new Set<(zoomFactor: number) => void>();
  vi.stubGlobal("window", {
    frameElement: {
      synaraWorkspace: {
        controller: {
          presentation: {
            readZoomFactor: () => zoomFactor,
            subscribeZoomFactor: (listener: (zoomFactor: number) => void) => {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          },
        },
      },
    },
  });
  const observed: number[] = [];
  const unsubscribe = subscribeDesktopZoomFactor((value) => observed.push(value));
  expect(readDesktopZoomFactor()).toBe(1.25);
  zoomFactor = 0.8;
  listeners.forEach((listener) => listener(zoomFactor));
  expect(readDesktopZoomFactor()).toBe(0.8);
  expect(observed).toEqual([0.8]);
  unsubscribe();
  listeners.forEach((listener) => listener(1));
  expect(observed).toEqual([0.8]);
});
