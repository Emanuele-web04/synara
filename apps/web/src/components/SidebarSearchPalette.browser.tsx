import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { SidebarSearchPalette, type SidebarSearchPaletteMode } from "./SidebarSearchPalette";
import type { SidebarSearchThread } from "./SidebarSearchPalette.logic";

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

async function renderPalette(searchThread: SidebarSearchThread = thread) {
  const onOpenThread = vi.fn();
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <SidebarSearchPalette
        open
        mode="search"
        onModeChange={vi.fn()}
        onOpenChange={vi.fn()}
        actions={[]}
        projects={[]}
        threads={[searchThread]}
        onCreateChat={vi.fn()}
        onCreateThread={vi.fn()}
        onAddProjectPath={vi.fn().mockResolvedValue(undefined)}
        homeDir={null}
        onOpenSettings={vi.fn()}
        onOpenFeedback={vi.fn()}
        onOpenUsageSettings={vi.fn()}
        onOpenProject={vi.fn()}
        onOpenThread={onOpenThread}
        importProviders={[]}
        onImportThread={vi.fn().mockResolvedValue(undefined)}
        onImportProjects={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { onOpenThread };
}

it.each(["Dashboard", "control-panel", "Client work"])(
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
          importProviders={[]}
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
