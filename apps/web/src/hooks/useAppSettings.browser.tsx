import { DEFAULT_SERVER_SETTINGS_VIEW } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useAppSettings } from "../appSettings";
import { serverQueryKeys } from "../lib/serverReactQuery";

const updateSettings = vi.hoisted(() => vi.fn());
vi.mock("../nativeApi", () => ({
  ensureNativeApi: () => ({ server: { updateSettings } }),
}));

it("propagates opted-in save failures without breaking best-effort writes or the mutation queue", async () => {
  const storageKeys = ["synara:app-settings:v1", "synara:server-settings-migrated:v1"];
  const previous = storageKeys.map((key) => localStorage.getItem(key));
  localStorage.removeItem(storageKeys[0]!);
  localStorage.setItem(storageKeys[1]!, "1");
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const hook = await renderHook(() => useAppSettings(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  try {
    const failure = new Error("Settings RPC failed");
    updateSettings
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        ...DEFAULT_SERVER_SETTINGS_VIEW,
        confirmClaudeCacheResume: false,
      });
    await expect(
      hook.result.current.updateSettingsAndWait(
        { confirmClaudeCacheResume: false },
        { throwOnError: true },
      ),
    ).rejects.toBe(failure);
    expect(client.getQueryData(serverQueryKeys.settings())).toMatchObject({
      confirmClaudeCacheResume: true,
    });
    await expect(
      hook.result.current.updateSettingsAndWait({ confirmClaudeCacheResume: false }),
    ).resolves.toBeUndefined();
    await hook.result.current.updateSettingsAndWait(
      { confirmClaudeCacheResume: false },
      { throwOnError: true },
    );
    expect(updateSettings).toHaveBeenCalledTimes(3);
    expect(client.getQueryData(serverQueryKeys.settings())).toMatchObject({
      confirmClaudeCacheResume: false,
    });
  } finally {
    await hook.unmount();
    client.clear();
    storageKeys.forEach((key, index) => {
      const value = previous[index];
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
  }
});
