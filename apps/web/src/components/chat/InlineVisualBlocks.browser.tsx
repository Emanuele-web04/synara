import "../../index.css";

import { type InlineVisualSpec, type NativeApi, ThreadId } from "@synara/contracts";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { InlineVisualBlocks } from "./InlineVisualBlocks";

const THREAD_ID = ThreadId.makeUnsafe("thread-visual-blocks");
let visualCount = 0;

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function mountBlocks(
  source: InlineVisualSpec | string,
  onSendChoice = vi.fn(),
  failure?: unknown,
) {
  // A fresh id per mount: reader state is kept per visual across remounts.
  visualCount += 1;
  const visualId = `vis_${String(visualCount).padStart(32, "0")}`;
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => {
        if (failure !== undefined) throw failure;
        return {
          visualId,
          html: typeof source === "string" ? source : JSON.stringify(source),
        };
      }),
    },
  } as unknown as NativeApi);
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <div style={{ width: 640 }}>
        <InlineVisualBlocks
          threadId={THREAD_ID}
          visual={{
            visualId,
            format: "components",
            title: "Test visual",
            height: 200,
            byteLength: 10,
            sha256: "a".repeat(64),
          }}
          actions={{ cwd: undefined, onSendChoice }}
        />
      </div>
    </QueryClientProvider>,
  );
  cleanup = async () => {
    await screen.unmount();
    client.clear();
  };
  return { screen, onSendChoice };
}

it("recomputes calculator outputs as the reader edits an input", async () => {
  const { screen } = await mountBlocks({
    blocks: [
      {
        type: "calculator",
        inputs: [
          { id: "total", label: "Bill", value: 90 },
          { id: "people", label: "People", value: 3 },
        ],
        outputs: [
          { id: "each", label: "Each", formula: "total / people", prefix: "$", decimals: 2 },
          { label: "Each with tip", formula: "each * 1.1", prefix: "$", decimals: 2 },
        ],
      },
    ],
  });
  await expect.element(screen.getByText("$30.00")).toBeVisible();
  await expect.element(screen.getByText("$33.00")).toBeVisible();

  const people = screen.getByLabelText("People");
  await userEvent.clear(people);
  await userEvent.type(people, "4");

  await expect.element(screen.getByText("$22.50")).toBeVisible();
  await expect.element(screen.getByText("$24.75")).toBeVisible();
});

it("draws a before/after bar as one item with its change", async () => {
  const { screen } = await mountBlocks({
    blocks: [
      {
        type: "bar-chart",
        unit: "ms",
        baselineLabel: "Prima",
        valueLabel: "Dopo",
        better: "lower",
        items: [
          { label: "Cold open", value: 279, baseline: 329 },
          { label: "Scripting", value: 674, baseline: 459 },
        ],
      },
    ],
  });
  await expect.element(screen.getByText("Prima")).toBeVisible();
  const change = (label: string) =>
    [...document.querySelectorAll('[role="listitem"]')]
      .find((item) => item.textContent?.startsWith(label))!
      .textContent?.replace(/\s+/g, " ");
  expect(change("Cold open")).toContain("329 → 279 ms");
  expect(change("Cold open")).toContain("-15%");
  expect(change("Scripting")).toContain("+47%");
});

it("sends one follow-up choice and then holds the others", async () => {
  const { screen, onSendChoice } = await mountBlocks({
    blocks: [
      {
        type: "choices",
        options: [
          { label: "Fix it now", message: "Please fix the regression now." },
          { label: "Explain more" },
        ],
      },
    ],
  });

  await screen.getByRole("button", { name: /Fix it now/ }).click();

  expect(onSendChoice).toHaveBeenCalledExactlyOnceWith("Please fix the regression now.");
  await expect.element(screen.getByRole("button", { name: /Explain more/ })).toBeDisabled();
});

it("switches tabs and sorts a table by a numeric column", async () => {
  const { screen } = await mountBlocks({
    blocks: [
      {
        type: "tabs",
        tabs: [
          {
            label: "Sizes",
            blocks: [
              {
                type: "table",
                columns: [{ label: "Package" }, { label: "KB", format: "number" }],
                rows: [
                  ["shared", 402],
                  ["web", 1840],
                  ["server", 1120],
                ],
              },
            ],
          },
          { label: "Notes", blocks: [{ type: "markdown", text: "Shiki is the biggest." }] },
        ],
      },
    ],
  });
  const firstColumn = () =>
    [...document.querySelectorAll("tbody tr td:first-child")].map((cell) => cell.textContent);
  await expect.element(screen.getByText("shared")).toBeVisible();
  expect(firstColumn()).toEqual(["shared", "web", "server"]);

  await screen.getByRole("button", { name: "KB" }).click();
  expect(firstColumn()).toEqual(["web", "server", "shared"]);

  await screen.getByRole("radio", { name: "Notes" }).click();
  await expect.element(screen.getByText("Shiki is the biggest.")).toBeVisible();
  expect(document.querySelector("table")).toBeNull();
});

it("says so when the stored spec is not one this client can draw", async () => {
  const { screen } = await mountBlocks(JSON.stringify({ blocks: [{ type: "hologram" }] }));
  await expect.element(screen.getByText("This visual needs a newer Synara.")).toBeVisible();
});

it("consumes a choice synchronously even if two clicks arrive before React renders", async () => {
  const { screen, onSendChoice } = await mountBlocks({
    blocks: [{ type: "choices", options: [{ label: "Continue" }, { label: "Wait" }] }],
  });
  await expect.element(screen.getByRole("button", { name: /Continue/ })).toBeVisible();
  const button = screen.getByRole("button", { name: /Continue/ }).element() as HTMLButtonElement;
  await act(() => {
    button.click();
    button.click();
  });
  expect(onSendChoice).toHaveBeenCalledExactlyOnceWith("Continue");
});

it("does not offer retry for a permanently missing component document", async () => {
  const { screen } = await mountBlocks(
    { blocks: [{ type: "markdown", text: "Unavailable" }] },
    vi.fn(),
    { message: "missing", retryable: false },
  );
  await expect.element(screen.getByText("Visual unavailable.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Retry" }).query()).toBeNull();
});

it("draws losses to the left and gains to the right of the zero axis", async () => {
  const { screen } = await mountBlocks({
    blocks: [
      {
        type: "bar-chart",
        items: [
          { label: "Loss", value: -100 },
          { label: "Gain", value: 100 },
        ],
      },
    ],
  });
  await expect.element(screen.getByText("Loss", { exact: true })).toBeVisible();
  const rows = screen.getByRole("listitem").elements();
  const loss = rows[0]!.querySelector<HTMLElement>('span[style*="width"]')!.getBoundingClientRect();
  const gain = rows[1]!.querySelector<HTMLElement>('span[style*="width"]')!.getBoundingClientRect();
  expect(gain.left).toBeCloseTo(loss.right, 1);
});
