import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { expect, it } from "vitest";
import { createE2eFixture } from "./harness/fixture";
import { startWorkspace } from "./harness/workspace";
import { workspaceRpc } from "./harness/rpc";
import type { HostConnection } from "@synara/contracts";
import { requestLocalRemoteAccess } from "../../server/src/remotePairing/cli";

async function settings(page: Page, origin: string) {
  for (const name of ["Skip setup", "Not now"]) {
    await page.addLocatorHandler(
      page.getByRole("button", { name, exact: true }),
      async (button) => {
        await button.click();
      },
    );
  }
  await page.goto(`${origin}/settings?section=connections`);
  await page.getByRole("button", { name: "Create pairing code", exact: true }).waitFor();
}

it.skipIf(process.env.SYNARA_E2E_WORKSPACE !== "1")(
  "retries pairing after a connector outage through both browser screens and exact key approval",
  async () => {
    if (!process.env.TEST_DATABASE_URL) throw new Error("Isolated TEST_DATABASE_URL required");
    await using fixture = await createE2eFixture(process.env.TEST_DATABASE_URL);
    await fixture.linkHost();
    const controllerDir = path.join(fixture.baseDir, "controller");
    await fixture.prepareController(controllerDir);
    await using host = await startWorkspace(fixture.baseDir, fixture);
    await using controller = await startWorkspace(controllerDir, fixture);
    const browser = await chromium.launch({ headless: true });
    try {
      const hostPage = await browser.newPage({
        viewport: { width: 1440, height: 1600 },
        reducedMotion: "reduce",
      });
      const controllerPage = await browser.newPage({
        viewport: { width: 1440, height: 1600 },
        reducedMotion: "reduce",
      });
      await settings(hostPage, host.origin);
      await settings(controllerPage, controller.origin);
      await hostPage.getByRole("button", { name: "Create pairing code", exact: true }).click();
      const code = hostPage.locator('[aria-label="Pairing code"]');
      await code.waitFor();
      const text = await code.innerText();
      expect(text).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      await fixture.waitReady();
      await controllerPage.getByLabel("Pairing code from the other computer").fill(text);
      await controllerPage.getByRole("button", { name: "Find computer", exact: true }).click();
      await controllerPage
        .getByRole("checkbox", { name: "All identity groups match on both computers" })
        .waitFor();
      const state = await requestLocalRemoteAccess(host.baseDir, { operation: "list" });
      if (state.kind !== "host-state" || !state.rootFingerprint) throw new Error("Missing root");
      await controllerPage
        .getByText(state.rootFingerprint.match(/.{1,8}/g)!.join(" "), { exact: true })
        .waitFor();
      expect(
        await controllerPage
          .getByRole("button", { name: "Request access", exact: true })
          .isDisabled(),
      ).toBe(true);
      await controllerPage
        .getByRole("checkbox", { name: "All identity groups match on both computers" })
        .click();
      const evidence = process.env.SYNARA_E2E_EVIDENCE;
      if (evidence) {
        await fs.mkdir(evidence, { recursive: true });
        await hostPage.screenshot({
          path: path.join(evidence, "pairing-code.png"),
          fullPage: true,
        });
        await controllerPage.screenshot({
          path: path.join(evidence, "pairing-root-comparison.png"),
          fullPage: true,
        });
      }
      // A redeemed code must survive a failed dial: users should be able to
      // retry the same reviewed identity after connectivity returns.
      await fixture.stopConnector();
      await controllerPage.getByRole("button", { name: "Request access", exact: true }).click();
      await controllerPage.getByRole("alert").waitFor();
      await expect
        .poll(async () =>
          controllerPage.getByRole("button", { name: "Request access", exact: true }).isEnabled(),
        )
        .toBe(true);
      await fixture.restartConnector();
      await controllerPage.getByRole("button", { name: "Request access", exact: true }).click();
      const device = await requestLocalRemoteAccess(controller.baseDir, {
        operation: "device-info",
      });
      if (device.kind !== "device-info") throw new Error("Missing device key");
      await hostPage.getByText(device.deviceJkt, { exact: true }).waitFor();
      if (evidence)
        await hostPage.screenshot({
          path: path.join(evidence, "pairing-exact-device-approval.png"),
          fullPage: true,
        });
      await hostPage.getByRole("button", { name: "Approve this device", exact: true }).click();
      await controllerPage
        .getByText("Device approved. You can now connect to this computer.", { exact: true })
        .waitFor();
      await controllerPage.reload();
      await controllerPage.getByRole("button", { name: "Connect", exact: true }).first().click();
      await using rpc = await workspaceRpc(controller.origin);
      await expect
        .poll(
          async () => {
            const result = await rpc.request<{ connections: HostConnection[] }>(
              "hosts.listConnections",
              {},
            );
            return result.connections.some(
              (connection) =>
                connection.transport === "cloudflare" && connection.state === "connected",
            );
          },
          { timeout: 10_000 },
        )
        .toBe(true);
    } finally {
      await browser.close();
    }
  },
  90_000,
);
