// FILE: AdvancedSettingsPanel.browser.tsx
// Purpose: Browser characterization for advanced-settings ownership and disclosure behavior.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { DateTime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  config: {
    keybindingsConfigPath: "/tmp/keybindings.json",
    availableEditors: [],
  },
  auth: { authenticated: true, role: "client" },
  threadShells: [] as unknown[],
  allThreadsMessageless: false,
  projects: [{ id: "project-1" }],
  threadsHydrated: true,
  syncServerReadModel: vi.fn(),
  createAuthPairingToken:
    vi.fn<() => Promise<{ credential: string; expiresAt: unknown; pairingBaseUrl?: string }>>(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) => ({
    data: options.queryKey[0] === "config" ? harness.config : harness.auth,
  }),
}));

vi.mock("~/lib/serverReactQuery", () => ({
  serverConfigQueryOptions: () => ({ queryKey: ["config"] }),
  serverAuthSessionQueryOptions: () => ({ queryKey: ["auth"] }),
}));

vi.mock("~/storeSelectors", () => ({
  createThreadShellsSelector: () => () => harness.threadShells,
  createAllThreadsMessagelessSelector: () => () => harness.allThreadsMessageless,
}));

vi.mock("~/store", () => ({
  useStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({
      projects: harness.projects,
      threadsHydrated: harness.threadsHydrated,
      syncServerReadModel: harness.syncServerReadModel,
    }),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    server: { createAuthPairingToken: harness.createAuthPairingToken },
  }),
  readNativeApi: () => undefined,
}));

import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";

