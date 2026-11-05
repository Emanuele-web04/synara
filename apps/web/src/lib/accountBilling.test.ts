import type { AccountStatus } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";
import { accountStatusScope } from "./hosts/controlQueryScope";
import {
  formatBillingPrice,
  isPolarBillingUrl,
  runAccountBillingOperation,
} from "./accountBilling";

const account = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ account }) }));

function signedIn(userId: string): AccountStatus {
  return {
    state: "signed-in",
    accountAuthority: "https://accounts.example.com",
    me: {
      id: userId,
      name: "Tester",
      email: "test@example.com",
      organization: { id: "org_1", name: "Personal" },
    },
  };
}

describe("account billing", () => {
  it("rejects a departed account before creating a checkout", async () => {
    account.status.mockResolvedValue(signedIn("user_b"));
    const checkout = vi.fn();
    await expect(
      runAccountBillingOperation(accountStatusScope(signedIn("user_a")), checkout),
    ).rejects.toThrow("account changed");
    expect(checkout).not.toHaveBeenCalled();
  });

  it("discards a billing result if the account changes while it loads", async () => {
    account.status
      .mockReset()
      .mockResolvedValueOnce(signedIn("user_a"))
      .mockResolvedValueOnce(signedIn("user_b"));
    await expect(
      runAccountBillingOperation(
        accountStatusScope(signedIn("user_a")),
        async () => "old-account-portal",
      ),
    ).rejects.toThrow("account changed");
  });

  it("does not return a canceled query's result", async () => {
    account.status.mockReset().mockResolvedValue(signedIn("user_a"));
    const controller = new AbortController();
    await expect(
      runAccountBillingOperation(
        accountStatusScope(signedIn("user_a")),
        async () => {
          controller.abort();
          return "old-result";
        },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it.each([
    ["sandbox", "https://sandbox.polar.sh", "https://polar.sh"],
    ["production", "https://polar.sh", "https://sandbox.polar.sh"],
  ] as const)(
    "accepts only the exact HTTPS vendor origin for %s",
    (environment, origin, otherOrigin) => {
      expect(isPolarBillingUrl(`${origin}/checkout/session`, environment)).toBe(true);
      for (const url of [
        `${otherOrigin}/checkout/session`,
        `${origin}.evil.test/checkout`,
        origin.replace("https://", "https://user:password@"),
        `${origin}:444/checkout`,
        origin.replace("https://", "http://"),
        "javascript:alert(1)",
        "not a URL",
      ]) {
        expect(isPolarBillingUrl(url, environment), url).toBe(false);
      }
    },
  );

  it("uses currency minor units instead of assuming all currencies have cents", () => {
    expect(formatBillingPrice({ interval: "month", amountMinor: 1250, currency: "USD" })).toContain(
      "12.50",
    );
    expect(formatBillingPrice({ interval: "year", amountMinor: 1250, currency: "JPY" })).toContain(
      "1,250",
    );
    expect(formatBillingPrice({ interval: "month", amountMinor: 1250, currency: "KWD" })).toContain(
      "1.250",
    );
  });
});
