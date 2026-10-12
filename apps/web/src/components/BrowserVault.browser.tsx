import "../index.css";
import type {
  BrowserCookieImportResult,
  BrowserVaultMethods,
  BrowserVaultSnapshot,
} from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ api: undefined as BrowserVaultMethods | undefined }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ browser: { vault: harness.api } }) }));
import { BrowserVaultButton, BrowserVaultDialog } from "./BrowserVault";
import { BrowserCookieImport } from "./BrowserCookieImport";
import { BrowserPasswordImport } from "./BrowserPasswordImport";
import { BrowserImportPanel } from "./BrowserImportPanel";
import {
  SafariAccessOnboarding,
  SafariAccessSetupButton,
  SAFARI_ACCESS_STORAGE_KEY,
} from "./SafariAccessOnboarding";

let state: BrowserVaultSnapshot;
let changed: () => void;
beforeEach(() => {
  changed = () => {};
  state = {
    protection: { configured: true, locked: false, osProtected: true },
    settings: { agentUse: true, offerSave: false, autosave: false },
    logins: [],
    pending: [],
    error: null,
  };
  harness.api = {
    snapshot: vi.fn(async () => state),
    setupMaster: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
    reveal: vi.fn(async () => ({ password: "synthetic-revealed", expiresAt: Date.now() + 20_000 })),
    cookieSources: vi.fn(async () => []),
    cookieProfiles: vi.fn(async () => []),
    inventoryChromiumProfiles: vi.fn(async () => []),
    importCookies: vi.fn(async () => ({
      ok: true as const,
      imported: 0,
      skipped: 0,
      sessionRestore: "available" as const,
      browser: "chrome" as const,
      platform: "macos" as const,
      warnings: [],
    })),
    cancelCookieImport: vi.fn(async () => {}),
    importPasswords: vi.fn(async () => ({
      ok: true as const,
      imported: 0,
      skipped: 0,
      warnings: [],
    })),
    configure: vi.fn(async (settings) => {
      state = { ...state, settings };
      changed();
      return state;
    }),
    remove: vi.fn(async (id) => {
      state = { ...state, logins: state.logins.filter((login) => login.id !== id) };
      changed();
      return state;
    }),
    respond: vi.fn(async ({ id }) => {
      state = { ...state, pending: state.pending.filter((prompt) => prompt.id !== id) };
      changed();
    }),
    onChanged: (listener) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  };
});

