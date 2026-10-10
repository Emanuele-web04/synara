// Opt-in Chromium component benchmark for Pierre input work and React state churn.
// Run with VITE_PIERRE_BENCHMARK=1 and test:browser; writes node_modules/.cache/pierre-performance.json.
import "../../index.css";
import { File, FileDiff } from "@pierre/diffs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, createRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { CodeEditorPane } from "./CodeEditorPane";
import { CodeDiffEditorPane } from "./CodeDiffEditorPane";
import {
  INITIAL_CODE_EDIT_HISTORY_STATE,
  type CodeEditHistoryControls,
  type CodeEditHistoryState,
} from "./pierreEdit";

type Mode = "file" | "split" | "unified";

function Fixture({
  mode,
  initialValue,
  historyChanged,
}: {
  mode: Mode;
  initialValue: string;
  historyChanged: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [history, setHistory] = useState(INITIAL_CODE_EDIT_HISTORY_STATE);
  const [controls] = useState(() => createRef<CodeEditHistoryControls>());
  const common = {
    fileName: "benchmark.ts",
    resolvedTheme: "dark" as const,
    onChange: setValue,
    onSave: () => {},
    historyControlsRef: controls,
    onHistoryChange: (next: CodeEditHistoryState) => {
      historyChanged();
      setHistory(next);
    },
  };
  return (
    <div style={{ width: 1000, height: 600, display: "flex", flexDirection: "column" }}>
      <button disabled={!history.canUndo} onClick={() => controls.current?.undo()}>
        Undo
      </button>
      <output hidden data-testid="benchmark-buffer">
        {value}
      </output>
      {mode === "file" ? (
        <CodeEditorPane {...common} value={value} valueVersion={0} />
      ) : (
        <CodeDiffEditorPane
          {...common}
          original={initialValue.replaceAll("= 1;", "= 0;")}
          originalVersion={0}
          modified={value}
          modifiedVersion={0}
          renderSideBySide={mode === "split"}
        />
      )}
    </div>
  );
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const percentile = (values: number[], fraction: number) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;

it.runIf(import.meta.env.VITE_PIERRE_BENCHMARK === "1")("measures warm editor input", async () => {
  const reports = [];
  document.documentElement.classList.add("dark");
  const fileRender = vi.spyOn(File.prototype, "render");
  const diffRender = vi.spyOn(FileDiff.prototype, "render");
  try {
    for (const lines of [200, 1000]) {
      const initialValue =
        Array.from({ length: lines }, (_, index) => `const value${index} = 1;`).join("\n") + "\n";
      for (const mode of ["file", "split", "unified"] as const) {
        for (let sample = 0; sample < 3; sample++) {
          let historyEvents = 0;
          const commits: number[] = [];
          const client = new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
          });
          const view = await render(
            <QueryClientProvider client={client}>
              <Profiler
                id="editor"
                onRender={(_id, phase, duration) => {
                  if (phase !== "mount") commits.push(duration);
                }}
              >
                <Fixture
                  mode={mode}
                  initialValue={initialValue}
                  historyChanged={() => {
                    historyEvents++;
                  }}
                />
              </Profiler>
            </QueryClientProvider>,
          );
          try {
            await expect.element(page.getByRole("textbox")).toBeVisible();
            if (mode === "unified") {
              const content = page.getByRole("textbox").element();
              const root = content.getRootNode() as ShadowRoot;
              for (let node = root.host.parentElement; node; node = node.parentElement) {
                if (getComputedStyle(node).overflowY === "auto") {
                  node.scrollTop =
                    lines * content.querySelector("[data-line]")!.getBoundingClientRect().height;
                  break;
                }
              }
              await expect
                .poll(() =>
                  page
                    .getByRole("textbox")
                    .element()
                    .querySelector('[data-line="1"][data-line-type="change-addition"]'),
                )
                .not.toBeNull();
            }
            const firstEditableLine = page
              .getByRole("textbox")
              .element()
              .querySelector('[data-line]:not([data-line-type="change-deletion"])')!;
            await userEvent.click(firstEditableLine.querySelector("span") ?? firstEditableLine);
            await userEvent.keyboard("{Home}");
            await frame();
            await frame();
            for (const inputType of ["insertText", "insertParagraph"] as const) {
              const times: number[] = [];
              const frameTimes: number[] = [];
              historyEvents = 0;
              commits.length = 0;
              fileRender.mockClear();
              diffRender.mockClear();
              const count = inputType === "insertText" ? 20 : 5;
              for (let index = 0; index < count; index++) {
                const editor = page.getByRole("textbox").element();
                const started = performance.now();
                editor.dispatchEvent(
                  new InputEvent("beforeinput", {
                    bubbles: true,
                    composed: true,
                    cancelable: true,
                    inputType,
                    data: inputType === "insertText" ? "x" : null,
                  }),
                );
                times.push(performance.now() - started);
                await frame();
                await frame();
                frameTimes.push(performance.now() - started);
              }
              reports.push({
                mode,
                lines,
                sample,
                inputType,
                count,
                inputMedianMs: percentile(times, 0.5),
                inputP95Ms: percentile(times, 0.95),
                twoFrameMedianMs: percentile(frameTimes, 0.5),
                twoFrameP95Ms: percentile(frameTimes, 0.95),
                renderedRows: page.getByRole("textbox").element().querySelectorAll("[data-line]")
                  .length,
                reactMs: commits.reduce((sum, duration) => sum + duration, 0),
                commits: commits.length,
                historyEvents,
                renderCalls: fileRender.mock.calls.length + diffRender.mock.calls.length,
              });
            }
            expect(
              page.getByTestId("benchmark-buffer").element().textContent,
              JSON.stringify(reports),
            ).toContain("x".repeat(20));
            expect(page.getByTestId("benchmark-buffer").element().textContent).toContain(
              `const value${lines - 1} = 1;`,
            );
            await expect.element(page.getByRole("textbox")).toHaveTextContent("const value0 = 1;");
          } finally {
            await view.unmount();
            client.clear();
          }
        }
      }
    }
    await server.commands.writeFile(
      "./node_modules/.cache/pierre-performance.json",
      JSON.stringify(reports, null, 2),
    );
  } finally {
    fileRender.mockRestore();
    diffRender.mockRestore();
    document.documentElement.classList.remove("dark");
  }
});
