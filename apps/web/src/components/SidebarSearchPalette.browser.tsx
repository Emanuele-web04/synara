import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import type { SidebarSearchProject, SidebarSearchThread } from "./SidebarSearchPalette.logic";
import type { ThreadImportTarget } from "../lib/threadImport";

const thread: SidebarSearchThread = {
  id: "thread-1",
  title: "Fix login flow",
  projectId: "project-1",
  projectName: "Dashboard",
  projectRemoteName: "acme/control-panel",
  spaceName: "Client work",
  provider: "codex",
  createdAt: "2026-09-16T12:00:00Z",
  messages: [{ text: "Check the expired session token" }],
};

async function renderPalette(
  searchThread: SidebarSearchThread = thread,
  options: { threads?: SidebarSearchThread[]; projects?: SidebarSearchProject[] } = {},
) {
  const onOpenThread = vi.fn();
  const onOpenProject = vi.fn();
  const onOpenChange = vi.fn();
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarSearchPalette
        open
        mode="search"
        onModeChange={vi.fn()}
        onOpenChange={onOpenChange}
        actions={[]}
        projects={options.projects ?? []}
        threads={options.threads ?? [searchThread]}
        onCreateChat={vi.fn()}
        onCreateThread={vi.fn()}
        onAddProjectPath={vi.fn().mockResolvedValue(undefined)}
        homeDir={null}
        onOpenSettings={vi.fn()}
        onOpenFeedback={vi.fn()}
        onOpenUsageSettings={vi.fn()}
        onOpenProject={onOpenProject}
        onOpenThread={onOpenThread}
        importTargets={[]}
        onImportThread={vi.fn().mockResolvedValue(undefined)}
        onImportProjects={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onOpenThread, onOpenProject, onOpenChange };
}

const project: SidebarSearchProject = {
  id: thread.projectId,
  name: thread.projectName,
  remoteName: thread.projectRemoteName,
  folderName: "dashboard",
  localName: null,
  cwd: "/work/dashboard",
  spaceName: "",
};
const remoteHost = { environmentId: "mini", name: "Mac mini" };

it.each(["thread", "project"] as const)(
  "keeps colliding %s IDs on different computers independently selectable",
  async (kind) => {
    const callbacks = await renderPalette(thread, {
      threads: kind === "thread" ? [thread, { ...thread, host: remoteHost, messages: [] }] : [],
      projects: kind === "project" ? [project, { ...project, host: remoteHost }] : [],
    });
    await page
      .getByPlaceholder("Search chats or run a command")
      .fill(kind === "thread" ? "login" : "dashboard");
    const title = kind === "thread" ? thread.title : project.name;
    const results = page.getByRole("option", { name: new RegExp(title) });
    await expect.poll(() => results.elements()).toHaveLength(2);
    await page.getByRole("option", { name: new RegExp(`${title}.*Mac mini`) }).click();
    const onOpen = kind === "thread" ? callbacks.onOpenThread : callbacks.onOpenProject;
    const id = kind === "thread" ? thread.id : project.id;
    expect(onOpen).toHaveBeenLastCalledWith(id, remoteHost);
    await results.nth(0).click();
    expect(onOpen).toHaveBeenLastCalledWith(id);
  },
);

it("finds a computer by name and opens its thread with the keyboard", async () => {
  const { onOpenThread } = await renderPalette({ ...thread, host: remoteHost, messages: [] });
  await page.getByPlaceholder("Search chats or run a command").fill("mac mini");
  await expect
    .element(page.getByRole("option", { name: /Fix login flow.*Mac mini/ }))
    .toHaveTextContent("Computer match");
  await userEvent.keyboard("{Enter}");
  expect(onOpenThread).toHaveBeenCalledWith(thread.id, remoteHost);
});

it("keeps unavailable remote results visible without opening or dismissing the palette", async () => {
  const host = { ...remoteHost, unavailable: true };
  const { onOpenThread, onOpenProject, onOpenChange } = await renderPalette(thread, {
    threads: [{ ...thread, host, messages: [] }],
    projects: [{ ...project, host }],
  });
  await page.getByPlaceholder("Search chats or run a command").fill("mac mini");
  const unavailable = page.getByRole("option", { name: /Mac mini.*Unavailable/ });
  await expect.poll(() => unavailable.elements()).toHaveLength(2);
  for (const result of unavailable.elements()) {
    expect(result).toHaveAttribute("aria-disabled", "true");
    result.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  await userEvent.keyboard("{Enter}");
  expect(onOpenThread).not.toHaveBeenCalled();
  expect(onOpenProject).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
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
