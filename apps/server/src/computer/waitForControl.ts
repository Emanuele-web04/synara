import { setTimeout as delay } from "node:timers/promises";
import type { ComputerState, ComputerTarget, ComputerUiNode } from "@synara/contracts";
import { ComputerTargetError, resolveComputerSemanticTarget } from "./uiTreeTargeting.ts";

export interface ComputerControlReadiness {
  readonly status: "ready" | "timeout" | "unavailable" | "ambiguous" | "closed";
  readonly waitedMs: number;
  readonly checks: number;
  readonly windowClosed?: boolean;
}

export interface ComputerControlWaitOptions {
  readonly absent?: boolean;
  /** Exact accessibility value, including the empty string; never a label match. */
  readonly valueEquals?: string;
  /** The predicate must hold on consecutive observations spanning this interval. */
  readonly stableMs?: number;
}

function hasTruncatedBranch(root: ComputerUiNode): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.truncated) return true;
    pending.push(...node.children);
  }
  return false;
}

/** Wait for live evidence without sending input or retaining coordinates.
 * The deadline bounds polling; an in-flight accessibility read remains cooperative.
 */
export async function waitForControl(
  read: () => Promise<ComputerState>,
  target: ComputerTarget,
  timeoutMs: number,
  signal?: AbortSignal,
  options: ComputerControlWaitOptions = {},
): Promise<ComputerControlReadiness> {
  const absent = options.absent === true;
  const stableMs = options.stableMs ?? 0;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    !Number.isFinite(stableMs) ||
    stableMs < 0 ||
    stableMs > timeoutMs ||
    (absent && options.valueEquals !== undefined)
  ) {
    throw new Error(
      "Invalid control wait: stability must fit the timeout; absence excludes value.",
    );
  }
  const started = performance.now();
  let checks = 0;
  let satisfiedSince: number | undefined;
  const result = (
    status: ComputerControlReadiness["status"],
    windowClosed = false,
  ): ComputerControlReadiness => ({
    status,
    waitedMs: Math.round(performance.now() - started),
    checks,
    ...(windowClosed ? { windowClosed: true } : {}),
  });
  while (true) {
    signal?.throwIfAborted();
    const state = await read();
    checks += 1;
    signal?.throwIfAborted();
    const windowClosed =
      target.windowId !== undefined &&
      !state.windows.some((window) => window.id === target.windowId);
    let satisfied = false;
    if (windowClosed) {
      if (!absent) return result("closed", true);
      satisfied = true;
    } else {
      if (
        !state.root ||
        state.accessibility?.status === "unavailable" ||
        (target.windowId && state.accessibility?.unavailableWindowIds?.includes(target.windowId))
      ) {
        return result("unavailable");
      }
      // Check negative evidence before treating a missing match as disappearance.
      // A partial branch can hide a control that is still present.
      const incomplete = hasTruncatedBranch(state.root);
      if (absent && incomplete) return result("unavailable");
      try {
        const { node } = resolveComputerSemanticTarget(state.root, target);
        if (!absent) {
          if (options.valueEquals !== undefined && node.value === null) {
            return result("unavailable");
          }
          satisfied = options.valueEquals === undefined || node.value === options.valueEquals;
        }
      } catch (error) {
        if (!(error instanceof ComputerTargetError)) throw error;
        if (error.code === "computer_target_ambiguous") {
          if (!absent) return result("ambiguous");
        } else if (error.code !== "computer_target_not_found") {
          throw error;
        } else {
          satisfied = absent;
        }
      }
      if (!satisfied && incomplete) return result("unavailable");
    }
    const now = performance.now();
    if (satisfied) {
      satisfiedSince ??= now;
      if (now - satisfiedSince >= stableMs) return result("ready", windowClosed);
    } else {
      satisfiedSince = undefined;
    }
    const remaining = timeoutMs - (now - started);
    if (remaining <= 0) return result("timeout", windowClosed);
    // Start responsive, then avoid reading unchanged AX state ten times per
    // second throughout a long load. Wake at the stability deadline when sooner.
    const interval = Math.min(500, 100 * 2 ** Math.min(checks - 1, 3));
    const stabilityRemaining =
      satisfiedSince === undefined ? interval : Math.max(1, stableMs - (now - satisfiedSince));
    await delay(Math.min(interval, remaining, stabilityRemaining), undefined, { signal });
  }
}
