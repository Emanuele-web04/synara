// FILE: logic.ts
// Purpose: Pure step, gate, and provider-classification rules for the first-run welcome tour.
// Layer: Web domain helper (no React, no I/O)
// Exports: ONBOARDING_STEPS, resolveOnboardingSteps, nextOnboardingStep, previousOnboardingStep,
//          isOnboardingSetupStep, resolveOnboardingGate, resolveOnboardingCompletionToReconcile,
//          resolveLocalOnboardingCompletion, classifyProviderSetup, summarizeProviderSetup,
//          describeOnboardingAgentSummary, toggleSelection

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";

/** Every step in display order; `resolveOnboardingSteps` picks the ones this run shows. */
export const ONBOARDING_STEPS = [
  "welcome",
  "agents",
  "tasks",
  "pocket",
  "account",
  "pair",
  "ready",
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export interface OnboardingStepInputs {
  /** The controller can host remote connections (iPhone pairing). */
  readonly remoteAvailable: boolean;
  /** The user was signed out when the tour opened, so the account step is worth showing. */
  readonly offerAccount: boolean;
  /** Signed in right now: pairing needs an account. */
  readonly signedIn: boolean;
}

/**
 * The remote steps only appear when this build can pair a phone. The account step is
 * latched from the moment the tour opened (signing in on it must not remove it from under
 * the user), while pairing follows the live sign-in state.
 */
export function resolveOnboardingSteps(input: OnboardingStepInputs): readonly OnboardingStep[] {
  return ONBOARDING_STEPS.filter((step) => {
    switch (step) {
      case "pocket":
        return input.remoteAvailable;
      case "account":
        return input.remoteAvailable && input.offerAccount;
      case "pair":
        return input.remoteAvailable && input.signedIn;
      default:
        return true;
    }
  });
}

/** Position of `step` in the full order, so a step missing from `steps` still resolves. */
function stepRank(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

export function nextOnboardingStep(
  steps: readonly OnboardingStep[],
  step: OnboardingStep,
): OnboardingStep {
  return steps.find((candidate) => stepRank(candidate) > stepRank(step)) ?? "ready";
}

export function previousOnboardingStep(
  steps: readonly OnboardingStep[],
  step: OnboardingStep,
): OnboardingStep {
  return steps.findLast((candidate) => stepRank(candidate) < stepRank(step)) ?? "welcome";
}

/** Steps where the user has started making setup choices; the tour must not auto-close past here. */
export function isOnboardingSetupStep(step: OnboardingStep): boolean {
  return step !== "welcome";
}

export interface LocalOnboardingCompletion {
  readonly completedAt: string | null;
  /**
   * Identity of the server installation the completion was recorded against (its
   * worktrees directory). A browser origin can be pointed at a different server state or
   * home directory later; a marker from another installation must not hide its tour.
   */
  readonly installationKey: string | null;
}

/**
 * The local marker is a pending write for one installation, not unconditional completion.
 * It only counts when both identities are known and match the current server.
 */
export function resolveLocalOnboardingCompletion(
  local: LocalOnboardingCompletion,
  currentInstallationKey: string | null,
): string | null {
  if (local.completedAt === null) return null;
  if (currentInstallationKey === null || local.installationKey === null) {
    return null;
  }
  return local.installationKey === currentInstallationKey ? local.completedAt : null;
}

export type OnboardingGate = "pending" | "show" | "hidden";

export interface OnboardingGateInputs {
  /** Wait for an installation identity; config failures defer the tour without blocking the app. */
  readonly installationKeyStatus: "pending" | "success" | "error";
  /** Local project state has been hydrated from the server at least once. */
  readonly threadsHydrated: boolean;
  /** The server settings query has settled (success or error). */
  readonly settingsSettled: boolean;
  /** Count of ordinary (non-container) projects. */
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  /** Already scoped to this installation via `resolveLocalOnboardingCompletion`. */
  readonly localCompletedAt: string | null;
}

/**
 * The tour shows on a fresh install (no ordinary projects) that has not recorded
 * completion anywhere. Either marker counts: the server one is durable across browser
 * profiles, the local one covers a completion whose server write failed and is
 * reconciled back to the server on the next launch (see
 * `resolveOnboardingCompletionToReconcile`).
 *
 * The result is *not* authoritative until the inputs are: callers re-evaluate as
 * snapshots and settings arrive instead of latching the first non-pending answer.
 */
export function resolveOnboardingGate(input: OnboardingGateInputs): OnboardingGate {
  if (
    input.installationKeyStatus === "pending" ||
    !input.threadsHydrated ||
    !input.settingsSettled
  ) {
    return "pending";
  }
  if (input.installationKeyStatus === "error") return "hidden";
  const completed = input.serverCompletedAt !== null || input.localCompletedAt !== null;
  return !completed && input.projectCount === 0 ? "show" : "hidden";
}

export interface OnboardingReconcileInputs {
  readonly threadsHydrated: boolean;
  /** Server settings are readable, so a null marker is a real absence, not a fetch error. */
  readonly settingsAvailable: boolean;
  readonly projectCount: number;
  readonly serverCompletedAt: string | null;
  readonly localCompletedAt: string | null;
  /** ISO timestamp used when an existing install is exempted without a local marker. */
  readonly now: string;
}

/**
 * Returns the completion timestamp to write to the server, or null when nothing is owed.
 * Two cases need the marker persisted after the fact:
 * - a completion whose server write failed (only the local marker exists), and
 * - an installation that predates the tour (projects exist, no marker anywhere), which
 *   must never see the "first run" tour just because its last project is later removed.
 */
export function resolveOnboardingCompletionToReconcile(
  input: OnboardingReconcileInputs,
): string | null {
  if (!input.threadsHydrated || !input.settingsAvailable || input.serverCompletedAt !== null) {
    return null;
  }
  if (input.localCompletedAt !== null) {
    return input.localCompletedAt;
  }
  return input.projectCount > 0 ? input.now : null;
}

export type ProviderSetupState =
  | "connected"
  | "needs-sign-in"
  | "not-installed"
  | "detecting"
  | "check-failed"
  | "disabled";

export function classifyProviderSetup(input: {
  readonly status: Pick<ServerProviderStatus, "available" | "authStatus"> | null | undefined;
  readonly disabled: boolean;
  readonly detecting?: boolean;
  readonly detectionFailed?: boolean;
}): ProviderSetupState {
  if (input.disabled) return "disabled";
  if (!input.status && input.detecting) return "detecting";
  if (!input.status && input.detectionFailed) return "check-failed";
  if (!input.status || !input.status.available) return "not-installed";
  // Providers whose auth is not probed report "unknown"; treat a detected binary as
  // usable rather than nagging for a sign-in Synara cannot verify.
  return input.status.authStatus === "unauthenticated" ? "needs-sign-in" : "connected";
}

export interface ProviderSetupSummary {
  readonly enabled: number;
  readonly connected: number;
  readonly needsSignIn: number;
  readonly notInstalled: number;
  readonly detecting: number;
  readonly checkFailed: number;
}

export function summarizeProviderSetup(
  states: ReadonlyArray<{ readonly provider: ProviderKind; readonly state: ProviderSetupState }>,
): ProviderSetupSummary {
  let enabled = 0;
  let connected = 0;
  let needsSignIn = 0;
  let notInstalled = 0;
  let detecting = 0;
  let checkFailed = 0;
  for (const entry of states) {
    if (entry.state !== "disabled") enabled += 1;
    if (entry.state === "connected") connected += 1;
    if (entry.state === "needs-sign-in") needsSignIn += 1;
    if (entry.state === "not-installed") notInstalled += 1;
    if (entry.state === "detecting") detecting += 1;
    if (entry.state === "check-failed") checkFailed += 1;
  }
  return { enabled, connected, needsSignIn, notInstalled, detecting, checkFailed };
}

export function describeOnboardingAgentSummary(summary: ProviderSetupSummary): string {
  if (summary.detecting > 0) return "Checking agents…";
  if (summary.checkFailed > 0) return "Could not check all agents";
  return `${summary.connected} agent${summary.connected === 1 ? "" : "s"} connected`;
}

export function toggleSelection<T>(selection: ReadonlySet<T>, id: T): ReadonlySet<T> {
  const next = new Set(selection);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}
