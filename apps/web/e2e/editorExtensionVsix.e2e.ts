import { createHash } from "node:crypto";
import { test, expect, type Page } from "playwright/test";
import { OpenVsxRegistry } from "../../server/src/extensions/openVsx";
import { capture } from "./extensionAcceptanceControls";
import { openEditorAcceptanceApp } from "./editorAcceptanceFixture";

const id = "esbenp.prettier-vscode";
const version = "12.4.0";

async function extensionState(page: Page) {
  return page.evaluate(async (id) => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
    const state = await ensureNativeApi().editor.extensions({ operation: "list" });
    return state.extensions.find((entry: { id: string }) => entry.id === id) as
      | {
          id: string;
          version: string;
          digest: string;
          enabled: boolean;
          approved: boolean;
          source: string;
        }
      | undefined;
  }, id);
}

async function chooseVsix(page: Page, name: string, buffer: Buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Install VSIX", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType: "application/octet-stream", buffer });
}

// Real file picker and chunked uploads. No intercepted HTTP/RPC or fake extension host.
test("local VSIX validation, explicit approval, configuration, replacement and removal", async ({
  page,
}, info) => {
  const registry = new OpenVsxRegistry();
  const archive = await registry.download(await registry.metadata(id, version));
  const digest = createHash("sha256").update(archive).digest("hex");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openEditorAcceptanceApp(page);
    await page.goto("/settings?section=extensions");
    await page.getByRole("radio", { name: /^Installed/ }).click();
    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();
    await capture(page, info, "before-local-vsix-native-settings");
    await chooseVsix(page, "invalid.vsix", Buffer.from("Not a ZIP archive."));
    await expect(page.getByRole("alert").first()).toBeVisible();
    expect(await extensionState(page)).toBeUndefined();
    await capture(page, info, "after-invalid-vsix-rejected-without-installation");

    await chooseVsix(page, "prettier.vsix", archive);
    const installed = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Installed extensions", exact: true }),
    });
    await expect(installed).toContainText(id, { timeout: 90_000 });
    await expect
      .poll(() => extensionState(page))
      .toMatchObject({ id, version, digest, source: "vsix", enabled: false, approved: false });
    await capture(page, info, "after-local-vsix-upload-installed-disabled");

    await installed.getByRole("button", { name: "Enable", exact: true }).click();
    const approval = page.getByRole("alertdialog");
    await expect(approval).toContainText(digest);
    await approval.getByRole("button", { name: "Enable approved versions" }).click();
    await expect(approval).not.toBeVisible();
    await expect.poll(() => extensionState(page)).toMatchObject({ enabled: true, approved: true });
    await installed.getByRole("button", { name: "Configure", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Extension settings as JSON" })
      .fill('{"prettier.singleQuote":true}');
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(async (id) => {
          const modulePath = "/src/nativeApi.ts";
          const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
          const result = await ensureNativeApi().editor.extensions({ operation: "inspect", id });
          return JSON.parse(result.configurationJson);
        }, id),
      )
      .toEqual({ "prettier.singleQuote": true });
    await capture(page, info, "after-local-extension-approval-and-configuration");

    // A replacement, even with the same package bytes, must not inherit execution approval.
    await chooseVsix(page, "prettier-replacement.vsix", archive);
    await expect
      .poll(() => extensionState(page), { timeout: 90_000 })
      .toMatchObject({ digest, enabled: false, approved: false });
    await capture(page, info, "after-vsix-replacement-requires-new-approval");
    await installed.getByRole("button", { name: "Remove", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Remove extension", exact: true })
      .click();
    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();
    expect(await extensionState(page)).toBeUndefined();
    expect(errors).toEqual([]);
    await info.attach("local-vsix-evidence", {
      body: JSON.stringify(
        {
          id,
          version,
          digest,
          source: "vsix",
          invalidPackageRejected: true,
          explicitApproval: true,
          configurationPersisted: true,
          replacementResetsApproval: true,
          removed: true,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  } finally {
    await page.evaluate(async (id) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const extensions = ensureNativeApi().editor.extensions;
      const state = await extensions({ operation: "list" });
      const entry = state.extensions.find(
        (item: { id: string; version: string }) => item.id === id,
      );
      if (entry) await extensions({ operation: "remove", id: entry.id, version: entry.version });
    }, id);
  }
});
