import type { AccountMe } from "@synara/contracts";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { useProfileIdentity } from "./useProfileIdentity";

const account = vi.hoisted(() => ({
  me: null as AccountMe | null,
  profileSyncEnabled: true,
  updateProfile: { mutateAsync: vi.fn() },
}));
vi.mock("~/hooks/useAccount", () => ({ useAccount: () => account }));

function readIdentity() {
  const result: { current?: ReturnType<typeof useProfileIdentity> } = {};
  function Probe() {
    result.current = useProfileIdentity({ name: "Machine default", handle: "@local" });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result.current!;
}

beforeEach(() => {
  account.me = {
    id: "user_1",
    name: "Login Name",
    email: "login@example.test",
    image: "https://example.test/login.png",
    organization: { id: "org_1", name: "Workspace" },
    profile: null,
  };
  account.profileSyncEnabled = true;
  vi.clearAllMocks();
  setLocalStorageItem("synara:profile:name:v1", "Local Name", Schema.String);
  setLocalStorageItem(
    "synara:profile:avatarImage:v1",
    "data:image/png;base64,local",
    Schema.String,
  );
});

describe("profile identity source", () => {
  it("shows login identity before onboarding, never a different local identity", () => {
    expect(readIdentity()).toMatchObject({
      name: "Login Name",
      avatarImage: "https://example.test/login.png",
    });
    account.me = { ...account.me!, image: undefined };
    expect(readIdentity().avatarImage).toBeNull();
  });

  it.each(["https://example.test/custom.png", null])(
    "preserves the saved profile and its explicit avatar choice %s",
    (avatarUrl) => {
      account.me = {
        ...account.me!,
        profile: {
          handle: "custom",
          displayName: "Custom Name",
          avatarColor: "#22c55e",
          avatarUrl,
        },
      };
      expect(readIdentity()).toMatchObject({ name: "Custom Name", avatarImage: avatarUrl });
    },
  );

  it("keeps local identity when signed out or account profiles are unavailable", () => {
    account.profileSyncEnabled = false;
    expect(readIdentity().name).toBe("Local Name");
    account.profileSyncEnabled = true;
    account.me = null;
    expect(readIdentity()).toMatchObject({
      name: "Local Name",
      avatarImage: "data:image/png;base64,local",
    });
  });

  it("shows the signed-in account's picture even when account profiles are unavailable", () => {
    account.profileSyncEnabled = false;
    expect(readIdentity().avatarImage).toBe("https://example.test/login.png");
  });

  it("does not silently save authenticated pre-onboarding edits into local identity", async () => {
    await expect(
      readIdentity().save({
        name: "New Name",
        handle: "new",
        avatarColor: "#22c55e",
        avatarImage: null,
      }),
    ).rejects.toThrow("Finish setting up");
    expect(getLocalStorageItem("synara:profile:name:v1", Schema.String)).toBe("Local Name");
    expect(account.updateProfile.mutateAsync).not.toHaveBeenCalled();
  });
});
