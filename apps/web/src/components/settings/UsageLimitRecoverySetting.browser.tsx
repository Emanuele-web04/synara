import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { serverQueryKeys } from "~/lib/serverReactQuery";

const harness = vi.hoisted(() => ({ supported: true, update: vi.fn() }));
vi.mock("~/nativeApi", () => ({
  readNativeApiServerCapability: () => harness.supported,
  onNativeApiServerCapabilitiesChange: () => () => undefined,
  ensureNativeApi: () => ({ server: { updateSettings: harness.update } }),
}));

import { UsageLimitRecoverySetting } from "./UsageLimitRecoverySetting";

const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  return render(
    <QueryClientProvider client={client}>
      <UsageLimitRecoverySetting />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  harness.supported = true;
  harness.update.mockReset();
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  document.body.innerHTML = "";
});

describe("usage-limit recovery policy", () => {
  it("starts off and persists the explicit choice on the owning server", async () => {
    harness.update.mockImplementation(async (patch) => ({
      ...DEFAULT_SERVER_SETTINGS_VIEW,
      ...patch,
    }));
    await mount();
    const toggle = page.getByRole("switch", { name: "Resume after usage limits" });
    expect(toggle.element().getAttribute("aria-checked")).toBe("false");
    expect(harness.update).not.toHaveBeenCalled();
    await toggle.click();
    await vi.waitFor(() => expect(toggle.element().getAttribute("aria-checked")).toBe("true"));
    expect(harness.update).toHaveBeenCalledExactlyOnceWith({ autoResumeAfterUsageLimits: true });
    await toggle.click();
    await vi.waitFor(() => expect(toggle.element().getAttribute("aria-checked")).toBe("false"));
    expect(harness.update).toHaveBeenLastCalledWith({ autoResumeAfterUsageLimits: false });
  });

  it("does not offer an ineffective control on older hosts", async () => {
    harness.supported = false;
    await mount();
    await expect
      .element(page.getByRole("switch", { name: "Resume after usage limits" }))
      .not.toBeInTheDocument();
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("waits for server confirmation before claiming the choice is enabled", async () => {
    let resolve: ((value: typeof DEFAULT_SERVER_SETTINGS_VIEW) => void) | undefined;
    harness.update.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await mount();
    const toggle = page.getByRole("switch", { name: "Resume after usage limits" });
    await toggle.click();
    await vi.waitFor(() => expect(toggle.element().getAttribute("aria-disabled")).toBe("true"));
    expect(toggle.element().getAttribute("aria-checked")).toBe("false");
    expect(harness.update).toHaveBeenCalledOnce();
    resolve?.({ ...DEFAULT_SERVER_SETTINGS_VIEW, autoResumeAfterUsageLimits: true });
    await vi.waitFor(() => expect(toggle.element().getAttribute("aria-checked")).toBe("true"));
  });
});
