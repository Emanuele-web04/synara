import "../../index.css";
import { useRef } from "react";
import { QueryClient } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { usePreviewEditorHandoff, takeEditorView } from "./editorViewHandoff";

const client = new QueryClient();
afterEach(async () => {
  await cleanup();
  client.clear();
});
function Preview({
  filePath = "a.ts",
  load,
  edit,
}: {
  filePath?: string;
  load: () => Promise<unknown>;
  edit: (path: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const handoff = usePreviewEditorHandoff({
    client,
    cwd: "/repo",
    filePath,
    contents: "unchanged",
    enabled: true,
    container,
    load,
    onEdit: edit,
  });
  return (
    <div>
      <button onClick={handoff.begin}>
        {handoff.preparing ? "Cancel opening editor" : "Edit file"}
      </button>
      <div ref={container} style={{ height: 180, overflow: "auto", lineHeight: "20px" }}>
        <pre>
          <code>
            {Array.from({ length: 80 }, (_, index) => (
              <span key={index} className="line">{`unchanged ${index}\n`}</span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
it("retains readable content until the module is ready and permits cancellation", async () => {
  let finish!: () => void;
  const load = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const edit = vi.fn();
  await render(<Preview load={load} edit={edit} />);
  await page.getByRole("button", { name: "Edit file" }).click();
  await expect.element(page.getByRole("button", { name: "Cancel opening editor" })).toBeVisible();
  expect(document.querySelector("pre")?.textContent).toContain("unchanged 0");
  expect(edit).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Cancel opening editor" }).click();
  finish();
  await Promise.resolve();
  expect(edit).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Edit file" }).click();
  finish();
  await expect.poll(() => edit.mock.calls).toEqual([["a.ts"]]);
  expect(takeEditorView(client, "/repo", "a.ts", "editor")?.lineNumber).toBe(1);
});
it("does not navigate from a stale import after the owning preview unmounts", async () => {
  let finish!: () => void;
  const edit = vi.fn();
  await render(
    <Preview
      load={() =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
      }
      edit={edit}
    />,
  );
  await page.getByRole("button", { name: "Edit file" }).click();
  await cleanup();
  finish();
  await Promise.resolve();
  expect(edit).not.toHaveBeenCalled();
});
