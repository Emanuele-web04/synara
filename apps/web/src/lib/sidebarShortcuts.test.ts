// FILE: sidebarShortcuts.test.ts
// Purpose: Verifies that global sidebar shortcut requests notify the registered sidebar handler exactly once.
// Layer: Web UI helper test

import { describe, expect, it, vi } from "vitest";

import { onSidebarAddProjectRequest, requestSidebarAddProject } from "./sidebarShortcuts";

describe("sidebarShortcuts", () => {
  it("notifies subscribed listeners when a sidebar add-project request is dispatched", () => {
    const callback = vi.fn();
    const unsubscribe = onSidebarAddProjectRequest(callback);

    requestSidebarAddProject();

    expect(callback).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it("stops notifying listeners after unsubscribe", () => {
    const callback = vi.fn();
    const unsubscribe = onSidebarAddProjectRequest(callback);

    unsubscribe();
    requestSidebarAddProject();

    expect(callback).not.toHaveBeenCalled();
  });
});
