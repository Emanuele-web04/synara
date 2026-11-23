// Stable after Alto ends: the server keeps a granted check for at most 60 s, then fails closed.
// A cancelled plan, a sign-out and an Account API that drops off the network all lock SynBot (an
// outage only after a further 60 s grace, so a blip does not), and access comes back without a
// restart once Alto is reachable and active again.
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import {
  botsAccess,
  call,
  navigate,
  openApp,
  reload,
  reset,
  setBilling,
  setNetwork,
  signIn,
  sleep,
  switchState,
} from "./alto.ts";

/** The server's granted cache (synbotGate.ts) plus one denied re-check and polling slack. */
const CACHE_BOUND_MS = 60_000 + 5_000 + 5_000;
/** An unreachable Account API: the granted cache, then the grace a verified grant keeps. */
const OUTAGE_BOUND_MS = CACHE_BOUND_MS + 60_000;

/** Polls `bots.list` until it is refused; resolves to how long that took. */
async function msUntilRefused(
  browser: Parameters<typeof botsAccess>[0],
  since: number,
  boundMs = CACHE_BOUND_MS,
) {
  for (;;) {
    const access = await botsAccess(browser);
    if (access !== "ok") {
      expect(access).toBe("SUBSCRIPTION_REQUIRED");
      return Date.now() - since;
    }
    if (Date.now() - since > boundMs + 30_000) return Date.now() - since;
    await sleep(2_000);
  }
}

async function onAlto(browser: Parameters<typeof botsAccess>[0]) {
  await setBilling("alto");
  await signIn(browser);
  // The page's billing read records the grant on the server, as checkout's Refresh does.
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  await expect.poll(() => botsAccess(browser), { timeout: 20_000 }).toBe("ok");
}

test("Stable: a cancelled plan locks SynBot within the 60 s cache, and sign-out locks it at once", async ({
  app,
  browser,
  screen,
}) => {
  await openApp(app, browser);
  await reset(browser);
  await onAlto(browser);
  expect((await call(browser, "bots.ensureMain", {})).ok).toBe(true);

  // Cancelled at the Account API; nothing on this host asks again.
  const cancelledAt = Date.now();
  await setBilling("free");
  const lockedAfter = await msUntilRefused(browser, cancelledAt);
  expect(lockedAfter).toBeLessThanOrEqual(CACHE_BOUND_MS);
  // Locked for good, and the next load shows the gate.
  await sleep(6_000);
  expect(await botsAccess(browser)).toBe("SUBSCRIPTION_REQUIRED");
  await reload(app, browser);
  await navigate(browser, "/synbot");
  await expect(screen.getByText("SynBot requires Synara Alto (Pro)").first()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("cancelled-gate");

  // Renewed: unlocked again without a restart. Then sign-out locks at once, cache or not.
  await setBilling("alto");
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  await expect.poll(() => botsAccess(browser), { timeout: 20_000 }).toBe("ok");
  expect((await call(browser, "account.signOut")).ok).toBe(true);
  const signedOutAt = Date.now();
  expect(await msUntilRefused(browser, signedOutAt)).toBeLessThan(5_000);

  await reset(browser);
});

test("Stable: with the Account API offline SynBot fails closed, and it recovers when the network returns", async ({
  app,
  browser,
  screen,
}) => {
  await openApp(app, browser);
  await reset(browser);
  await onAlto(browser);

  const offlineAt = Date.now();
  await setNetwork(false);
  const lockedAfter = await msUntilRefused(browser, offlineAt, OUTAGE_BOUND_MS);
  expect(lockedAfter).toBeLessThanOrEqual(OUTAGE_BOUND_MS);
  expect((await switchState()).dropped).toBeGreaterThan(0);
  // A billing read while offline fails; it never unlocks anything.
  expect((await call(browser, "account.billingStatus")).ok).toBe(false);
  expect(await botsAccess(browser)).toBe("SUBSCRIPTION_REQUIRED");
  await reload(app, browser);
  await navigate(browser, "/synbot");
  await expect(screen.getByText("SynBot requires Synara Alto (Pro)").first()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("offline-gate");

  // The network returns: the next check reaches the Account API and Alto is still active.
  await setNetwork(true);
  await expect.poll(() => botsAccess(browser), { timeout: 20_000 }).toBe("ok");
  await reload(app, browser);
  await navigate(browser, "/synbot");
  await expect(screen.getByTestId("composer-editor")).toBeVisible({ timeout: 30_000 });
  await app.screenshot("back-online");

  await reset(browser);
});
