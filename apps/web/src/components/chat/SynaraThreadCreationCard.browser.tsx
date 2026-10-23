import "../../index.css";

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { appHistory } from "../../appNavigation";
import {
  addWorkspaceSession,
  readWorkspaceSessions,
  removeWorkspaceSession,
  updateWorkspaceSession,
} from "../../lib/hosts/workspaceSessions";
import type { WorkLogSynaraThreadCreation } from "../../workLog";
import { SynaraThreadCreationCard } from "./SynaraThreadCreationCard";

vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: { environmentId: "book", capabilities: { remoteConnections: true } },
    execution: { environmentId: "book" },
    remote: null,
  }),
}));

const creation: WorkLogSynaraThreadCreation = {
  operationId: "gateway:create:remote",
  requestedCount: 1,
  createdCount: 1,
  threads: [
    {
      threadId: "remote-thread",
      title: "Say hi",
      provider: "codex",
      model: "gpt-5.6-terra",
      environment: "local",
      status: "task_dispatched",
    },
  ],
};
const remoteCreation = { ...creation, environmentId: "mini", hostName: "Mac mini" };

function connectMini() {
  addWorkspaceSession({
    hostId: "paired-mini",
    hostName: "Mac mini",
    wsPath: "/ws/remote/paired-mini",
    executionScope: {
      environmentId: "mini",
      accountAuthority: "https://account.example",
      userId: "alice",
      organizationId: "org",
      channel: "dev",
    },
  });
  updateWorkspaceSession("mini", {
    navigation: {
      browseFolders: vi.fn(),
      createProject: vi.fn(),
      newChat: vi.fn(),
      createChat: vi.fn(),
      openTerminal: vi.fn(),
      openProject: vi.fn(),
      navigate: vi.fn(),
      recover: vi.fn(),
    },
    summary: { state: "open", path: "/", projects: [], threads: [] },
  });
}

afterEach(async () => {
  await cleanup();
  for (const session of readWorkspaceSessions()) removeWorkspaceSession(session.host.hostId);
  vi.restoreAllMocks();
});

it("opens a local creation through the local thread callback", async () => {
  const onOpenThread = vi.fn();
  const screen = await render(
    <SynaraThreadCreationCard creation={creation} onOpenThread={onOpenThread} />,
  );
  await expect.element(screen.getByText(/· Local$/)).toBeVisible();
  await screen.getByRole("button", { name: "Open thread" }).click();
  expect(onOpenThread).toHaveBeenCalledWith("remote-thread");
});

it("names the computer and hides Open until that computer is connected", async () => {
  const onOpenThread = vi.fn();
  const screen = await render(
    <SynaraThreadCreationCard creation={remoteCreation} onOpenThread={onOpenThread} />,
  );
  await expect.element(screen.getByText(/· Local · on Mac mini$/)).toBeVisible();
  expect(screen.container.querySelector("button")).toBeNull();
});

it("opens a remote creation in its computer's workspace, not as a local id", async () => {
  connectMini();
  const push = vi.spyOn(appHistory, "push").mockImplementation(() => {});
  const onOpenThread = vi.fn();
  const screen = await render(
    <SynaraThreadCreationCard creation={remoteCreation} onOpenThread={onOpenThread} />,
  );
  await screen.getByRole("button", { name: "Open thread" }).click();
  await vi.waitFor(() =>
    expect(push).toHaveBeenCalledWith("/remote?environment=mini&path=%2Fremote-thread"),
  );
  expect(onOpenThread).not.toHaveBeenCalled();
});
