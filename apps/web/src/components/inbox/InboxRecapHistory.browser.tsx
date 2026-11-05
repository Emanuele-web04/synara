import type { AccountStatus, SavedInboxRecap, StatsGetRecapResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  status: null as AccountStatus | null,
  save: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
  enrollment: vi.fn(),
  remoteHostId: undefined as string | undefined,
}));
vi.mock("~/hooks/useAccount", () => ({ useAccount: () => ({ status: fixture.status }) }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    account: {
      saveInboxRecap: fixture.save,
      listInboxRecaps: fixture.list,
      deleteInboxRecap: fixture.remove,
    },
  }),
}));
vi.mock("~/lib/hosts/api", () => ({ readHostsApi: () => ({ enrollment: fixture.enrollment }) }));
vi.mock("~/lib/hosts/executionContext", () => ({
  readExecutionContext: () =>
    fixture.remoteHostId ? { remoteHostId: fixture.remoteHostId, remote: {} } : undefined,
}));

import { InboxRecapHistory } from "./InboxRecapHistory";

it("saves only on explicit action, reads account history, and hides it after an account switch", async () => {
  const slot = {
    from: "2026-10-01T04:00:00.000Z",
    to: "2026-10-02T04:00:00.000Z",
    prompts: 2,
    chats: 1,
    turns: 2,
    failedTurns: 0,
    agentWorkMs: 100,
    tokens: { user: 20, automation: 10, agent: 5 },
  };
  const recap: StatsGetRecapResult = {
    generatedAt: "2026-10-01T10:00:00.000Z",
    totals: slot,
    slots: [slot],
    projects: [],
    models: [],
    unavailableProviders: [],
  };
  const saved: SavedInboxRecap = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    sourceHostId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sourceHostName: "Private Mac",
    savedAt: "2026-10-01T10:00:00.000Z",
    day: "2026-10-01",
    timezone: "UTC",
    recap,
  };
  const me = {
    id: "user_a",
    name: "A",
    email: "a@example.com",
    organization: { id: "org_a", name: "A" },
    profile: null,
  };
  fixture.remoteHostId = undefined;
  fixture.status = { state: "signed-in", accountAuthority: "https://accounts.example/api/v1", me };
  fixture.save.mockReset().mockResolvedValue(saved);
  fixture.list.mockReset().mockResolvedValue({ recaps: [saved], nextCursor: null });
  fixture.remove.mockReset().mockResolvedValue(undefined);
  fixture.enrollment.mockReset().mockResolvedValue({ host: { id: saved.sourceHostId } });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const content = () => (
    <QueryClientProvider client={client}>
      <InboxRecapHistory
        recap={recap}
        renderRecap={(value) => <p>{value.recap.totals.prompts} saved prompts</p>}
      />
    </QueryClientProvider>
  );
  const view = await render(content());
  try {
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.list).not.toHaveBeenCalled();
    await view.getByRole("button", { name: "Save privately" }).click();
    await expect.poll(() => fixture.save.mock.calls.length).toBe(1);
    expect(fixture.save.mock.calls[0]?.[0]).toMatchObject({
      expectedUserId: "user_a",
      expectedOrganizationId: "org_a",
      request: { sourceHostId: saved.sourceHostId, recap },
    });
    await expect.element(view.getByText("Recap saved to your account.")).toBeVisible();
    await view.getByRole("button", { name: /2026-10-01 · Private Mac/ }).click();
    await expect.element(view.getByText("2 saved prompts")).toBeVisible();
    fixture.status = {
      state: "signed-in",
      accountAuthority: "https://accounts.example/api/v1",
      me: { ...me, id: "user_b" },
    };
    fixture.list.mockResolvedValue({ recaps: [], nextCursor: null });
    await view.rerender(content());
    await expect.element(view.getByText("Recap saved to your account.")).not.toBeInTheDocument();
    await expect.element(view.getByText("2 saved prompts")).not.toBeInTheDocument();
    await view.getByRole("button", { name: /Saved recaps/ }).click();
    await expect.element(view.getByText("No saved recaps yet.")).toBeVisible();
  } finally {
    await view.unmount();
    client.clear();
  }
});

it("blocks manual saving from a remote frame, leaving private history accessible", async () => {
  fixture.remoteHostId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  fixture.status = {
    state: "signed-in",
    accountAuthority: "https://accounts.example/api/v1",
    me: {
      id: "user_a",
      name: "A",
      email: "a@example.com",
      organization: { id: "org_a", name: "A" },
      profile: null,
    },
  };
  fixture.save.mockReset();
  fixture.enrollment.mockReset();
  fixture.list.mockReset().mockResolvedValue({ recaps: [], nextCursor: null });
  // A recap exists, so remote execution (not missing data) must disable the action.
  const slot = {
    from: "2026-09-30T19:00:00.000Z",
    to: "2026-10-01T19:00:00.000Z",
    prompts: 2,
    chats: 1,
    turns: 2,
    failedTurns: 0,
    agentWorkMs: 100,
    tokens: { user: 20, automation: 10, agent: 5 },
  };
  const recap: StatsGetRecapResult = {
    generatedAt: "2026-10-01T12:00:00.000Z",
    totals: slot,
    slots: [slot],
    projects: [],
    models: [],
    unavailableProviders: [],
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = await render(
    <QueryClientProvider client={client}>
      <InboxRecapHistory recap={recap} renderRecap={(saved) => <p>{saved.day}</p>} />
    </QueryClientProvider>,
  );
  try {
    await expect.element(view.getByRole("button", { name: "Save privately" })).toBeDisabled();
    const syncNote = view.getByText(/Remote recaps sync privately from their source computer/);
    await expect.element(syncNote).toBeVisible();
    await view.getByRole("button", { name: /Saved recaps/ }).click();
    await expect.element(view.getByText("No saved recaps yet.")).toBeVisible();
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.enrollment).not.toHaveBeenCalled();
  } finally {
    fixture.remoteHostId = undefined;
    await view.unmount();
    client.clear();
  }
});
