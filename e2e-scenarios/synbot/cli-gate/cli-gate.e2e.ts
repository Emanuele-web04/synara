// A server with no desktop flavor (the `npx synara` CLI, a headless server) requires Synara Alto
// for SynBot, like Stable: before, an unknown flavor got SynBot free.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { test, type Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { CLI } from "../paths.ts";
import { ENGINE } from "../scenarios/synbot.ts";

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string | null; readonly message: string };

const call = (browser: Browser, method: string, input?: unknown) =>
  browser.evaluate(
    async (request: { method: string; input: unknown }) => {
      const api = (await import("/src/nativeApi.ts")).readNativeApi();
      if (!api) throw new Error("native API is not ready");
      const [namespace, name] = request.method.split(".");
      try {
        const value = await api[namespace][name](request.input ?? undefined);
        return { ok: true, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) };
      } catch (cause) {
        const error = cause as { code?: unknown; message?: unknown };
        return {
          ok: false,
          code: typeof error?.code === "string" ? error.code : null,
          message: typeof error?.message === "string" ? error.message : String(cause),
        };
      }
    },
    { method, input: input ?? null } as never,
  ) as Promise<Outcome>;

const codeOf = (outcome: Outcome) => (outcome.ok ? "ALLOWED" : (outcome.code ?? outcome.message));

const account = () =>
  (
    JSON.parse(nodeFs.readFileSync(nodePath.join(CLI.STATE_DIR, "account.json"), "utf8")) as {
      url: string;
    }
  ).url;

const setBilling = async (mode: "free" | "alto") => {
  const response = await fetch(`${account()}/__scenario/billing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  expect(response.status).toBe(200);
};

const openApp = async (app: TestFixtures["app"], browser: Browser, path = "/") => {
  await app.open(path);
  await expect
    .poll(
      () =>
        browser.evaluate(async () => Boolean((await import("/src/nativeApi.ts")).readNativeApi())),
      { timeout: 60_000 },
    )
    .toBe(true);
};

test("a server with no desktop flavor requires Alto for SynBot", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript((worktrees: string) => {
    const seen = JSON.stringify([worktrees]);
    localStorage.setItem("synara:app-tour:v1", seen);
    localStorage.setItem("synara:project-import-announcement:v1", seen);
    localStorage.setItem("synara:activity-onboarding:v1", "seen");
    localStorage.setItem("synara:tasks-onboarding:v1", "seen");
  }, CLI.WORKTREES_DIR as never);
  await openApp(app, browser);

  // Signed out: refused, and the SynBot page shows the Alto gate.
  expect(codeOf(await call(browser, "bots.list", {}))).toBe("SUBSCRIPTION_REQUIRED");
  expect(codeOf(await call(browser, "bots.ensureMain", {}))).toBe("SUBSCRIPTION_REQUIRED");
  // Stopping still answers.
  expect(codeOf(await call(browser, "bots.stopAll", {}))).toBe("ALLOWED");
  await openApp(app, browser, "/synbot");
  await expect(screen.getByText("SynBot requires Synara Alto (Pro)").first()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("cli-signed-out-gate");

  // Signed in on Free: still refused. The CLI's web app can sign in to a Synara account.
  expect((await call(browser, "account.sendOtp", { email: "scenario@example.invalid" })).ok).toBe(
    true,
  );
  const signIn = await call(browser, "account.authenticateOtp", {
    email: "scenario@example.invalid",
    code: "123456",
  });
  expect(signIn.ok, JSON.stringify(signIn)).toBe(true);
  expect(codeOf(await call(browser, "bots.list", {}))).toBe("SUBSCRIPTION_REQUIRED");
  await openApp(app, browser, "/synbot");
  await expect(screen.getByText("SynBot requires Synara Alto (Pro)").first()).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("cli-free-gate");

  // With Alto the same server works.
  await setBilling("alto");
  expect((await call(browser, "account.billingStatus")).ok).toBe(true);
  const main = await call(browser, "bots.ensureMain", {});
  expect(main.ok, JSON.stringify(main)).toBe(true);
  const created = await call(browser, "bots.create", {
    requestId: `cli-${nodeCrypto.randomUUID()}`,
    name: "CLI bot",
    role: "Made with Alto on the CLI",
    mascot: { shape: "circle", color: "#1a80fa" },
    scope: { projects: "all", paths: [] },
    modelSelection: ENGINE,
    autonomy: "auto",
  });
  expect(created.ok, JSON.stringify(created)).toBe(true);
  // A page opened now shows SynBot, not the gate.
  await openApp(app, browser, "/synbot");
  await expect(screen.getByTestId("composer-editor").first()).toBeVisible({ timeout: 30_000 });
  await app.screenshot("cli-alto-synbot");
});