describe("browser saved logins", () => {
  it("hides runtime catalog sources that have no local profiles", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([
      { id: "chrome", name: "Google Chrome" },
      { id: "brave", name: "Brave" },
    ]);
    vi.mocked(api.cookieProfiles).mockImplementation(async (browser) =>
      browser === "chrome" ? [{ id: "Default", name: "Personal" }] : [],
    );

    await render(<BrowserImportPanel api={api} />);

    await expect.element(page.getByText("Google Chrome")).toBeVisible();
    await expect.element(page.getByText("Brave")).not.toBeInTheDocument();
    await expect.element(page.getByText("No profiles found.")).not.toBeInTheDocument();
  });

  it("clears consent on refresh without reselecting profiles the user unchecked", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([
      { id: "Default", name: "Personal" },
      { id: "Profile 1", name: "Work" },
    ]);
    await render(<BrowserImportPanel api={api} />);

    const personal = page.getByRole("checkbox", { name: "Select Google Chrome Personal" });
    const work = page.getByRole("checkbox", { name: "Select Google Chrome Work" });
    const consent = page.getByRole("checkbox", { name: /I authorize Synara and its agents/ });
    const importButton = page.getByRole("button", { name: "Import selected sessions" });
    await work.click();
    await consent.click();
    await page.getByRole("button", { name: "Refresh browser list" }).click();

    await expect.element(personal).toBeChecked();
    await expect.element(work).not.toBeChecked();
    await expect.element(consent).not.toBeChecked();
    await expect.element(importButton).toBeDisabled();
  });

  it("preselects installed session profiles and imports only after whole-profile consent", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([
      { id: "Default", name: "Personal" },
      { id: "Profile 1", name: "Work" },
    ]);
    vi.mocked(api.inventoryChromiumProfiles).mockResolvedValue([
      {
        id: "chrome",
        name: "Google Chrome",
        profileStatus: "available",
        profiles: [
          {
            id: "Default",
            name: "Personal",
            isDefault: true,
            cookieCount: 3,
            passwordCount: 0,
            cookieStatus: "available",
            passwordStatus: "available",
          },
        ],
      },
    ]);
    vi.mocked(api.importCookies).mockResolvedValue({
      ok: true,
      imported: 2,
      skipped: 1,
      sessionRestore: "available",
      browser: "chrome",
      platform: "macos",
      warnings: [],
    });

    await render(<BrowserImportPanel api={api} />);

    const personal = page.getByRole("checkbox", { name: "Select Google Chrome Personal" });
    const work = page.getByRole("checkbox", { name: "Select Google Chrome Work" });
    await expect.element(personal).toBeChecked();
    await expect.element(work).toBeChecked();
    await expect.element(page.getByText("Cookies: 3")).toBeVisible();
    const consent = page.getByRole("checkbox", { name: /I authorize Synara and its agents/ });
    const importButton = page.getByRole("button", { name: "Import selected sessions" });
    await expect.element(importButton).toBeDisabled();
    await consent.click();
    await importButton.click();
    await expect
      .element(page.getByText("Google Chrome — Personal: 2 imported, 1 skipped."))
      .toBeVisible();
    await expect
      .element(page.getByText("Google Chrome — Work: 2 imported, 1 skipped."))
      .toBeVisible();
    expect(api.importCookies).toHaveBeenCalledTimes(2);
    expect(api.importCookies).toHaveBeenNthCalledWith(1, {
      browser: "chrome",
      profile: "Default",
      scope: "profile",
      confirmed: true,
    });
    expect(api.importCookies).toHaveBeenNthCalledWith(2, {
      browser: "chrome",
      profile: "Profile 1",
      scope: "profile",
      confirmed: true,
    });
  });

  it("explains Windows App-Bound cookie gaps when Chrome or Edge decryption warnings occur", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "Default", name: "Personal" }]);
    vi.mocked(api.importCookies).mockResolvedValue({
      ok: true,
      imported: 0,
      skipped: 0,
      sessionRestore: "unavailable",
      browser: "chrome",
      platform: "windows",
      warnings: [{ code: "decrypt_failed", count: 1 }],
    });

    await render(<BrowserImportPanel api={api} />);
    await page.getByRole("checkbox", { name: /I authorize Synara and its agents/ }).click();
    await page.getByRole("button", { name: "Import selected sessions" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Synara does not use App-Bound injection");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("sign in within Synara for those sites");
  });

  it("distinguishes source cookie limits from target-profile capacity", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "Default", name: "Personal" }]);
    vi.mocked(api.importCookies).mockResolvedValue({
      ok: false,
      code: "target_capacity",
      platform: "linux",
    });

    await render(<BrowserImportPanel api={api} />);
    await page.getByRole("checkbox", { name: /I authorize Synara and its agents/ }).click();
    await page.getByRole("button", { name: "Import selected sessions" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Existing target cookies were preserved");
  });

  it("cancels the active profile and does not start later selected profiles", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "chrome", name: "Google Chrome" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([
      { id: "Default", name: "Personal" },
      { id: "Profile 1", name: "Work" },
    ]);
    let settleImport!: (result: BrowserCookieImportResult) => void;
    vi.mocked(api.importCookies).mockImplementationOnce(
      () => new Promise((resolve) => (settleImport = resolve)),
    );
    vi.mocked(api.cancelCookieImport).mockImplementationOnce(async () => {
      settleImport({ ok: false, code: "cancelled", platform: "linux" });
    });

    await render(<BrowserImportPanel api={api} />);
    await page.getByRole("checkbox", { name: /I authorize Synara and its agents/ }).click();
    await page.getByRole("button", { name: "Import selected sessions" }).click();
    await page.getByRole("button", { name: "Cancel import" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Import cancelled. Some cookies may already have been copied");
    expect(api.cancelCookieImport).toHaveBeenCalledOnce();
    expect(api.importCookies).toHaveBeenCalledOnce();
  });

  it("preselects an installed profile and requires explicit password import consent", async () => {
    const api = harness.api!;
    vi.mocked(api.inventoryChromiumProfiles).mockResolvedValue([
      {
        id: "chrome",
        name: "Google Chrome",
        profileStatus: "available",
        profiles: [
          {
            id: "Default",
            name: "Personal",
            isDefault: true,
            cookieCount: 3,
            passwordCount: 2,
            cookieStatus: "available",
            passwordStatus: "available",
          },
        ],
      },
    ]);
    vi.mocked(api.importPasswords).mockResolvedValue({
      ok: true,
      imported: 1,
      skipped: 1,
      warnings: [],
    });

    await render(<BrowserPasswordImport api={api} />);
    const profile = page.getByRole("checkbox", { name: /Personal/ });
    const consent = page.getByRole("checkbox", { name: /I authorize Synara/ });
    await expect.element(profile).toBeChecked();
    await expect
      .element(page.getByRole("button", { name: "Import selected passwords" }))
      .toBeDisabled();
    await consent.click();
    await page.getByRole("button", { name: "Import selected passwords" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Google Chrome — Personal: 1 imported, 1 skipped.");
    expect(api.importPasswords).toHaveBeenCalledWith({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    });
  });

  it("shows when no password-import profiles are available on macOS", async () => {
    const api = harness.api!;
    vi.mocked(api.inventoryChromiumProfiles).mockResolvedValue([]);

    await render(<BrowserPasswordImport api={api} />);

    await expect
      .element(
        page.getByText("No installed Chromium browser profiles are available for password import."),
      )
      .toBeVisible();
  });

  it.each(["Linux x86_64", "Win32"])(
    "explains saved-password import is unsupported on %s without offering vault setup",
    async (platformValue) => {
      const api = harness.api!;
      vi.mocked(api.inventoryChromiumProfiles).mockResolvedValue([]);
      state = {
        ...state,
        protection: { configured: false, locked: true, osProtected: false },
      };
      const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue(platformValue);

      try {
        await render(<BrowserPasswordImport api={api} />);
        await expect
          .element(
            page.getByText("Saved-password import is not supported on Linux or Windows yet."),
          )
          .toBeVisible();
        await expect
          .element(page.getByRole("button", { name: /Set up Saved Logins|Unlock Saved Logins/ }))
          .not.toBeInTheDocument();
        expect(api.snapshot).not.toHaveBeenCalled();
        expect(api.inventoryChromiumProfiles).not.toHaveBeenCalled();
      } finally {
        platform.mockRestore();
      }
    },
  );

  it("sets up a locked Saved Logins vault before allowing password import", async () => {
    const api = harness.api!;
    state = {
      ...state,
      protection: { configured: false, locked: true, osProtected: false },
    };
    vi.mocked(api.inventoryChromiumProfiles).mockResolvedValue([
      {
        id: "chrome",
        name: "Google Chrome",
        profileStatus: "available",
        profiles: [
          {
            id: "Default",
            name: "Personal",
            isDefault: true,
            cookieCount: 0,
            passwordCount: 1,
            cookieStatus: "available",
            passwordStatus: "available",
          },
        ],
      },
    ]);
    vi.mocked(api.setupMaster).mockImplementation(async () => {
      state = {
        ...state,
        protection: { configured: true, locked: false, osProtected: false },
      };
    });
    vi.mocked(api.importPasswords).mockResolvedValue({
      ok: true,
      imported: 1,
      skipped: 0,
      warnings: [],
    });

    await render(<BrowserPasswordImport api={api} />);
    const setup = page.getByRole("button", { name: "Set up Saved Logins" });
    await expect.element(setup).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Import selected passwords" }))
      .toBeDisabled();
    await setup.click();
    await page.getByLabelText("New master password").fill("throwaway-master-password");
    await page.getByLabelText("Confirm master password").fill("throwaway-master-password");
    await page.getByRole("button", { name: "Set master password" }).click();
    await expect
      .element(page.getByRole("button", { name: "Set up Saved Logins" }))
      .not.toBeInTheDocument();
    await page.getByRole("checkbox", { name: /I authorize Synara/ }).click();
    await page.getByRole("button", { name: "Import selected passwords" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("1 imported, 0 skipped");
    expect(api.setupMaster).toHaveBeenCalledWith("throwaway-master-password");
    expect(api.importPasswords).toHaveBeenCalledWith({
      browser: "chrome",
      profile: "Default",
      confirmed: true,
    });
  });

  it("refreshes vault access when another control unlocks Saved Logins", async () => {
    const api = harness.api!;
    state = {
      ...state,
      protection: { configured: true, locked: true, osProtected: false },
    };
    await render(<BrowserPasswordImport api={api} />);
    await expect.element(page.getByRole("button", { name: "Unlock Saved Logins" })).toBeVisible();

    state = {
      ...state,
      protection: { configured: true, locked: false, osProtected: false },
    };
    changed();

    await expect
      .element(page.getByRole("button", { name: "Unlock Saved Logins" }))
      .not.toBeInTheDocument();
  });

  it("still reports actual permission denial after continuing past Safari setup", async () => {
    const previous = window.desktopBridge;
    const previousDecision = localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY);
    const api = harness.api!;
    try {
      localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
      window.desktopBridge = {
        ...previous,
        safariAccess: {
          getInfo: async () => ({
            supported: true,
            appName: "Synara",
            appPath: "/Applications/Synara.app",
          }),
          openSettings: async () => true,
          revealApp: async () => true,
        },
      } as NonNullable<typeof previous>;
      vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
      vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
      vi.mocked(api.importCookies).mockResolvedValue({
        ok: false,
        code: "permission_denied",
        platform: "macos",
      });
      await render(
        <>
          <SafariAccessOnboarding>
            <BrowserCookieImport
              api={api}
              destination={{
                threadId: ThreadId.makeUnsafe("cookie-test"),
                tabId: "tab",
                origin: "https://example.test",
              }}
            />
          </SafariAccessOnboarding>
          <SafariAccessSetupButton />
        </>,
      );
      await page.getByRole("button", { name: "Safari import setup" }).click();
      await page.getByRole("button", { name: "Open System Settings" }).click();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent(
          "System Settings is open. Once Synara is switched on, quit and reopen it.",
        );
      await page.getByRole("button", { name: "Not now" }).click();
      await page.getByRole("button", { name: "Import browser cookies" }).click();
      await page.getByRole("button", { name: "Import for this site" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("macOS denied access");
      await expect.element(page.getByRole("status")).toHaveTextContent("Settings > General");
    } finally {
      if (previous) window.desktopBridge = previous;
      else delete window.desktopBridge;
      if (previousDecision === null) localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
      else localStorage.setItem(SAFARI_ACCESS_STORAGE_KEY, previousDecision);
    }
  });

  it("requires fresh explicit all-profile consent and shows Safari-specific native denial", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
    vi.mocked(api.importCookies).mockResolvedValue({
      ok: false,
      code: "permission_denied",
      platform: "macos",
    });
    const destination = {
      threadId: ThreadId.makeUnsafe("cookie-test"),
      tabId: "tab",
      origin: "https://accounts.google.com",
    };
    await render(<BrowserCookieImport api={api} destination={destination} />);
    await page.getByRole("button", { name: "Import browser cookies" }).click();
    await expect.element(page.getByRole("button", { name: "Import for this site" })).toBeEnabled();
    const scope = document.querySelector<HTMLSelectElement>('[aria-label="Cookie import scope"]')!;
    scope.value = "profile";
    scope.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Import all sites" }).click();
    expect(api.importCookies).toHaveBeenCalledExactlyOnceWith({
      threadId: destination.threadId,
      tabId: "tab",
      browser: "safari",
      profile: "default",
      scope: "profile",
      confirmed: true,
    });
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("macOS denied access to Safari's cookie files");
    await expect.element(page.getByRole("status")).not.toHaveTextContent("Windows");
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
  });

  it("offers confirmed whole-profile import without a current website", async () => {
    const api = harness.api!;
    vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
    vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
    await render(
      <BrowserCookieImport
        api={api}
        destination={{
          threadId: ThreadId.makeUnsafe("cookie-test"),
          tabId: "blank-tab",
          origin: null,
        }}
      />,
    );
    await page.getByRole("button", { name: "Import browser cookies" }).click();
    await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
    await page.getByRole("checkbox").click();
    await page.getByRole("button", { name: "Import all sites" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("0 cookies imported");
  });

  it.each([
    [{ code: "reader_failed", stage: "parse" }, "cookie-format failure"],
    [
      { sessionRestore: "unavailable", imported: 3, skipped: 2 },
      "3 cookies imported. 2 skipped. Secure restoration of session-only cookies is unavailable",
    ],
  ] as const)(
    "distinguishes reader errors and session restoration warnings",
    async (failure, message) => {
      const api = harness.api!;
      vi.mocked(api.cookieSources).mockResolvedValue([{ id: "safari", name: "Safari" }]);
      vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "default", name: "default" }]);
      const result =
        "sessionRestore" in failure
          ? ({
              ok: true,
              imported: failure.imported,
              skipped: failure.skipped,
              sessionRestore: failure.sessionRestore,
              browser: "safari",
              platform: "macos",
              warnings: [],
            } satisfies BrowserCookieImportResult)
          : ({
              ok: false,
              platform: "macos",
              ...failure,
            } satisfies BrowserCookieImportResult);
      vi.mocked(api.importCookies).mockResolvedValue(result);
      await render(
        <BrowserCookieImport
          api={api}
          destination={{
            threadId: ThreadId.makeUnsafe("cookie-test"),
            tabId: "tab",
            origin: "https://example.test",
          }}
        />,
      );
      await page.getByRole("button", { name: "Import browser cookies" }).click();
      await page.getByRole("button", { name: "Import for this site" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent(message);
      await expect.element(page.getByRole("status")).not.toHaveTextContent("Windows");
    },
  );
  it.each(["helium", "aside", "arc", "dia"] as const)(
    "imports %s through the existing picker and renews whole-profile consent",
    async (browser) => {
      const api = harness.api!;
      vi.mocked(api.cookieSources).mockResolvedValue([{ id: browser, name: browser }]);
      vi.mocked(api.cookieProfiles).mockResolvedValue([{ id: "Default", name: "Default" }]);
      const destination = {
        threadId: ThreadId.makeUnsafe("cookie-test"),
        tabId: "tab",
        origin: "https://example.test",
      };
      await render(<BrowserCookieImport api={api} destination={destination} />);
      await page.getByRole("button", { name: "Import browser cookies" }).click();
      await page.getByRole("button", { name: "Import for this site" }).click();
      expect(api.importCookies).toHaveBeenCalledExactlyOnceWith({
        ...destination,
        browser,
        profile: "Default",
        scope: "site",
      });
      const scope = document.querySelector<HTMLSelectElement>(
        '[aria-label="Cookie import scope"]',
      )!;
      scope.value = "profile";
      scope.dispatchEvent(new Event("change", { bubbles: true }));
      await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
      await page.getByRole("checkbox").click();
      await page.getByRole("button", { name: "Import all sites" }).click();
      expect(api.importCookies).toHaveBeenLastCalledWith({
        threadId: destination.threadId,
        tabId: "tab",
        browser,
        profile: "Default",
        scope: "profile",
        confirmed: true,
      });
      await expect.element(page.getByRole("button", { name: "Import all sites" })).toBeDisabled();
    },
  );

  it("requires the master password for reveal and hides the secret on blur", async () => {
    state = {
      ...state,
      logins: [
        {
          id: "agent-1",
          origin: "https://example.test",
          username: "signup",
          label: null,
          source: "agent",
          status: "pending",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Reveal password for signup" }).click();
    expect(harness.api?.reveal).not.toHaveBeenCalled();
    await page.getByLabelText("Master password", { exact: true }).fill("synthetic-master");
    await page.getByRole("button", { name: "Reveal password", exact: true }).click();
    expect(harness.api?.reveal).toHaveBeenCalledWith({
      id: "agent-1",
      password: "synthetic-master",
    });
    await expect
      .element(page.getByLabelText("Revealed password"))
      .toHaveValue("synthetic-revealed");
    window.dispatchEvent(new Event("blur"));
    await expect.element(page.getByLabelText("Revealed password")).not.toBeInTheDocument();
  });

  it("does not display a late reveal after the authentication panel is cancelled", async () => {
    let resolve!: (result: { password: string; expiresAt: number }) => void;
    harness.api!.reveal = vi.fn(
      () =>
        new Promise<{ password: string; expiresAt: number }>((done) => {
          resolve = done;
        }),
    );
    state = {
      ...state,
      logins: [
        {
          id: "agent-1",
          origin: "https://example.test",
          username: "signup",
          label: null,
          source: "agent",
          status: "saved",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Reveal password for signup" }).click();
    await page.getByLabelText("Master password", { exact: true }).fill("synthetic-master");
    await page.getByRole("button", { name: "Reveal password", exact: true }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    resolve({ password: "late-synthetic-secret", expiresAt: Date.now() + 20_000 });
    await expect.element(page.getByLabelText("Revealed password")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("late-synthetic-secret");
  });

  it("requires saving consent before enabling autosave", async () => {
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await expect
      .element(page.getByRole("switch", { name: "Autosave accepted logins" }))
      .toBeDisabled();
    await page.getByRole("switch", { name: "Offer to save passwords" }).click();
    expect(harness.api?.configure).toHaveBeenCalledWith({
      agentUse: true,
      offerSave: true,
      autosave: false,
    });
    await expect
      .element(page.getByRole("switch", { name: "Autosave accepted logins" }))
      .toBeEnabled();
  });

  it("limits agent consent to account discovery and states that autofill is unavailable", async () => {
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await expect
      .element(page.getByText("Agent password filling and generation are unavailable."))
      .toBeVisible();
    await page.getByRole("switch", { name: "Allow agents to find saved accounts" }).click();
    expect(harness.api?.configure).toHaveBeenCalledWith({
      agentUse: false,
      offerSave: false,
      autosave: false,
    });
    await expect
      .element(page.getByRole("switch", { name: "Allow agents to use saved logins" }))
      .not.toBeInTheDocument();
  });

  it("shows a metadata-only save prompt and never a credential-entry form", async () => {
    state = {
      ...state,
      settings: { ...state.settings, offerSave: true },
      pending: [
        { id: "prompt-1", origin: "https://example.test", username: "alice", mode: "save" },
      ],
    };
    await render(<BrowserVaultDialog />);
    await expect.element(page.getByRole("heading", { name: "Save password?" })).toBeVisible();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(harness.api?.respond).toHaveBeenCalledWith({ id: "prompt-1", save: true });
  });

  it("requires confirmation before deleting a saved login", async () => {
    state = {
      ...state,
      logins: [
        {
          id: "credential-1",
          origin: "https://example.test",
          username: "alice",
          label: null,
          source: "agent",
          status: "saved",
          updatedAt: "2026-09-07T00:00:00Z",
        },
      ],
    };
    await render(
      <>
        <BrowserVaultButton />
        <BrowserVaultDialog />
      </>,
    );
    await page.getByRole("button", { name: "Saved logins", exact: true }).click();
    await page.getByRole("button", { name: "Delete login for alice" }).click();
    expect(harness.api?.remove).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    expect(harness.api?.remove).toHaveBeenCalledWith("credential-1");
    await expect.element(page.getByText("No saved logins.")).toBeVisible();
  });
});
