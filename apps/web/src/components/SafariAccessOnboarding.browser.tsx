import "../index.css";
import type { DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  SafariAccessOnboarding,
  SafariAccessSetupButton,
  SAFARI_ACCESS_STORAGE_KEY,
} from "./SafariAccessOnboarding";

const originalBridge = window.desktopBridge;
const api = {
  getInfo: vi.fn(async () => ({
    supported: true as const,
    appName: "Synara (Dev)",
    appPath: "/Applications/Synara (Dev).app",
  })),
  openSettings: vi.fn(async () => true),
  revealApp: vi.fn(async () => true),
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
  window.desktopBridge = { safariAccess: api } as unknown as DesktopBridge;
});
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
});

function Harness() {
  return (
    <>
      <SafariAccessOnboarding>
        <p>Next welcome</p>
      </SafariAccessOnboarding>
      <SafariAccessSetupButton />
    </>
  );
}

describe("Safari access onboarding", () => {
  it("shows optional first-launch guidance and serializes other welcome dialogs", async () => {
    await render(<Harness />);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("Next welcome")).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("It's optional");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("broad macOS permission");
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Synara (Dev)");
    await expect
      .element(page.getByRole("button", { name: "Show app in Finder" }))
      .toHaveAttribute("title", "/Applications/Synara (Dev).app");
    expect(api.openSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it("persists Not now across remounts and allows revisiting", async () => {
    const mounted = await render(<Harness />);
    await page.getByRole("button", { name: "Not now", exact: true }).click();
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)!)).toBe("later");
    await mounted.unmount();
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Safari import setup" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  });

  it("still honors the legacy continued decision", async () => {
    localStorage.setItem(SAFARI_ACCESS_STORAGE_KEY, JSON.stringify("continued"));
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("opening Settings is not permission approval or an acknowledged intro", async () => {
    await render(<Harness />);
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("quit and reopen");
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
    await page.getByRole("button", { name: "Show app in Finder" }).click();
    expect(api.revealApp).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("status")).toHaveTextContent("selected in Finder");
  });

  it.each([false, "reject"])(
    "leaves manual settings and skip available after open failure %s",
    async (failure) => {
      if (failure === false) api.openSettings.mockResolvedValueOnce(false);
      else api.openSettings.mockRejectedValueOnce(new Error("private failure"));
      await render(<Harness />);
      await page.getByRole("button", { name: "Open System Settings" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("Couldn't open");
      await expect.element(page.getByRole("status")).not.toHaveTextContent("private failure");
      await page.getByRole("button", { name: "Not now" }).click();
      await expect.element(page.getByText("Next welcome")).toBeVisible();
    },
  );

  it.each(["web", "unsupported", "unavailable"])(
    "does not show macOS onboarding on %s",
    async (mode) => {
      if (mode === "web") delete window.desktopBridge;
      else
        window.desktopBridge = {
          safariAccess: {
            ...api,
            getInfo:
              mode === "unsupported"
                ? async () => ({ supported: false })
                : async () => {
                    throw new Error("unavailable");
                  },
          },
        } as unknown as DesktopBridge;
      await render(<Harness />);
      await expect.element(page.getByText("Next welcome")).toBeVisible();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: "Safari import setup" }))
        .not.toBeInTheDocument();
      expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
    },
  );

  it("does not reopen for a late Settings response after skipping", async () => {
    let resolve!: (opened: boolean) => void;
    api.openSettings.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(<Harness />);
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
    resolve(true);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});
