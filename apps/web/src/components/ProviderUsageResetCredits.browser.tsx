import "../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { ServerCodexResetCredits } from "@synara/contracts";

const harness = vi.hoisted(() => ({ confirm: vi.fn(), consume: vi.fn(), toast: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ dialogs: { confirm: harness.confirm } }),
}));
vi.mock("~/lib/serverReactQuery", () => ({
  consumeCodexResetCredit: harness.consume,
  serverQueryKeys: { allProviderUsage: () => ["usage"] },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toast } }));
import { ProviderUsageResetCredits } from "./ProviderUsageResetCredits";

const credits: ServerCodexResetCredits = {
  accountId: "browser-account",
  availableCount: 1,
  canUse: true,
  credits: [{ id: "available", status: "available" }],
};
const mount = (value = credits) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ProviderUsageResetCredits resetCredits={value} />
    </QueryClientProvider>,
  );
beforeEach(() => {
  localStorage.removeItem("synara:codex-reset-attempt:browser-account");
  harness.confirm.mockReset().mockResolvedValue(true);
  harness.consume.mockReset().mockResolvedValue({ outcome: "reset" });
  harness.toast.mockReset();
});

describe("Codex banked reset confirmation", () => {
  it("does not consume or allocate an attempt after a declined confirmation", async () => {
    harness.confirm.mockResolvedValue(false);
    await mount();
    await page.getByRole("button", { name: "Use reset" }).click();
    await expect.element(page.getByRole("button", { name: "Use reset" })).toBeEnabled();
    expect(harness.confirm).toHaveBeenCalledTimes(1);
    expect(harness.consume).not.toHaveBeenCalled();
    expect(localStorage.getItem("synara:codex-reset-attempt:browser-account")).toBeNull();
  });
  it("confirms, consumes once and refreshes the successful state", async () => {
    await mount();
    await page.getByRole("button", { name: "Use reset" }).click();
    await expect.poll(() => harness.consume.mock.calls.length).toBe(1);
    expect(harness.consume.mock.calls[0]?.[0]).toMatchObject({
      accountId: "browser-account",
      creditId: "available",
      idempotencyKey: expect.any(String),
    });
    await expect
      .poll(() => localStorage.getItem("synara:codex-reset-attempt:browser-account"))
      .toBeNull();
    expect(harness.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });
  it("reuses the same attempt after a lost response and popover remount", async () => {
    harness.consume.mockRejectedValueOnce(new Error("connection lost"));
    const first = await mount();
    await page.getByRole("button", { name: "Use reset" }).click();
    await expect.element(page.getByRole("button", { name: "Retry reset" })).toBeEnabled();
    const original = harness.consume.mock.calls[0]?.[0];
    await first.unmount();
    await mount({ ...credits, canUse: false, availableCount: 0, credits: [] });
    await page.getByRole("button", { name: "Retry reset" }).click();
    await expect.poll(() => harness.consume.mock.calls.length).toBe(2);
    expect(harness.consume.mock.calls[1]?.[0]).toEqual(original);
  });
  it("supports aggregate-only credit counts", async () => {
    await mount({ accountId: "browser-account", availableCount: 2, canUse: true });
    await page.getByRole("button", { name: "Use reset" }).click();
    await expect.poll(() => harness.consume.mock.calls.length).toBe(1);
    expect(harness.consume.mock.calls[0]?.[0]).not.toHaveProperty("creditId");
  });
  it("disables new redemptions for unavailable account/usage and omits used or expired rows", async () => {
    await mount({
      availableCount: 3,
      credits: [
        { id: "available", status: "available" },
        { id: "redeemed", status: "redeemed" },
        { id: "expired", status: "available", expiresAt: "2000-01-01T00:00:00Z" },
      ],
    });
    await expect.element(page.getByRole("button", { name: "Use reset" })).toBeDisabled();
    expect(document.querySelectorAll("button")).toHaveLength(1);
    expect(harness.consume).not.toHaveBeenCalled();
  });
});
