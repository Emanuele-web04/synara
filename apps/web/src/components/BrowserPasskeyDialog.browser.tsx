import "../index.css";
import type { BrowserPasskeyMethods, BrowserPasskeyPrompt } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { NATIVE_SURFACE_OCCLUSION_SYNC_EVENT } from "~/lib/nativeSurfaceOcclusion";
const harness = vi.hoisted(() => ({ api: undefined as BrowserPasskeyMethods | undefined }));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({ browser: { passkeys: harness.api } }) }));
import { BrowserPasskeyDialog } from "./BrowserPasskeyDialog";

let prompt: BrowserPasskeyPrompt | null;
let changed: () => void;
beforeEach(() => {
  prompt = {
    id: "synthetic",
    origin: "https://login.example.com",
    rpId: "example.com",
    phase: "confirm",
    svg: null,
  };
  changed = () => {};
  harness.api = {
    snapshot: vi.fn(async () => prompt),
    start: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    onChanged: (listener) => {
      changed = listener;
      return () => {
        changed = () => {};
      };
    },
  };
});
it("requires Continue before pairing and shows the requesting origin", async () => {
  await render(<BrowserPasskeyDialog />);
  await expect.element(page.getByText("https://login.example.com", { exact: true })).toBeVisible();
  await expect.element(page.getByText("Passkey for example.com")).toBeVisible();
  expect(harness.api!.start).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  expect(harness.api!.start).toHaveBeenCalledWith("synthetic");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(harness.api!.cancel).toHaveBeenCalledWith("synthetic");
});
it("resynchronizes native browser occlusion when the dialog mounts and unmounts", async () => {
  const notify = vi.fn();
  window.addEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, notify);
  try {
    const mounted = await render(<BrowserPasskeyDialog />);
    await vi.waitFor(() => expect(notify).toHaveBeenCalled());
    notify.mockClear();
    await mounted.unmount();
    expect(notify).toHaveBeenCalled();
  } finally {
    window.removeEventListener(NATIVE_SURFACE_OCCLUSION_SYNC_EVENT, notify);
  }
});
it("renders pairing as an image and removes it once the phone connects", async () => {
  await render(<BrowserPasskeyDialog />);
  prompt = {
    ...prompt!,
    phase: "qr",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><rect width="280" height="280" fill="white"/></svg>',
  };
  changed();
  await expect
    .element(page.getByRole("img", { name: "Scan this QR code with your phone to sign in" }))
    .toBeVisible();
  await page.screenshot({ path: "__screenshots__/phone-passkey-dialog.png" });
  prompt = { ...prompt, phase: "waiting", svg: null };
  changed();
  await expect.element(page.getByRole("status")).toBeVisible();
  await expect
    .element(page.getByRole("img", { name: "Scan this QR code with your phone to sign in" }))
    .not.toBeInTheDocument();
});
