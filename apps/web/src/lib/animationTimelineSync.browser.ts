import "../index.css";

import { afterEach, describe, expect, it } from "vitest";

import { syncAnimationsToTimelineOrigin } from "./animationTimelineSync";

afterEach(() => {
  for (const element of document.querySelectorAll(".status-sync-test")) {
    element.remove();
  }
});

describe("syncAnimationsToTimelineOrigin", () => {
  it("aligns production spinner and shimmer steps without changing their cycle lengths", async () => {
    const spinner = document.createElement("span");
    spinner.className = "status-sync-test animate-spin-stepped";
    document.body.append(spinner);
    syncAnimationsToTimelineOrigin(spinner);

    await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
    const shimmer = document.createElement("span");
    shimmer.className = "status-sync-test shimmer";
    shimmer.textContent = "Working…";
    document.body.append(shimmer);
    syncAnimationsToTimelineOrigin(shimmer);

    const spinnerAnimation = spinner.getAnimations()[0]!;
    const shimmerAnimation = shimmer.getAnimations()[0]!;
    expect(spinnerAnimation.startTime).toBe(0);
    expect(spinnerAnimation.playState).toBe("running");
    expect(shimmerAnimation.startTime).toBe(0);
    expect(spinnerAnimation.effect?.getTiming().duration).toBe(1300);
    expect(shimmerAnimation.effect?.getTiming().duration).toBe(2000);

    const stepInterval = (element: Element, durationMs: number) => {
      const timing = getComputedStyle(element).animationTimingFunction;
      const steps = /^steps\((\d+)(?:, end)?\)$/.exec(timing)?.[1];
      expect(steps).toBeDefined();
      return durationMs / Number(steps);
    };
    expect(stepInterval(spinner, 1300)).toBe(50);
    expect(stepInterval(shimmer, 2000)).toBe(50);
  });
});
