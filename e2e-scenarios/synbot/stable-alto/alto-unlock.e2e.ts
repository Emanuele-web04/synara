// Stable, from the paywall to a working SynBot through the UI: signed out (the gate, its Beta
// badge, no flicker), signed in on Free (still locked; View Alto plans opens Usage & Billing,
// which lists SynBot), then checkout and Refresh unlock SynBot in the same window, with no reload
// and no server restart.
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { STABLE } from "../paths.ts";
import {
  botsAccess,
  navigate,
  openApp,
  probe,
  recordSynbotStatuses,
  reset,
  setBilling,
  sleep,
  switchState,
} from "./alto.ts";

const GATE = "SynBot requires Synara Alto (Pro)";

test("Stable: the paywall holds signed out and on Free, and checkout unlocks SynBot without a restart", async ({
  app,
  browser,
  screen,
}) => {
  nodeFs.mkdirSync(STABLE.STATE_DIR, { recursive: true });
  nodeFs.writeFileSync(
    nodePath.join(STABLE.STATE_DIR, "script.json"),
    JSON.stringify({
      rules: [{ match: "ALTO-PING", steps: [{ say: "PONG from SynBot on Alto." }] }],
      fallback: [{ say: "SILENT" }],
    }),
  );
  await openApp(app, browser);
  await reset(browser);
  await recordSynbotStatuses(browser);

  // 1. Signed out: the gate with its Beta badge, Sign in and View Alto plans.
  await navigate(browser, "/synbot");
  const gate = browser.locator(".synbot-shell__alto");
  await expect(gate.getByText(GATE)).toBeVisible({ timeout: 30_000 });
  await expect(gate.getByText("Beta", { exact: true })).toBeVisible();
  await expect(gate.getByRole("button", "Sign in")).toBeVisible();
  await expect(gate.getByRole("button", "View Alto plans")).toBeVisible();
  await expect(screen.getByTestId("composer-editor")).toHaveCount(0);
  await app.screenshot("signed-out-paywall");
  // No flicker: once refused, the page stays on the gate and keeps its socket.
  const settled = await probe(browser);
  await sleep(10_000);
  const later = await probe(browser);
  expect(later.sockets - settled.sockets).toBe(0);
  expect(later.statuses.slice(settled.statuses.length)).toEqual([]);
  expect(later.statuses.filter((status) => status === "subscription_required")).toHaveLength(1);
  await expect(gate.getByText(GATE)).toBeVisible();

  // 2. Signed in on Free (through the gate's Sign in, with the fake account's one code): still
  // locked; View Alto plans leads to Usage & Billing.
  await gate.getByRole("button", "Sign in").tap();
  const email = screen.getByLabel("Email");
  await expect(email).toBeVisible({ timeout: 20_000 });
  await email.fill("scenario@example.invalid");
  await browser.keyboard.press("Enter");
  const code = screen.getByLabel("Sign-in code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  await code.pressSequentially("123456");
  const verify = screen.getByRole("button", "Verify");
  if ((await verify.count()) > 0 && (await verify.isEnabled())) await verify.tap();
  await expect(code).toHaveCount(0, { timeout: 20_000 });
  await expect(gate.getByRole("button", "Sign in")).toHaveCount(0, { timeout: 20_000 });
  await expect(gate.getByText(GATE)).toBeVisible();
  expect(await botsAccess(browser)).toBe("SUBSCRIPTION_REQUIRED");
  await gate.getByRole("button", "View Alto plans").tap();
  const synbotRow = screen.getByText("SynBot (Beta)");
  await expect(synbotRow).toBeVisible({ timeout: 30_000 });
  await expect(
    screen.getByText("Your crew of coding bots that delegate work, run tasks and report back."),
  ).toBeVisible();
  await app.screenshot("free-plans");

  // 3. Checkout opens Polar's sandbox (recorded, never loaded); the payment goes through.
  const marker = await browser.evaluate(() => {
    (window as unknown as { __sameWindow: number }).__sameWindow = Date.now();
    return (window as unknown as { __sameWindow: number }).__sameWindow;
  });
  const checkoutsBefore = (await switchState()).checkouts;
  await screen.getByRole("button", "Choose monthly").tap();
  const opened = screen
    .getByRole("status")
    .filter({ hasText: "Test billing opened in your browser." });
  await expect(opened).toBeVisible({
    timeout: 20_000,
  });
  expect((await probe(browser)).opened).toEqual(["https://sandbox.polar.sh/checkout/scenario"]);
  expect((await switchState()).checkouts - checkoutsBefore).toBe(1);
  await setBilling("alto");
  await opened.getByRole("button", "Refresh").tap();
  await expect(screen.getByText("Active", { exact: true })).toBeVisible({ timeout: 20_000 });
  await app.screenshot("alto-active");

  // 4. Back to SynBot in the same window: unlocked, and the main SynBot answers.
  await navigate(browser, "/synbot");
  await expect(screen.getByTestId("composer-editor")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByText(GATE)).toHaveCount(0);
  expect(
    await browser.evaluate(() => (window as unknown as { __sameWindow?: number }).__sameWindow),
  ).toBe(marker);
  expect(await botsAccess(browser)).toBe("ok");
  const composer = screen.getByTestId("composer-editor");
  await composer.tap();
  await composer.pressSequentially("ALTO-PING are you there");
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("PONG from SynBot on Alto.").last()).toBeVisible({
    timeout: 60_000,
  });
  await app.screenshot("alto-unlocked");

  await reset(browser);
});
