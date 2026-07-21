import { describe, expect, it } from "vitest";

import {
  makeUpdateInstallPreparationCoordinator,
  UpdateInstallPreparationCancelledError,
} from "./updateInstallPreparation";

describe("update install preparation coordination", () => {
  it("invalidates pending work and reports whether recovery must wait for it", () => {
    const coordinator = makeUpdateInstallPreparationCoordinator();
    const attempt = coordinator.begin();

    if (attempt === null) throw new Error("Expected an active preparation attempt");
    coordinator.requireActive(attempt);
    expect(coordinator.cancel()).toBe(true);
    expect(() => coordinator.requireActive(attempt)).toThrow(
      UpdateInstallPreparationCancelledError,
    );
    expect(coordinator.begin()).toBeNull();
    coordinator.release(attempt);
    expect(coordinator.cancel()).toBe(false);
  });

  it("completes only the currently active attempt", () => {
    const coordinator = makeUpdateInstallPreparationCoordinator();
    const active = coordinator.begin();

    expect(active).not.toBeNull();
    expect(coordinator.begin()).toBeNull();
    if (active === null) throw new Error("Expected an active preparation attempt");
    coordinator.release(active);
    expect(coordinator.cancel()).toBe(false);
  });
});
