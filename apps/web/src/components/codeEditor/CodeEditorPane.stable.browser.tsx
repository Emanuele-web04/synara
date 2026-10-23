// Stable edits with the Pierre engine: the same pane props mount Pierre's
// contenteditable, report edits and history, and honour the save chord.
import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, useState } from "react";
import { page, userEvent } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { CodeEditHistoryControls, CodeEditHistoryState } from "./codeEditHistory";

vi.mock("~/betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/betaFeatures")>()),
  CODE_EDITOR_ENGINE: "pierre",
  NATIVE_EDITOR_ON: false,
}));

const { CodeEditorPane } = await import("./CodeEditorPane");
const { CodeDiffEditorPane } = await import("./CodeDiffEditorPane");

function Harness(props: {
  diff: boolean;
  onHistoryChange: (history: CodeEditHistoryState) => void;
}) {
  const [value, setValue] = useState("const value = 1;\n");
  const [saved, setSaved] = useState(0);
  const [controls] = useState(() => createRef<CodeEditHistoryControls>());
  const common = {
    fileName: "sample.ts",
    resolvedTheme: "dark" as const,
    onChange: setValue,
    onSave: () => setSaved((n) => n + 1),
    historyControlsRef: controls,
    onHistoryChange: props.onHistoryChange,
  };
  return (
    <div style={{ width: 900, height: 400, display: "flex", flexDirection: "column" }}>
      <button onClick={() => controls.current?.undo()}>Undo</button>
      <output hidden data-testid="buffer">
        {value}
      </output>
      <output hidden data-testid="saved">
        {saved}
      </output>
      {props.diff ? (
        <CodeDiffEditorPane
          {...common}
          original="const value = 0;\n"
          modified={value}
          modifiedVersion={0}
          renderSideBySide
        />
      ) : (
        <CodeEditorPane {...common} value={value} valueVersion={0} />
      )}
    </div>
  );
}

it.each([false, true])(
  "mounts the Pierre engine and edits through the shared props (diff: %s)",
  async (diff) => {
    await page.viewport(1200, 800);
    const historyChanged = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const view = await render(
      <QueryClientProvider client={client}>
        <Harness diff={diff} onHistoryChange={historyChanged} />
      </QueryClientProvider>,
    );
    // Pierre renders a web component; the native engine would render .monaco-editor.
    await expect.poll(() => document.querySelector("diffs-container")).not.toBeNull();
    expect(document.querySelector(".monaco-editor")).toBeNull();
    const textbox = page.getByRole("textbox");
    await textbox.click({ position: { x: 15, y: 5 } });
    await expect.poll(() => historyChanged.mock.calls.length).toBeGreaterThan(0);
    await userEvent.keyboard("{End}abc");
    await expect.poll(() => page.getByTestId("buffer").element().textContent).toContain("abc");
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect
      .poll(() => page.getByTestId("buffer").element().textContent)
      .toBe("const value = 1;\n");
    expect(historyChanged).toHaveBeenLastCalledWith({ canUndo: false, canRedo: true });
    await textbox.click({ position: { x: 15, y: 5 } });
    await userEvent.keyboard("{ControlOrMeta>}s{/ControlOrMeta}");
    await expect.poll(() => page.getByTestId("saved").element().textContent).toBe("1");
    await view.unmount();
  },
);
