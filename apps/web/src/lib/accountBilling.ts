// Account billing reads and redirects stay bound to the identity that opened Settings.
import type { AccountBillingStatus, NativeApi } from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { accountStatusScope } from "./hosts/controlQueryScope";

export async function runAccountBillingOperation<T>(
  expectedScope: string,
  operation: (account: NativeApi["account"]) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const api = ensureNativeApi();
  const assertAccount = async () => {
    signal?.throwIfAborted();
    const status = await api.account.status();
    signal?.throwIfAborted();
    if (status.state !== "signed-in" || accountStatusScope(status) !== expectedScope) {
      throw new Error("Your account changed. Reopen Subscription to continue.");
    }
  };
  await assertAccount();
  const result = await operation(api.account);
  await assertAccount();
  return result;
}

export function formatBillingPrice(plan: AccountBillingStatus["plans"][number]): string {
  const formatter = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: plan.currency,
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(plan.amountMinor / 10 ** digits);
}

/** Billing redirects must stay on the vendor origin for the current environment. */
export function isPolarBillingUrl(
  value: string,
  environment: AccountBillingStatus["environment"],
): boolean {
  try {
    const url = new URL(value);
    const origin =
      environment === "sandbox"
        ? "https://sandbox.polar.sh"
        : environment === "production"
          ? "https://polar.sh"
          : null;
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
