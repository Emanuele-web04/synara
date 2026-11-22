import { useState } from "react";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useComputerPreviewBudgetPx } from "./useComputerPreviewBudgetPx";

const nextFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

it("re-renders only when the preview budget changes, not on every column resize", async () => {
  const renders: number[] = [];
  function Probe({ environmentInsetPx }: { environmentInsetPx: number }) {
    const [column, setColumn] = useState<HTMLDivElement | null>(null);
    renders.push(useComputerPreviewBudgetPx({ column, environmentInsetPx, size: "compact" }));
    return <div ref={setColumn} data-testid="column" style={{ width: "1400px", height: "8px" }} />;
  }
  const view = await render(<Probe environmentInsetPx={0} />);

  try {
    const column = view.getByTestId("column").element() as HTMLElement;
    await expect.poll(() => renders.at(-1)).toBe(400);
    renders.length = 0;

    // A sidebar slide: every width here leaves the compact card at its 400px cap.
    for (const width of [1300, 1150, 1000, 950]) {
      column.style.width = `${width}px`;
      await nextFrames();
    }
    expect(renders).toEqual([]);

    // Narrow enough to shrink the card, so the observer is live and the budget follows.
    column.style.width = "800px";
    await expect.poll(() => renders).toEqual([256]);

    // The docked Environment panel's inset leaves the card its 200px floor.
    await view.rerender(<Probe environmentInsetPx={312} />);
    await expect.poll(() => renders.at(-1)).toBe(200);
  } finally {
    await view.unmount();
  }
});
