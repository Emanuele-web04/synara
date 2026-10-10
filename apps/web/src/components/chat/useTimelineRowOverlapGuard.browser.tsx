import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useTimelineRowOverlapGuard } from "./useTimelineRowOverlapGuard";

const INITIAL_ROW_HEIGHT_PX = 40;

interface HarnessHandle {
  setRowHeight: (index: number, heightPx: number) => void;
  setContainerTops: (tops: number[]) => void;
}

/**
 * Three rows in absolutely positioned containers, tops laid out for the
 * initial heights. State can grow rows or commit stale container positions;
 * only the guard can restore non-overlapping geometry.
 */
function StaleContainers({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const observeRow = useTimelineRowOverlapGuard();
  const [rowHeights, setRowHeights] = useState([
    INITIAL_ROW_HEIGHT_PX,
    INITIAL_ROW_HEIGHT_PX,
    INITIAL_ROW_HEIGHT_PX,
  ]);

  const [containerTops, setContainerTops] = useState([0, 40, 80]);

  handleRef.current = {
    setContainerTops,
    setRowHeight: (index, heightPx) => {
      setRowHeights((current) => current.map((height, at) => (at === index ? heightPx : height)));
    },
  };

  return (
    <div style={{ position: "relative", height: 400, width: 300 }}>
      {rowHeights.map((height, index) => (
        <div
          key={index}
          data-overlap-container={index}
          style={{
            position: "absolute",
            top: containerTops[index],
            left: 0,
            right: 0,
          }}
        >
          <div ref={observeRow} style={{ height }} />
        </div>
      ))}
    </div>
  );
}

function containerTop(index: number): number {
  const container = document.querySelector<HTMLElement>(`[data-overlap-container="${index}"]`);
  if (!container) throw new Error(`container ${index} not mounted`);
  return Number.parseFloat(container.style.top);
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

describe("useTimelineRowOverlapGuard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("pushes stale containers down in the frame a row grows", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<StaleContainers handleRef={handleRef} />);

    try {
      await expect.poll(() => handleRef.current != null).toBe(true);
      // Let the observer's initial delivery settle before mutating.
      await nextFrame();
      await nextFrame();

      handleRef.current!.setRowHeight(0, 100);
      // the ResizeObserver fires pre-paint in the frame the growth lays out; two frames later its corrections are unambiguously visible
      await nextFrame();
      await nextFrame();

      // Rows below the grown row cascade down to sit flush under it.
      expect(containerTop(1)).toBeCloseTo(100, 0);
      expect(containerTop(2)).toBeCloseTo(140, 0);
    } finally {
      await screen.unmount();
    }
  });

  it("repairs a late stale position commit even when row sizes no longer change", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<StaleContainers handleRef={handleRef} />);
    try {
      await nextFrame();
      await nextFrame();
      handleRef.current!.setRowHeight(0, 100);
      await expect.poll(() => containerTop(1)).toBe(100);

      // A deferred virtualizer commit can overwrite the guard's correction
      // without resizing any content, so no ResizeObserver notification follows.
      handleRef.current!.setContainerTops([0, 60, 100]);
      await nextFrame();
      await nextFrame();
      const containers = [...document.querySelectorAll<HTMLElement>("[data-overlap-container]")];
      for (let index = 1; index < containers.length; index += 1) {
        expect(containers[index]!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          containers[index - 1]!.getBoundingClientRect().bottom,
        );
      }
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a gap alone when a row shrinks", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const screen = await render(<StaleContainers handleRef={handleRef} />);

    try {
      await expect.poll(() => handleRef.current != null).toBe(true);
      await nextFrame();
      await nextFrame();

      handleRef.current!.setRowHeight(0, 10);
      await nextFrame();
      await nextFrame();

      // pulling rows up is the virtualizer's call (deferred shrink handling); the guard must not move anything
      expect(containerTop(1)).toBe(INITIAL_ROW_HEIGHT_PX);
      expect(containerTop(2)).toBe(INITIAL_ROW_HEIGHT_PX * 2);

      handleRef.current!.setRowHeight(0, 100);
      await expect.poll(() => containerTop(1)).toBe(100);
      // When the virtualizer commits a shrink and its new positions together,
      // stale cached heights must not push the correctly placed rows back down.
      handleRef.current!.setRowHeight(0, 10);
      handleRef.current!.setContainerTops([0, 10, 50]);
      await nextFrame();
      await nextFrame();
      expect(containerTop(1)).toBe(10);
      expect(containerTop(2)).toBe(50);
    } finally {
      await screen.unmount();
    }
  });
});
