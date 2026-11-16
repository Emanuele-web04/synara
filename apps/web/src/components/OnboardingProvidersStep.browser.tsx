import "../index.css";

import type { ProviderKind, ServerProviderStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProvidersStep } from "../onboarding/steps/ProvidersStep";
import { useProviderDetection } from "../onboarding/useProviderDetection";
import { useProviderSetup } from "../onboarding/useProviderSetup";

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  refreshProviders: vi.fn(),
  updateSettingsAndWait: vi.fn(),
  settings: { disabledProviders: [] as ProviderKind[] },
}));
vi.mock("../nativeApi", () => {
  const api = {
    server: { getConfig: mocks.getConfig, refreshProviders: mocks.refreshProviders },
  };
  return { ensureNativeApi: () => api, readNativeApi: () => api };
});
vi.mock("../appSettings", async (importOriginal) => {
  const appSettings = {
    settings: mocks.settings,
    updateSettingsAndWait: mocks.updateSettingsAndWait,
  };
  return {
    ...(await importOriginal<typeof import("../appSettings")>()),
    useAppSettings: () => appSettings,
    getCustomBinaryPathForProvider: () => null,
  };
});

const codexStatus: ServerProviderStatus = {
  provider: "codex",
  instanceId: "codex",
  driver: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-09-23T13:33:18.154Z",
};

const clients: QueryClient[] = [];
beforeEach(() => {
  mocks.getConfig.mockReset().mockResolvedValue({ providers: [] });
  mocks.refreshProviders.mockReset();
  mocks.settings.disabledProviders = [];
  mocks.updateSettingsAndWait.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function ProvidersStepWithDetection() {
  const detection = useProviderDetection();
  const setup = useProviderSetup(detection);
  return <ProvidersStep detection={detection} setup={setup} />;
}

async function renderStep() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <ProvidersStepWithDetection />
    </QueryClientProvider>,
  );
}

it("does not report agents as not installed while the first probe is running", async () => {
  const pendingRefreshes: Array<(result: { providers: ServerProviderStatus[] }) => void> = [];
  mocks.refreshProviders.mockImplementation(
    () => new Promise((resolve) => pendingRefreshes.push(resolve)),
  );
  await renderStep();

  await expect.element(page.getByText("Detecting agents on this machine…")).toBeVisible();
  expect(page.getByText("Not installed").elements()).toHaveLength(0);

  for (const resolve of pendingRefreshes) resolve({ providers: [codexStatus] });

  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("1 connected · 0 need sign-in · 9 not installed"))
    .toBeVisible();
});

it("leaves missing agents unknown after a timeout and recovers on retry", async () => {
  const pendingRefreshes: Array<(error: Error) => void> = [];
  mocks.refreshProviders.mockImplementation(
    () => new Promise((_resolve, reject) => pendingRefreshes.push(reject)),
  );
  await renderStep();

  await expect.element(page.getByText("Detecting agents on this machine…")).toBeVisible();

  for (const reject of pendingRefreshes) reject(new Error("WebSocket RPC timed out"));

  await expect.element(page.getByText("Couldn't check all agents. Try Re-detect.")).toBeVisible();
  expect(page.getByText("Not installed").elements()).toHaveLength(0);

  mocks.refreshProviders.mockResolvedValue({ providers: [codexStatus] });
  await page.getByRole("button", { name: "Re-detect" }).click();
  await expect.element(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("1 connected · 0 need sign-in · 9 not installed"))
    .toBeVisible();
});

it("keeps the default agent connected while re-enabling it alongside a custom instance", async () => {
  const customCodex: ServerProviderStatus = {
    ...codexStatus,
    instanceId: "codex-work",
    authStatus: "unauthenticated",
  };
  const providers = [codexStatus, customCodex];
  mocks.getConfig.mockResolvedValue({ providers });
  mocks.refreshProviders.mockResolvedValue({ providers });
  mocks.updateSettingsAndWait.mockImplementationOnce(async () => {
    mocks.settings.disabledProviders = ["codex"];
  });
  await renderStep();

  const connected = page.getByText("1 connected · 0 need sign-in · 9 not installed");
  const disabled = page.getByText("0 connected · 0 need sign-in · 9 not installed");
  const codexSwitch = page.getByRole("switch", { name: "Codex", exact: true });
  await expect.element(connected).toBeVisible();
  await codexSwitch.click();
  await expect.element(disabled).toBeVisible();

  mocks.refreshProviders.mockResolvedValue({
    providers: [
      {
        ...codexStatus,
        enabled: false,
        status: "warning",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-09-23T13:33:19.154Z",
      },
      customCodex,
    ],
  });
  const detect = page.getByRole("button", { name: "Re-detect" });
  await detect.click();
  await expect.element(detect).toBeEnabled();

  let finishWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  mocks.updateSettingsAndWait.mockReturnValueOnce(pendingWrite);
  try {
    await codexSwitch.click();
    await expect.element(connected).toBeVisible();
  } finally {
    // A rejected save settles after settings are refetched, still disabled here.
    finishWrite();
  }
  await expect.element(disabled).toBeVisible();
  await expect.element(codexSwitch).not.toBeChecked();
});

it("switches on only the agents installed on this machine", async () => {
  const claudeSignedOut: ServerProviderStatus = {
    ...codexStatus,
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    driver: "claudeAgent",
    authStatus: "unauthenticated",
  };
  const providers = [codexStatus, claudeSignedOut];
  mocks.getConfig.mockResolvedValue({ providers });
  mocks.refreshProviders.mockResolvedValue({ providers });
  await renderStep();

  await expect
    .element(page.getByText("1 connected · 1 need sign-in · 8 not installed"))
    .toBeVisible();
  await expect.element(page.getByRole("switch", { name: "Codex", exact: true })).toBeChecked();
  // Installed but signed out: on, with sign-in offered in place.
  await expect.element(page.getByRole("switch", { name: "Claude", exact: true })).toBeChecked();
  await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  // Not on this machine: off, and not switchable until it is installed.
  const cursorSwitch = page.getByRole("switch", { name: "Cursor", exact: true });
  await expect.element(cursorSwitch).not.toBeChecked();
  await expect.element(cursorSwitch).toBeDisabled();
  expect(mocks.updateSettingsAndWait).not.toHaveBeenCalled();
});