describe("AdvancedSettingsPanel", () => {
  beforeEach(() => {
    harness.auth = { authenticated: true, role: "client" };
    harness.createAuthPairingToken.mockReset();
    harness.createAuthPairingToken.mockImplementation(async () => ({
      credential: "one-time-pairing-token",
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      pairingBaseUrl: "https://synara.example.test",
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("owns recovery eligibility, shared disclosure motion, and the release-history handoff", async () => {
    const onOpenReleaseHistory = vi.fn();
    await render(
      <AdvancedSettingsPanel active onOpenReleaseHistory={onOpenReleaseHistory} resetEpoch={0} />,
    );

    const repairButton = page.getByRole("button", { name: "Repair state" });
    expect((repairButton.element() as HTMLButtonElement).disabled).toBe(false);
    expect(document.body.textContent).toContain("Authenticated as client.");
    expect(page.getByRole("button", { name: "Create pairing link" }).query()).toBeNull();
    expect(harness.createAuthPairingToken).not.toHaveBeenCalled();

    const disclosureButton = page.getByRole("button", { name: "What this does" });
    expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("false");
    const disclosureShell = disclosureButton.element().parentElement?.querySelector("div[inert]");
    expect(disclosureShell?.className).toContain("duration-220");
    await disclosureButton.click();
    await vi.waitFor(() =>
      expect(disclosureButton.element().getAttribute("aria-expanded")).toBe("true"),
    );

    await page.getByRole("button", { name: "View release history" }).click();
    expect(onOpenReleaseHistory).toHaveBeenCalledOnce();
  });

  it("lets an owner generate a local QR, copy a fragment link, and drops it on owner loss", async () => {
    harness.auth.role = "owner";
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const view = await render(
      <AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />,
    );
    await page.getByRole("button", { name: "Create pairing link" }).click();
    await expect.element(page.getByRole("img", { name: "Pairing link QR code" })).toBeVisible();
    expect(document.querySelector("svg[aria-label='Pairing link QR code'] image")).toBeNull();
    expect(document.querySelector("[aria-label='Pairing link']")?.textContent).toBe(
      "https://synara.example.test/pair#token=one-time-pairing-token",
    );
    await page.getByRole("button", { name: "Copy link" }).click();
    expect(copy).toHaveBeenCalledWith(
      "https://synara.example.test/pair#token=one-time-pairing-token",
    );

    harness.auth = { authenticated: true, role: "client" };
    await view.rerender(
      <AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />,
    );
    expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
    expect(document.body.textContent).not.toContain("one-time-pairing-token");
    expect(page.getByRole("button", { name: "Create pairing link" }).query()).toBeNull();
  });

  it("removes the QR, link, and copy action at expiry without another interaction", async () => {
    harness.auth.role = "owner";
    harness.createAuthPairingToken.mockImplementation(async () => ({
      credential: "expiring-pairing-token",
      expiresAt: DateTime.makeUnsafe(Date.now() + 1_500),
      pairingBaseUrl: "http://192.168.1.10:3773",
    }));
    await render(<AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />);
    await page.getByRole("button", { name: "Create pairing link" }).click();
    await expect.element(page.getByRole("img", { name: "Pairing link QR code" })).toBeVisible();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("This pairing link has expired");
    expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
    expect(page.getByRole("button", { name: "Copy link" }).query()).toBeNull();
    expect(document.body.textContent).not.toContain("expiring-pairing-token");
  });

  it("requires a confirmed remote address when this browser is using loopback", async () => {
    harness.auth.role = "owner";
    harness.createAuthPairingToken.mockImplementation(async () => ({
      credential: "confirmed-address-token",
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
    }));
    await render(<AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />);
    await page.getByRole("button", { name: "Create pairing link" }).click();
    await expect.element(page.getByLabelText("Server address")).toBeVisible();
    expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
    expect(document.body.textContent).not.toContain("confirmed-address-token");
    await page.getByLabelText("Server address").fill("http://localhost:3773");
    await page.getByRole("button", { name: "Use this address" }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("public or LAN address");
    expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
    await page.getByLabelText("Server address").fill("http://192.168.1.10:3773");
    expect(document.body.textContent).not.toContain("confirmed-address-token");
    await page.getByRole("button", { name: "Use this address" }).click();
    await expect.element(page.getByRole("img", { name: "Pairing link QR code" })).toBeVisible();
    expect(document.querySelector("[aria-label='Pairing link']")?.textContent).toBe(
      "http://192.168.1.10:3773/pair#token=confirmed-address-token",
    );
  });

  it("fails closed for malformed or expired credentials and API errors", async () => {
    harness.auth.role = "owner";
    await render(<AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />);
    for (const expiresAt of [
      undefined,
      "not a date",
      "2099-02-30T00:00:00Z",
      "2020-01-01T00:00:00Z",
    ]) {
      harness.createAuthPairingToken.mockResolvedValueOnce({
        credential: "invalid-response-token",
        expiresAt,
        pairingBaseUrl: "https://synara.example.test",
      });
      await page.getByRole("button", { name: "Create pairing link" }).click();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Could not create a valid pairing link");
      expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
      expect(document.body.textContent).not.toContain("invalid-response-token");
    }
    harness.createAuthPairingToken.mockRejectedValueOnce(new Error("private backend error"));
    await page.getByRole("button", { name: "Create pairing link" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not create a valid pairing link");
    expect(document.body.textContent).not.toContain("private backend error");
  });

  it("ignores a credential returned after the owner closes advanced settings", async () => {
    harness.auth.role = "owner";
    let resolveCredential!: (value: {
      credential: string;
      expiresAt: unknown;
      pairingBaseUrl: string;
    }) => void;
    harness.createAuthPairingToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCredential = resolve;
        }),
    );
    const view = await render(
      <AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />,
    );
    await page.getByRole("button", { name: "Create pairing link" }).click();
    await view.rerender(
      <AdvancedSettingsPanel active={false} onOpenReleaseHistory={() => {}} resetEpoch={0} />,
    );
    resolveCredential({
      credential: "late-response-token",
      expiresAt: new Date(Date.now() + 90_000).toISOString(),
      pairingBaseUrl: "https://synara.example.test",
    });
    await view.rerender(
      <AdvancedSettingsPanel active onOpenReleaseHistory={() => {}} resetEpoch={0} />,
    );
    expect(document.body.textContent).not.toContain("late-response-token");
    expect(page.getByRole("img", { name: "Pairing link QR code" }).query()).toBeNull();
    await expect.element(page.getByRole("button", { name: "Create pairing link" })).toBeEnabled();
  });
});
