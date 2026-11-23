import "../../index.css";

import type { ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderHealthBanner } from "./ProviderHealthBanner";

const guidedSignIn = vi.hoisted(() => vi.fn());
vi.mock("../settings/accounts/ProviderGuidedSignIn", () => ({
  ProviderGuidedSignIn: (props: { account: { instanceId: string } }) => {
    guidedSignIn(props.account);
    return null;
  },
}));

const claudeSignedOut: ServerProviderStatus = {
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  status: "error",
  available: true,
  authStatus: "unauthenticated",
  message: "Claude is not authenticated. Run `claude auth login` and try again.",
  checkedAt: "2026-11-16T15:42:00.000Z",
};

it("offers sign-in in place instead of a terminal command for a signed-out provider", async () => {
  await render(<ProviderHealthBanner status={claudeSignedOut} />);

  await expect.element(page.getByText("Sign in to Claude", { exact: true })).toBeVisible();
  expect(page.getByText(/claude auth login/u).elements()).toHaveLength(0);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => guidedSignIn.mock.calls.length).toBeGreaterThan(0);
  expect(guidedSignIn).toHaveBeenCalledWith(
    expect.objectContaining({ provider: "claudeAgent", instanceId: "claudeAgent" }),
  );
});

it("keeps the server's diagnosis for problems a sign-in cannot fix", async () => {
  await render(
    <ProviderHealthBanner
      status={{
        ...claudeSignedOut,
        available: false,
        authStatus: "unknown",
        message: "Claude CLI was not found.",
      }}
    />,
  );

  await expect.element(page.getByText("Claude CLI was not found.")).toBeVisible();
  expect(page.getByRole("button", { name: "Sign in", exact: true }).elements()).toHaveLength(0);
});
