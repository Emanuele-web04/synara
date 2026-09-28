import { describe, expect, it } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import type { ComputerApp, ComputerWindow } from "@synara/contracts";
import { computerDenylistMatch } from "./computerDenylist.ts";

const DENIED_WINDOW: ComputerWindow = {
  id: "fake-password-manager",
  title: "1Password",
  appName: "1Password",
  pid: 2_001,
  bounds: { x: 200, y: 100, width: 800, height: 600 },
  focused: false,
  minimized: false,
  visible: true,
};

const DENIED_APP: ComputerApp = {
  pid: 2_001,
  name: "1Password",
  bundleId: "com.1password.1password",
  running: true,
  active: false,
  windowCount: 1,
};

function deniedFixture(): FakeComputerBackend {
  return new FakeComputerBackend({
    windows: [
      {
        id: "fake-editor",
        title: "Editor",
        appName: "org.kde.kate",
        pid: 1_000,
        bounds: { x: 1_100, y: 40, width: 700, height: 600 },
        focused: true,
        minimized: false,
        visible: true,
      },
      DENIED_WINDOW,
    ],
    apps: [
      {
        pid: 1_000,
        name: "Kate",
        bundleId: "org.kde.kate",
        running: true,
        active: true,
        windowCount: 1,
      },
      DENIED_APP,
    ],
  });
}

describe("computerDenylistMatch", () => {
  it("matches app names, bundle ids, prefixes, and executable paths", () => {
    expect(computerDenylistMatch({ name: "1Password" })?.matched).toBe("app name 1password");
    expect(computerDenylistMatch({ name: "1Password 8" })?.matched).toBe("app name 1password");
    expect(computerDenylistMatch({ name: "Keychain Access" })?.matched).toBe(
      "app name keychain access",
    );
    expect(computerDenylistMatch({ name: "System Settings" })?.matched).toBe(
      "app name system settings",
    );
    expect(computerDenylistMatch({ name: "SecurityAgent" })?.matched).toBe(
      "app name securityagent",
    );
    expect(computerDenylistMatch({ bundleId: "com.1password.1password" })?.matched).toBe(
      "bundle id com.1password.1password",
    );
    expect(computerDenylistMatch({ bundleId: "com.agilebits.onepassword7" })?.matched).toBe(
      "bundle id com.agilebits.onepassword*",
    );
    expect(computerDenylistMatch({ bundleId: "com.dashlane.dashlanephonefinal" })?.matched).toBe(
      "bundle id com.dashlane.*",
    );
    expect(computerDenylistMatch({ bundleId: "com.bitwarden.desktop" })?.matched).toBe(
      "bundle id com.bitwarden.desktop",
    );
    expect(
      computerDenylistMatch({ name: "/Applications/1Password.app/Contents/MacOS/1Password" })
        ?.matched,
    ).toBe("app name 1password");
  });

  it("does not match ordinary apps or near-miss spellings", () => {
    expect(computerDenylistMatch({ name: "org.kde.konsole" })).toBeUndefined();
    expect(computerDenylistMatch({ name: "Finder" })).toBeUndefined();
    expect(computerDenylistMatch({ name: "passwordsafe" })).toBeUndefined();
    expect(computerDenylistMatch({ bundleId: "com.example.passwordsafe2" })).toBeUndefined();
    expect(computerDenylistMatch({})).toBeUndefined();
  });

  it("refuses anything else that names itself a password manager too", () => {
    // The app-name prefix rule is deliberately broad: a surface calling
    // itself "Passwords …" or "1Password …" is exactly what the denylist
    // exists to keep the agent out of.
    expect(computerDenylistMatch({ name: "Passwords Manager Pro" })?.matched).toBe(
      "app name passwords",
    );
    expect(computerDenylistMatch({ name: "Bitwarden Lite" })?.matched).toBe("app name bitwarden");
  });
});

