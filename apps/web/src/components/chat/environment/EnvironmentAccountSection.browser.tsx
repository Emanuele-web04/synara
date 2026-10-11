import "../../../index.css";

import type {
  ProviderAccountsSnapshot,
  ProviderAccountsThreadBinding,
  ThreadId,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  confirm: vi.fn(async (_message: string) => true),
  rebindThread: vi.fn(async () => undefined),
  navigate: vi.fn(async () => undefined),
  binding: {
    binding: { provider: "codex", ordinal: 1, agentGeneration: 1 },
  } as Record<string, unknown>,
  agentState: "connected",
  agentGeneration: 1,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useNavigate: () => harness.navigate,
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    dialogs: { confirm: harness.confirm },
    providerAccounts: {
      rebindThread: harness.rebindThread,
      getThreadBinding: async () => harness.binding as unknown as ProviderAccountsThreadBinding,
      getSnapshot: async () =>
        ({
          providers: [
            {
              provider: "codex",
              activeOrdinal: 1,
              accounts: [
                { provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" },
                {
                  provider: "codex",
                  ordinal: 1,
                  createdAt: "2026-01-02T00:00:00.000Z",
                  agent: {
                    generation: harness.agentGeneration,
                    state: harness.agentState,
                    authMethod: "apiKey",
                  },
                },
              ],
              capabilities: {
                agent: { oauth: "supported", apiKey: "supported" },
                app: { oauth: "unsupported", supportLevel: "unsupported" },
              },
            },
          ],
        }) as unknown as ProviderAccountsSnapshot,
    },
  }),
}));

import { EnvironmentAccountSection } from "./EnvironmentAccountSection";

const renderSection = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <EnvironmentAccountSection threadId={"thread-1" as ThreadId} enabled onClose={onClose} />
    </QueryClientProvider>,
  );
  return { result, onClose };
};

describe("EnvironmentAccountSection", () => {
  afterEach(() => {
    harness.navigate.mockClear();
    harness.confirm.mockReset();
    harness.confirm.mockResolvedValue(true);
    harness.rebindThread.mockClear();
    harness.binding = { binding: { provider: "codex", ordinal: 1, agentGeneration: 1 } };
    harness.agentState = "connected";
    harness.agentGeneration = 1;
  });

  it("shows the thread-bound account and navigates to accounts settings", async () => {
    const { onClose } = renderSection();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 1"));
    expect(document.body.textContent).toContain("Account");
    // Healthy binding shows no caveat.
    expect(document.body.textContent).not.toContain("Needs sign-in");

    await page.getByRole("button", { name: /Codex 1/ }).click();
    await vi.waitFor(() =>
      expect(harness.navigate).toHaveBeenCalledWith({
        to: "/settings",
        search: { section: "accounts" },
      }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("renders nothing when the thread has no account binding", async () => {
    harness.binding = {};
    renderSection();
    // Give the query a beat to settle, then assert no Account section rendered.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(document.body.textContent).not.toContain("Codex 1");
  });

  it("flags a needs-auth account", async () => {
    harness.agentState = "needs-auth";
    renderSection();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Needs sign-in"));
  });

  it("renews the exact displayed account only after confirmation", async () => {
    harness.agentGeneration = 2;
    renderSection();
    const renew = page.getByRole("button", { name: "Use reconnected account" });
    await expect.element(renew).toBeVisible();
    harness.confirm.mockResolvedValueOnce(false);
    await renew.click();
    expect(harness.rebindThread).not.toHaveBeenCalled();
    await renew.click();
    await vi.waitFor(() =>
      expect(harness.rebindThread).toHaveBeenCalledWith({
        threadId: "thread-1",
        provider: "codex",
        ordinal: 1,
        expectedGeneration: 1,
        targetGeneration: 2,
      }),
    );
    expect(harness.confirm.mock.calls[0]?.[0]).toContain("conversation’s history");
  });

  it("flags a generation mismatch after the account was reconnected", async () => {
    harness.agentGeneration = 2;
    renderSection();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Reconnected since this thread started"),
    );
  });
});
