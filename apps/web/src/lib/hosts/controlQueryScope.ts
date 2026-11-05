import type { AccountStatus } from "@synara/contracts";
import { readExecutionContext } from "./executionContext";

let accountScope = "signed-out";
export function controlAccountScope(): string {
  return accountScope;
}
export function accountStatusScope(status: AccountStatus): string {
  return status.state === "signed-in"
    ? JSON.stringify([status.accountAuthority ?? "legacy", status.me.id, status.me.organization.id])
    : "signed-out";
}
export function adoptControlAccountScope(status: AccountStatus): void {
  accountScope = accountStatusScope(status);
}
export function windowQueryNamespace(key: readonly unknown[]): readonly unknown[] {
  const context = readExecutionContext();
  if (key[0] === "account" || key[0] === "remoteHosts") {
    return ["control", context?.controller.environmentId ?? "legacy", ...key];
  }
  const remote = context?.remote;
  return [
    "execution",
    remote ? [remote.accountAuthority, remote.userId, remote.organizationId] : "local",
    context?.execution.environmentId ?? "legacy",
    ...key,
  ];
}