describe("computer denylist", () => {
  it("refuses to launch a denylisted app", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(manager.launchApp("thread-1", "1Password")).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    await expect(manager.launchApp("thread-1", "Keychain Access")).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    expect(backend.callsFor("launchApp")).toHaveLength(0);
    await manager.dispose();
  });

  it("refuses a bare-point click inside a denylisted window", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    // (400, 300) is inside the 1Password bounds, outside the editor's.
    await expect(manager.click("thread-1", { x: 400, y: 300 })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    expect(backend.callsFor("click")).toHaveLength(0);
    // A point outside the denied bounds still dispatches.
    await expect(manager.click("thread-1", { x: 1_200, y: 200 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await manager.dispose();
  });

  it("refuses a window-scoped click, move, frame, and keystroke on the denied window", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(
      manager.click("thread-1", { x: 400, y: 300, windowId: DENIED_WINDOW.id }),
    ).rejects.toMatchObject({ code: "computer_denylist_refused" });
    await expect(
      manager.setWindowFrame("thread-1", DENIED_WINDOW.id, {
        x: 0,
        y: 0,
        width: 400,
        height: 400,
      }),
    ).rejects.toMatchObject({ code: "computer_denylist_refused" });
    await expect(
      manager.typeText("thread-1", "master password", DENIED_WINDOW.id),
    ).rejects.toMatchObject({ code: "computer_denylist_refused" });
    await expect(manager.killApp("thread-1", DENIED_WINDOW.id)).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("setWindowFrame")).toHaveLength(0);
    expect(backend.callsFor("typeText")).toHaveLength(0);
    await manager.dispose();
  });

  it("refuses a scoped state read of a denylisted window but still lists it", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    // Presence stays enumerable: the model can see the surface exists.
    const listed = await manager.listWindows();
    expect(listed.windows.map((window) => window.id)).toContain(DENIED_WINDOW.id);
    await expect(manager.getState({ windowId: DENIED_WINDOW.id })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    await expect(
      manager.captureScreenshot({ kind: "window", windowId: DENIED_WINDOW.id }),
    ).rejects.toMatchObject({ code: "computer_denylist_refused" });
    await manager.dispose();
  });

  it("refuses a workspace screenshot while a denylisted window is visible", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(manager.getState({ includeScreenshot: true })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    // Without a screenshot the same read answers window metadata only.
    await expect(manager.getState()).resolves.toMatchObject({ computerId: "desktop" });
    await manager.dispose();
  });

  it("refuses semantic targeting into a denied window and while one is visible", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(
      manager.click("thread-1", { label: "Unlock", windowId: DENIED_WINDOW.id }),
    ).rejects.toMatchObject({ code: "computer_denylist_refused" });
    // An unscoped semantic query walks a desktop-wide tree that cannot exclude
    // the denied window's elements (non-macOS dialect), so it refuses too.
    await expect(manager.click("thread-1", { label: "Unlock" })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    await manager.dispose();
  });

  it("resolves a window's denied app through its pid when the name alone is clean", async () => {
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "fake-renamed",
          title: "Notes",
          appName: "Notes",
          pid: 3_001,
          bounds: { x: 100, y: 100, width: 600, height: 500 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ],
      apps: [
        {
          pid: 3_001,
          name: "Notes",
          bundleId: "com.bitwarden.desktop",
          running: true,
          active: false,
          windowCount: 1,
        },
      ],
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    await expect(manager.click("thread-1", { x: 300, y: 300 })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    await expect(manager.getState({ windowId: "fake-renamed" })).rejects.toMatchObject({
      code: "computer_denylist_refused",
    });
    await manager.dispose();
  });

  it("leaves the pane's own input exempt from the input denylist", async () => {
    const backend = deniedFixture();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    // The human at the keyboard (threadId undefined) is not a competing agent:
    // pane input to the denied window still dispatches.
    await expect(manager.click(undefined, { x: 400, y: 300 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await manager.dispose();
  });
});
