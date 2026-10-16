import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";
import {
  EMPTY_EXTENSION_CONTRIBUTIONS,
  ExtensionContributions,
  type ExtensionContributionsSnapshot,
} from "./extensionContributions";
import { EditorExtensionContributions } from "./EditorExtensionContributions";
import type { EditorActionRow } from "./EditorActionPicker";

afterEach(async () => {
  await cleanup();
});
it("renders only live native contributions and sends explicit cancellation", async () => {
  let snapshot: ExtensionContributionsSnapshot = EMPTY_EXTENSION_CONTRIBUTIONS;
  const invoke = vi
    .fn<(_method: "tree" | "ui", _params: Record<string, unknown>) => Promise<unknown>>()
    .mockResolvedValue(true);
  const controller = new ExtensionContributions(invoke, (next) => {
    snapshot = next;
  });
  controller.consume("progress.start", {
    handle: 3,
    options: { title: "Indexing language", cancellable: true },
  });
  controller.consume("progress.report", {
    handle: 3,
    step: { message: "Checking documents", increment: 40 },
  });
  expect(snapshot.progress[0]).toMatchObject({ value: 40, message: "Checking documents" });
  await render(
    <EditorExtensionContributions
      snapshot={snapshot}
      controller={controller}
      onError={(error) => {
        throw error;
      }}
    />,
  );
  await expect.element(page.getByRole("progressbar", { name: "Indexing language" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(invoke).toHaveBeenCalledWith("ui", { operation: "cancelProgress", handle: 3 });
  controller.consume("progress.end", { handle: 3 });
  expect(snapshot.progress).toEqual([]);
  controller.clear();
  expect(snapshot).toEqual(EMPTY_EXTENSION_CONTRIBUTIONS);
});

it("navigates a real-shaped tree contribution through native list rows", async () => {
  let rows: EditorActionRow[] = [];
  const invoke = vi.fn(
    async (_method: "tree" | "ui", params: Record<string, unknown>): Promise<unknown> => {
      if (params.operation === "list") return [{ id: "example.tree", name: "Example tree" }];
      if (params.operation === "children")
        return params.parent
          ? [{ handle: "child", label: "Run item", actionable: true }]
          : [{ handle: "parent", label: "Group", children: true }];
      return true;
    },
  );
  const controller = new ExtensionContributions(invoke, () => undefined);
  const show = (_title: string, next: EditorActionRow[]) => {
    rows = next;
  };
  await controller.views(show);
  await rows[0]!.run();
  expect(rows.map((row) => row.label)).toEqual(["Back to extension views", "Group"]);
  await rows[1]!.run();
  expect(rows.map((row) => row.label)).toEqual(["Back to parent", "Run item"]);
  await rows[1]!.run();
  expect(invoke).toHaveBeenLastCalledWith("tree", {
    operation: "choose",
    id: "example.tree",
    handle: "child",
  });
});
