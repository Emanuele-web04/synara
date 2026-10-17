// Exercises the singleton profile sync with real React effects, theme storage,
// and account mutations; only the native account transport is substituted.
import type { AccountMe, AccountStatus, AccountUpdateProfileInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { accountQueryKeys } from "~/lib/accountReactQuery";
import { useAccount } from "./useAccount";
import { useProfileThemeAccentSync } from "./useProfileThemeAccentSync";
import { useTheme } from "./useTheme";

const transport = vi.hoisted(() => ({ status: vi.fn(), updateProfile: vi.fn() }));
const policy = vi.hoisted(() => ({ enabled: true }));
vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({ account: transport }),
  readNativeApi: () => ({ account: transport }),
}));
vi.mock("~/betaFeatures", () => ({ isBetaFeatureOn: () => policy.enabled }));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({ controller: { capabilities: { accountProfileSync: true } } }),
}));

let server: AccountStatus;
let client: QueryClient;
let theme: ReturnType<typeof useTheme>;
let account: ReturnType<typeof useAccount>;
const me = (): AccountMe => ({
  id: "user_1",
  name: "Ada",
  email: "ada@example.test",
  organization: { id: "org_1", name: "Workspace" },
  profile: {
    handle: "ada",
    displayName: "Ada",
    avatarColor: "#22c55e",
    public: false,
    avatarSource: "uploaded",
    avatarUrl: "https://example.test/avatar.webp",
    themeAccent: { light: "#0169cc", dark: "#0169cc" },
  },
});
const settleDebounce = () => new Promise((resolve) => setTimeout(resolve, 700));

function Probe() {
  account = useAccount();
  theme = useTheme();
  useProfileThemeAccentSync(account);
  return null;
}
async function mount() {
  client.setQueryData(accountQueryKeys.status(), server);
  await render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  flushSync(() => theme.resetAllThemes());
}

beforeEach(() => {
  policy.enabled = true;
  server = { state: "signed-in", me: me() };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  transport.status.mockImplementation(async () => server);
  transport.updateProfile.mockImplementation(async (input: AccountUpdateProfileInput) => {
    if (server.state !== "signed-in") throw new Error("signed out");
    const updated = { ...server.me, profile: { ...server.me.profile!, ...input } };
    server = { state: "signed-in", me: updated };
    return updated;
  });
});
afterEach(() => {
  client.clear();
  vi.resetAllMocks();
});

describe("profile theme sync", () => {
  it("does not publish theme edits while the owner chose a custom profile color", async () => {
    server = {
      state: "signed-in",
      me: { ...me(), profile: { ...me().profile!, accentColor: "#AB12EF" } },
    };
    await mount();
    flushSync(() => theme.updateThemePack("light", { accent: "#112233" }));
    await settleDebounce();
    expect(transport.updateProfile).not.toHaveBeenCalled();
  });

  it("coalesces theme edits and preserves identity, visibility, and avatar source", async () => {
    await mount();
    flushSync(() => {
      theme.updateThemePack("light", { accent: "#AABBCC" });
      theme.updateThemePack("light", { accent: "#112233" });
      theme.updateThemePack("dark", { accent: "#445566" });
    });
    expect(transport.updateProfile).not.toHaveBeenCalled();
    await expect.poll(() => transport.updateProfile.mock.calls.length).toBe(1);
    expect(transport.updateProfile).toHaveBeenCalledWith({
      handle: "ada",
      displayName: "Ada",
      avatarColor: "#22c55e",
      public: false,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      themeAccent: { light: "#112233", dark: "#445566" },
    });
    flushSync(() => {
      theme.setTheme("light");
      theme.updateThemePack("dark", { contrast: 30 });
    });
    await settleDebounce();
    expect(transport.updateProfile).toHaveBeenCalledTimes(1);
    expect(client.getQueryData<AccountStatus>(accountQueryKeys.status())).toMatchObject({
      me: { profile: { avatarSource: "uploaded", avatarUrl: "https://example.test/avatar.webp" } },
    });
  });

  it.each(["signed-out", "onboarding", "disabled"])("does not sync while %s", async (state) => {
    if (state === "signed-out") server = { state: "signed-out" };
    if (state === "onboarding") server = { state: "signed-in", me: { ...me(), profile: null } };
    if (state === "disabled") policy.enabled = false;
    await mount();
    flushSync(() => theme.updateThemePack("dark", { accent: "#445566" }));
    await settleDebounce();
    expect(transport.updateProfile).not.toHaveBeenCalled();
  });

  it("cancels a pending theme write when the account signs out", async () => {
    await mount();
    flushSync(() => {
      theme.updateThemePack("dark", { accent: "#445566" });
      server = { state: "signed-out" };
      client.setQueryData(accountQueryKeys.status(), server);
    });
    await settleDebounce();
    expect(transport.updateProfile).not.toHaveBeenCalled();
  });

  it("waits for a manual profile save and uses its updated fields", async () => {
    await mount();
    let finish!: () => void;
    transport.updateProfile.mockImplementationOnce(
      (input: AccountUpdateProfileInput) =>
        new Promise<AccountMe>((resolve) => {
          finish = () => {
            const updated = { ...me(), profile: { ...me().profile!, ...input } };
            server = { state: "signed-in", me: updated };
            resolve(updated);
          };
        }),
    );
    const saving = account.updateProfile.mutateAsync({
      handle: "ada",
      displayName: "New name",
      avatarColor: "#ffffff",
      public: true,
    });
    await expect.poll(() => transport.updateProfile.mock.calls.length).toBe(1);
    flushSync(() => {
      theme.updateThemePack("light", { accent: "#112233" });
      theme.updateThemePack("dark", { accent: "#445566" });
    });
    await settleDebounce();
    expect(transport.updateProfile).toHaveBeenCalledTimes(1);
    finish();
    await saving;
    await expect.poll(() => transport.updateProfile.mock.calls.length).toBe(2);
    expect(transport.updateProfile.mock.lastCall?.[0]).toMatchObject({
      displayName: "New name",
      avatarColor: "#ffffff",
      public: true,
      themeAccent: { light: "#112233", dark: "#445566" },
    });
  });

  it.each(["old server", "failure"])("does not repeatedly write after %s", async (outcome) => {
    await mount();
    if (outcome === "failure") transport.updateProfile.mockRejectedValue(new Error("offline"));
    else
      transport.updateProfile.mockResolvedValue({
        ...me(),
        profile: { ...me().profile!, themeAccent: undefined },
      });
    flushSync(() => theme.updateThemePack("dark", { accent: "#445566" }));
    await expect.poll(() => transport.updateProfile.mock.calls.length).toBe(1);
    await settleDebounce();
    expect(transport.updateProfile).toHaveBeenCalledTimes(1);
  });
});
