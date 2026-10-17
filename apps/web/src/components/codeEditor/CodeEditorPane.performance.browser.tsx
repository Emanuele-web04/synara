// Opt-in Chromium component benchmark for editor commands, paint latency and React state churn.
// Run with VITE_EDITOR_BENCHMARK=1 and test:browser; writes node_modules/.cache/editor-performance.json.
import "../../index.css";
import { monaco } from "./editorRuntime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Profiler, createRef, useState } from "react";
import { expect, it } from "vitest";
import { server } from "vitest/browser";
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

it.runIf(import.meta.env.VITE_EDITOR_BENCHMARK === "1")(
  "measures warm editor commands without conflating them with keyboard transport",
  async () => {
    const reports = [];
    document.documentElement.classList.add("dark");
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
              await expect
                .poll(() =>
                  monaco.editor
                    .getEditors()
                    .some((item) => item.getModel()?.uri.scheme === "synara-standalone"),
                )
                .toBe(true);
              const editor = monaco.editor
                .getEditors()
                .find((item) => item.getModel()?.uri.scheme === "synara-standalone")!;
              editor.setPosition({ lineNumber: 1, column: 1 });
              editor.focus();
              await frame();
              await frame();
              for (const text of ["x", "\n"]) {
                const times: number[] = [];
                const frameTimes: number[] = [];
                historyEvents = 0;
                commits.length = 0;
                const count = text === "x" ? 20 : 5;
                for (let index = 0; index < count; index++) {
                  const started = performance.now();
                  editor.trigger("benchmark", "type", { text });
                  times.push(performance.now() - started);
                  await frame();
                  await frame();
                  frameTimes.push(performance.now() - started);
                }
                reports.push({
                  mode,
                  lines,
                  sample,
                  command: text === "x" ? "type" : "newline",
                  count,
                  commandMedianMs: percentile(times, 0.5),
                  commandP95Ms: percentile(times, 0.95),
                  twoFrameMedianMs: percentile(frameTimes, 0.5),
                  twoFrameP95Ms: percentile(frameTimes, 0.95),
                  renderedRows: editor.getDomNode()?.querySelectorAll(".view-line").length ?? 0,
                  reactMs: commits.reduce((sum, duration) => sum + duration, 0),
                  commits: commits.length,
                  historyEvents,
                });
              }
              expect(editor.getModel()?.getValue(), JSON.stringify(reports)).toContain(
                "x".repeat(20),
              );
              expect(editor.getModel()?.getValue()).toContain(`const value${lines - 1} = 1;`);
              expect(editor.getDomNode()?.querySelectorAll(".view-line").length).toBeLessThan(250);
            } finally {
              await view.unmount();
              client.clear();
            }
          }
        }
      }
      await server.commands.writeFile(
        "./node_modules/.cache/editor-performance.json",
        JSON.stringify(reports, null, 2),
      );
    } finally {
      document.documentElement.classList.remove("dark");
    }
  },
);
