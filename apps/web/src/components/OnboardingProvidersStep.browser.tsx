import "../index.css";

import type { ServerProviderStatus } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProvidersStep } from "../onboarding/steps/ProvidersStep";
import {
  PROVIDER_DETECTION_TIMEOUT_MS,
  useProviderDetection,
} from "../onboarding/useProviderDetection";

const mocks = vi.hoisted(() => ({ getConfig: vi.fn(), refreshProviders: vi.fn() }));
vi.mock("../nativeApi", () => {
  const api = {
    server: { getConfig: mocks.getConfig, refreshProviders: mocks.refreshProviders },
  };
  return { ensureNativeApi: () => api, readNativeApi: () => api };
});
vi.mock("../appSettings", () => {
  // Stable like the real store; the step resyncs its draft when this reference changes.
  const appSettings = { settings: { disabledProviders: [] }, updateSettingsAndWait: vi.fn() };
  return { useAppSettings: () => appSettings, getCustomBinaryPathForProvider: () => null };
});
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (select: (state: { homeDir: null }) => unknown) =>
    select({ homeDir: null }),
}));

const codexStatus: ServerProviderStatus = {
  provider: "codex",
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-09-23T13:33:18.154Z",
};

const clients: QueryClient[] = [];
beforeEach(() => {
  // A fresh install has no cached provider statuses until the first probe finishes.
  mocks.getConfig.mockReset().mockResolvedValue({ providers: [] });
  mocks.refreshProviders.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function ProvidersStepWithDetection() {
  const detection = useProviderDetection();
  return <ProvidersStep detection={detection} />;
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
  // The server joins overlapping refreshes into one probe, so every caller settles together.
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
    .element(page.getByText("1 connected · 0 need sign-in · 8 not installed"))
    .toBeVisible();
});

it("falls back to not installed when detection never answers", async () => {
  mocks.refreshProviders.mockImplementation(() => new Promise(() => {}));
  // Fake only the detection cap; element polling below needs real timers again.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await renderStep();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(page.getByText("Detecting agents on this machine…").elements()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(PROVIDER_DETECTION_TIMEOUT_MS);
  } finally {
    vi.useRealTimers();
  }

  await expect
    .element(page.getByText("0 connected · 0 need sign-in · 9 not installed"))
    .toBeVisible();
});
