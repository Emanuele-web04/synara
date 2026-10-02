import { ThreadId, type GitActionProgressEvent, type NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../index.css";

const route = vi.hoisted(() => ({ threadId: "git-workspace-a" }));
vi.mock("@tanstack/react-router", () => ({ useParams: () => route.threadId }));
vi.mock("../hooks/useDiffRouteSearch", () => ({ useDiffRouteSearch: () => ({}) }));
vi.mock("../appSettings", () => ({
  useAppSettings: () => ({ settings: { codexHomePath: "" } }),
  getProviderStartOptions: () => undefined,
}));

import GitActionsControl from "./GitActionsControl";
import { ToastProvider } from "./ui/toast";
import { useStore } from "../store";

const status: Awaited<ReturnType<NativeApi["git"]["status"]>> = {
  branch: "feature/work",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [{ path: "README.md", insertions: 1, deletions: 0 }],
    insertions: 1,
    deletions: 0,
  },
  hasUpstream: true,
  upstreamBranch: "origin/feature/work",
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};
const branches: Awaited<ReturnType<NativeApi["git"]["listBranches"]>> = {
  isRepo: true,
  hasOriginRemote: true,
  branches: [
    { name: "feature/work", current: true, isDefault: false, isRemote: false, worktreePath: null },
    { name: "main", current: false, isDefault: true, isRemote: false, worktreePath: null },
  ],
};

afterEach(() => vi.restoreAllMocks());

it("owns failure details per action when the retained control changes workspace", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const listeners = new Set<(event: GitActionProgressEvent) => void>();
  const pending: Array<{
    input: Parameters<NativeApi["git"]["runStackedAction"]>[0];
    reject: (error: Error) => void;
  }> = [];
  const api = {
    git: {
      status: vi.fn(async () => status),
      listBranches: vi.fn(async () => branches),
      onActionProgress: (listener: (event: GitActionProgressEvent) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      runStackedAction: vi.fn(
        (input: Parameters<NativeApi["git"]["runStackedAction"]>[0]) =>
          new Promise<never>((_, reject) => pending.push({ input, reject })),
      ),
    },
  };
  const previousApi = window.nativeApi;
  Object.defineProperty(window, "nativeApi", { configurable: true, value: api });
  const previousShell = useStore.getState().threadShellById ?? {};
  useStore.setState({ threadShellById: {} });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const showWorkspace = (cwd: string, threadId: string) => {
    route.threadId = threadId;
    flushSync(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <GitActionsControl gitCwd={cwd} activeThreadId={ThreadId.makeUnsafe(threadId)} />
          </ToastProvider>
        </QueryClientProvider>,
      ),
    );
  };
  const emit = (index: number, phase: "commit" | "push") => {
    const input = pending[index]!.input;
    for (const listener of listeners) {
      listener({
        actionId: input.actionId!,
        cwd: input.cwd,
        action: input.action,
        kind: "phase_started",
        phase,
        label: phase === "commit" ? "Committing..." : "Pushing...",
      });
    }
  };
  const start = async (push: boolean) => {
    await page.getByRole("button", { name: "Git action options", exact: true }).click();
    await page.getByRole("menuitem", { name: "Commit", exact: true }).click();
    await page.getByRole("textbox", { name: "Commit message" }).fill("User supplied message");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: push ? "Commit & push" : /^Commit (?:Ctrl ↵|⌘↵)$/, exact: true })
      .click();
  };
  const expectFailure = async (descriptionText: string, title: string) => {
    await vi.waitFor(() => {
      const description = Array.from(
        document.querySelectorAll('[data-slot="toast-description"]'),
      ).find((element) => element.textContent === descriptionText);
      expect(description).toBeTruthy();
      expect(
        description?.parentElement?.querySelector('[data-slot="toast-title"]')?.textContent,
      ).toBe(title);
    });
  };
  try {
    showWorkspace("/repo/a", "git-workspace-a");
    await start(false);
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.input.cwd).toBe("/repo/a");
    emit(0, "commit");
    showWorkspace("/repo/b", "git-workspace-b");
    await start(true);
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[1]!.input.cwd).toBe("/repo/b");
    emit(1, "push");
    pending[0]!.reject(new Error("First workspace commit failed"));
    showWorkspace("/repo/a", "git-workspace-a");
    await expectFailure("First workspace commit failed", "Commit failed");
    showWorkspace("/repo/b", "git-workspace-b");
    const secondInput = pending[1]!.input;
    for (const listener of listeners) {
      listener({
        actionId: secondInput.actionId!,
        cwd: secondInput.cwd,
        action: secondInput.action,
        kind: "action_failed",
        phase: "push",
        message: "Second workspace push failed",
      });
    }
    pending[1]!.reject(new Error("Git action stream failed"));
    await expectFailure("Second workspace push failed", "Push failed");
  } finally {
    for (const action of pending) action.reject(new Error("Test finished"));
    flushSync(() => root.unmount());
    host.remove();
    await queryClient.cancelQueries();
    queryClient.clear();
    Object.defineProperty(window, "nativeApi", { configurable: true, value: previousApi });
    useStore.setState({ threadShellById: previousShell });
  }
});
