import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { type ComponentProps, useState } from "react";
import { render } from "vitest-browser-react";

import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import type { SidebarSearchThread } from "./SidebarSearchPalette.logic";
import type { ThreadImportTarget } from "../lib/threadImport";

const searchThreads = vi.hoisted(() => vi.fn());
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({ orchestration: { searchThreads } }),
}));

const thread: SidebarSearchThread = {
  id: "thread-1",
  title: "Fix login flow",
  projectId: "project-1",
  projectName: "Dashboard",
  projectRemoteName: "acme/control-panel",
  spaceName: "Client work",
  provider: "codex",
  branch: null,
  createdAt: "2026-09-16T12:00:00Z",
  messages: [{ text: "Check the expired session token" }],
};

async function renderPalette(
  searchThread: SidebarSearchThread = thread,
  overrides: Partial<ComponentProps<typeof SidebarSearchPalette>> = {},
) {
  const onOpenThread = vi.fn();
  const onOpenSettings = vi.fn();
  const onOpenChange = vi.fn();
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarSearchPalette
        open
        mode="search"
        onModeChange={vi.fn()}
        onOpenChange={onOpenChange}
        actions={[]}
        projects={[]}
        threads={[searchThread]}
        onCreateChat={vi.fn()}
        onCreateThread={vi.fn()}
        onAddProjectPath={vi.fn().mockResolvedValue(undefined)}
        homeDir={null}
        onOpenSettings={onOpenSettings}
        onOpenFeedback={vi.fn()}
        onOpenUsageSettings={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenThread={onOpenThread}
        importTargets={[]}
        onImportThread={vi.fn().mockResolvedValue(undefined)}
        onImportProjects={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { onOpenThread, onOpenSettings, onOpenChange };
}

it("searches settings and opens the matching section and row", async () => {
  const { onOpenSettings, onOpenChange } = await renderPalette();
  await page.getByPlaceholder("Search chats or run a command").fill("base font size");
  const result = page.getByRole("option", { name: /Base font size/ });
  await expect.element(result).toHaveTextContent("Appearance");
  await userEvent.keyboard("{Enter}");
  expect(onOpenSettings).toHaveBeenCalledWith("appearance", { target: "setting-base-font-size" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("opens panel-only settings without inventing an anchor", async () => {
  const { onOpenSettings } = await renderPalette();
  await page.getByPlaceholder("Search chats or run a command").fill("keybindings");
  await page.getByRole("option", { name: "Keybindings Keybindings", exact: true }).click();
  expect(onOpenSettings).toHaveBeenCalledWith("shortcuts", undefined);
});

it("announces no results when nothing matches", async () => {
  await renderPalette();
  await page.getByPlaceholder("Search chats or run a command").fill("zzzzunmatchedzzzz");
  await expect.element(page.getByRole("status")).toHaveTextContent("No results");
  expect(page.getByRole("option").length).toBe(0);
});

it("runs a space command and closes the palette", async () => {
  const run = vi.fn();
  const { onOpenChange } = await renderPalette(thread, {
    actions: [
      {
        id: "switch-space-work",
        label: "Switch to Work",
        description: "Switch space",
        requiresQuery: true,
        run,
      },
    ],
  });
  expect(page.getByRole("option", { name: "Switch to Work" }).length).toBe(0);
  await page.getByPlaceholder("Search chats or run a command").fill("work");
  await page.getByRole("option", { name: "Switch to Work" }).click();
  expect(run).toHaveBeenCalledOnce();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it.each(["control-panel", "Client work"])(
  "explains a thread found by project or space metadata: %s",
  async (query) => {
    const { onOpenThread } = await renderPalette();
    await page.getByPlaceholder("Search chats or run a command").fill(query);

    const result = page.getByRole("option", { name: /Fix login flow/ });
    await expect.element(result).toBeVisible();
    await expect.element(result).toHaveTextContent("Project match");
    // These matches have no message snippet. The matching metadata must still
    // be shown and highlighted instead of returning an unexplained chat title.
    await expect.element(result).toHaveTextContent(query);
    const highlighted = result.element().querySelectorAll("mark");
    expect(Array.from(highlighted, (mark) => mark.textContent).join(" ")).toContain(query);
    await result.click();
    expect(onOpenThread).toHaveBeenCalledWith(thread.id);
  },
);

it("keeps recent and title matches compact, while retaining message snippets", async () => {
  await renderPalette();
  const result = page.getByRole("option", { name: /Fix login flow/ });
  await expect.element(result).toBeVisible();
  await expect.element(result).not.toHaveTextContent(thread.spaceName);
  await expect.element(result).not.toHaveTextContent("Project match");

  const input = page.getByPlaceholder("Search chats or run a command");
  await input.fill("login");
  await expect.element(result).not.toHaveTextContent(thread.spaceName);
  await input.fill("expired");
  await expect.element(result).toHaveTextContent("Check the expired session token");
  await expect.element(result).toHaveTextContent("Chat match");
});

it("finds a thread through server message hits when its messages are not loaded", async () => {
  searchThreads.mockResolvedValue({
    matches: [
      {
        threadId: thread.id,
        excerpt: "The refund webhook retries three times before giving up.",
        matchCount: 2,
      },
    ],
  });
  const { onOpenThread } = await renderPalette({ ...thread, messages: [] });
  await page.getByPlaceholder("Search chats or run a command").fill("webhook retries");

  const result = page.getByRole("option", { name: /Fix login flow/ });
  await expect.element(result).toHaveTextContent("refund webhook retries three times");
  await expect.element(result).toHaveTextContent("2 chat hits");
  expect(searchThreads).toHaveBeenCalledWith({ query: "webhook retries", limit: 50 });
  await result.click();
  expect(onOpenThread).toHaveBeenCalledWith(thread.id);
});

it("shows only unique matching metadata so a space match is not buried behind project names", async () => {
  await renderPalette({ ...thread, projectRemoteName: thread.projectName });
  const input = page.getByPlaceholder("Search chats or run a command");
  await input.fill("Dashboard");
  const result = page.getByRole("option", { name: /Fix login flow/ });
  await expect.element(result).toHaveTextContent("Project match");
  // One occurrence in the compact header, one highlighted match explanation.
  expect(result.element().textContent?.match(/Dashboard/g)).toHaveLength(2);
  await expect.element(result).not.toHaveTextContent(thread.spaceName);
  await input.fill("  cLiEnT   work  ");
  await expect.element(result).toHaveTextContent("Client work");
  expect(result.element().textContent?.match(/Dashboard/g)).toHaveLength(1);
});

it("opens a source page for importing projects and hands the chosen source to the caller", async () => {
  const onImportProjects = vi.fn();
  const onOpenChange = vi.fn();
  function StatefulPalette() {
    const [mode, setMode] = useState<SidebarSearchPaletteMode>("search");
    return (
      <QueryClientProvider client={new QueryClient()}>
        <SidebarSearchPalette
          open
          mode={mode}
          onModeChange={setMode}
          onOpenChange={onOpenChange}
          actions={[
            {
              id: "import-projects",
              label: "Import projects from…",
              description: "Bring Codex and Claude Code projects into Synara.",
              keywords: ["import"],
            },
          ]}
          projects={[]}
          threads={[]}
          onCreateChat={vi.fn()}
          onCreateThread={vi.fn()}
          onAddProjectPath={vi.fn().mockResolvedValue(undefined)}
          homeDir={null}
          onOpenSettings={vi.fn()}
          onOpenFeedback={vi.fn()}
          onOpenUsageSettings={vi.fn()}
          onOpenProject={vi.fn()}
          onOpenThread={vi.fn()}
          importTargets={[]}
          onImportThread={vi.fn().mockResolvedValue(undefined)}
          onImportProjects={onImportProjects}
        />
      </QueryClientProvider>
    );
  }
  await render(<StatefulPalette />);

  await page.getByRole("option", { name: "Import projects from…" }).click();
  // Entering the page must not close the palette or start an import yet.
  expect(onOpenChange).not.toHaveBeenCalled();
  await expect.element(page.getByPlaceholder("Import projects from…")).toBeVisible();
  await expect.element(page.getByRole("option", { name: "From Codex", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "From Claude Code and Codex" }))
    .toBeVisible();

  await page.getByRole("option", { name: "From Claude Code", exact: true }).click();
  expect(onImportProjects).toHaveBeenCalledWith(["claudeAgent"]);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

// Import targets must stay readable when several provider accounts share a
// narrow command palette.
const MANY_IMPORT_TARGETS = [
  { provider: "codex", instanceId: "codex", label: "Personal Codex" },
  { provider: "codex", instanceId: "codex_work", label: "Work Codex" },
  { provider: "codex", instanceId: "codex_client", label: "Client Codex" },
  { provider: "claudeAgent", instanceId: "claudeAgent", label: "Personal Claude" },
  { provider: "claudeAgent", instanceId: "claude_work", label: "Work Claude" },
  { provider: "cursor", instanceId: "cursor", label: "Default Cursor" },
  { provider: "droid", instanceId: "droid", label: "Default Droid" },
  { provider: "opencode", instanceId: "opencode_work", label: "Work OpenCode" },
] as const satisfies ReadonlyArray<ThreadImportTarget>;

const IMPORT_TARGET_VIEWPORTS = [
  { width: 320, height: 700, expectedColumns: 1 },
  { width: 800, height: 700, expectedColumns: 2 },
] as const;

describe("SidebarSearchPalette import targets", () => {
  for (const viewport of IMPORT_TARGET_VIEWPORTS) {
    it(`keeps many account identities usable at ${viewport.width}px`, async () => {
      await page.viewport(viewport.width, viewport.height);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const screen = await render(
        <QueryClientProvider client={queryClient}>
          <SidebarSearchPalette
            open
            mode="import"
            onModeChange={vi.fn()}
            onOpenChange={vi.fn()}
            actions={[]}
            projects={[]}
            threads={[]}
            onCreateChat={vi.fn()}
            onCreateThread={vi.fn()}
            onAddProjectPath={async () => {}}
            homeDir={null}
            onOpenSettings={vi.fn()}
            onOpenFeedback={vi.fn()}
            onOpenUsageSettings={vi.fn()}
            onOpenProject={vi.fn()}
            onOpenThread={vi.fn()}
            importTargets={MANY_IMPORT_TARGETS}
            onImportThread={vi.fn()}
            onImportProjects={vi.fn()}
          />
        </QueryClientProvider>,
      );

      try {
        const targetGroup = page.getByRole("radiogroup", { name: "Provider account" });
        await expect.element(targetGroup).toBeInTheDocument();
        expect(page.getByRole("radio").length).toBe(MANY_IMPORT_TARGETS.length);
        for (const label of ["Personal Codex", "Work Claude", "Work OpenCode"]) {
          await expect.element(page.getByText(label, { exact: true })).toBeInTheDocument();
        }

        const groupElement = targetGroup.element();
        const groupRect = groupElement.getBoundingClientRect();
        const gridTrackWidths = getComputedStyle(groupElement)
          .gridTemplateColumns.split(" ")
          .map((track) => Number.parseFloat(track));
        expect(gridTrackWidths).toHaveLength(viewport.expectedColumns);
        expect(groupElement.scrollWidth).toBeLessThanOrEqual(groupElement.clientWidth + 1);
        expect(groupElement.scrollHeight).toBeGreaterThan(groupElement.clientHeight);
        const options = groupElement.querySelectorAll<HTMLElement>("[role='radio']");
        for (const [index, option] of Array.from(options).entries()) {
          const optionRect = option.getBoundingClientRect();
          const trackWidth = gridTrackWidths[index % viewport.expectedColumns];
          if (trackWidth === undefined) {
            throw new Error("Missing computed import-target grid track");
          }
          expect(Math.abs(optionRect.width - trackWidth)).toBeLessThanOrEqual(1);
          expect(optionRect.height).toBeGreaterThanOrEqual(44);
          expect(optionRect.left).toBeGreaterThanOrEqual(groupRect.left - 1);
          expect(optionRect.right).toBeLessThanOrEqual(groupRect.right + 1);
        }

        const workCodex = page.getByRole("radio", { name: /Work Codex.*Codex/ });
        const workOpenCode = page.getByRole("radio", { name: /Work OpenCode.*OpenCode/ });
        await workCodex.click();
        await expect.element(workCodex).toHaveAttribute("aria-checked", "true");
        await workOpenCode.click();
        await expect.element(workOpenCode).toHaveAttribute("aria-checked", "true");
        await expect.element(workCodex).toHaveAttribute("aria-checked", "false");
      } finally {
        await screen.unmount();
        queryClient.clear();
        await page.viewport(1280, 720);
      }
    });
  }
});
