// FILE: useFileLineCommenting.browser.tsx
// Purpose: Browser regressions for file-line comment state resets.
// Layer: Browser UI test

import { useState } from "react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useFileLineCommenting, type FileLineGeometry } from "./useFileLineCommenting";

const LINE: FileLineGeometry = {
  lineNumber: 7,
  top: 10,
  height: 20,
  left: 30,
  containerWidth: 400,
};

function CommentingHarness() {
  const [enabled, setEnabled] = useState(true);
  const [resetKey, setResetKey] = useState("a.ts");
  const commenting = useFileLineCommenting({ enabled, resetKey });

  return (
    <>
      <button type="button" onClick={() => commenting.openComment(LINE)}>
        Open comment
      </button>
      <button type="button" onClick={() => setEnabled((current) => !current)}>
        Toggle source
      </button>
      <button type="button" onClick={() => setResetKey("b.ts")}>
        Open B
      </button>
      <button type="button" onClick={() => setResetKey("a.ts")}>
        Open A
      </button>
      <div
        onMouseMove={commenting.onContainerMouseMove}
        onMouseLeave={commenting.onContainerMouseLeave}
      >
        <span className="line">Source line</span>
      </div>
      <output aria-label="Active comment">
        {commenting.activeLine ? `${resetKey}:${commenting.activeLine.lineNumber}` : "none"}
      </output>
      <output aria-label="Hovered line">
        {commenting.hoveredLine ? `${resetKey}:${commenting.hoveredLine.lineNumber}` : "none"}
      </output>
    </>
  );
}

describe("useFileLineCommenting", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("clears an active comment across Source→Markdown→Source", async () => {
    await render(<CommentingHarness />);

    await page.getByRole("button", { name: "Open comment" }).click();
    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("a.ts:7");

    await page.getByRole("button", { name: "Toggle source" }).click();
    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("none");
    await page.getByRole("button", { name: "Toggle source" }).click();

    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("none");
  });

  it("clears an active comment across A→B→A", async () => {
    await render(<CommentingHarness />);

    await page.getByRole("button", { name: "Open comment" }).click();
    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("a.ts:7");

    await page.getByRole("button", { name: "Open B" }).click();
    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("none");
    await page.getByRole("button", { name: "Open A" }).click();

    await expect.element(page.getByLabelText("Active comment")).toHaveTextContent("none");
  });

  it("clears a hovered line across disable and re-enable", async () => {
    await render(<CommentingHarness />);

    await page.getByText("Source line").hover();
    await expect.element(page.getByLabelText("Hovered line")).toHaveTextContent("a.ts:1");

    await page.getByRole("button", { name: "Toggle source" }).click();
    await page.getByRole("button", { name: "Toggle source" }).click();

    await expect.element(page.getByLabelText("Hovered line")).toHaveTextContent("none");
  });
});
