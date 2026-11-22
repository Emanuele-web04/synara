// Helpers for the Stable Alto lifecycle scenarios (e2e.stable-alto.config.ts): the Stable flavor
// with its billing UI, a fake Account API (fake-account.ts) behind fake-account-switch.ts.
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import type { Browser } from "@e2e-dev/web";
import { expect, type TestFixtures } from "e2e";

import { STABLE } from "../paths.ts";

export type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string | null; readonly message: string };

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `api.<namespace>.<method>(input)` in the page; a refusal comes back as an outcome. */
export const call = (browser: Browser, method: string, input?: unknown) =>
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

/** `bots.list` as the server answers it now: "ok" or the refusal code. */
export const botsAccess = async (browser: Browser) => {
  const outcome = await call(browser, "bots.list", {});
  return outcome.ok ? "ok" : (outcome.code ?? outcome.message);
};

export const navigate = (browser: Browser, path: string) =>
  browser.evaluate(async (target: string) => {
    (await import("/src/appNavigation.ts")).appHistory.push(target);
  }, path as never);

const accountUrl = () =>
  (
    JSON.parse(nodeFs.readFileSync(nodePath.join(STABLE.STATE_DIR, "account.json"), "utf8")) as {
      url: string;
    }
  ).url;

const post = async (path: string, body: unknown) => {
  const response = await fetch(`${accountUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

/** What the fake Account API answers for billing from now on. */
export const setBilling = (mode: "free" | "alto" | "error") =>
  post("/__scenario/billing", { mode });

/** Takes the Account API off the network (every call dropped) or puts it back. */
export const setNetwork = (up: boolean) => post("/__scenario/network", { up });

export const switchState = async () =>
  (await (await fetch(`${accountUrl()}/__scenario/network`)).json()) as {
    up: boolean;
    dropped: number;
    checkouts: number;
  };

/** Opens the app with first-run sheets dismissed; records opened sockets and popups. */
export async function openApp(app: TestFixtures["app"], browser: Browser) {
  await browser.addInitScript((worktrees: string) => {
    const seen = JSON.stringify([worktrees]);
    localStorage.setItem("synara:app-tour:v1", seen);
    localStorage.setItem("synara:project-import-announcement:v1", seen);
    localStorage.setItem("synara:activity-onboarding:v1", "seen");
    localStorage.setItem("synara:tasks-onboarding:v1", "seen");
    const probe = window as unknown as { __sockets: string[]; __opened: string[] };
    probe.__sockets = [];
    probe.__opened = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        probe.__sockets.push(String(url).split("?")[0] ?? "");
      }
    } as typeof WebSocket;
    // Checkout opens Polar in the browser: record it, never load it.
    window.open = ((url?: string | URL) => {
      probe.__opened.push(String(url ?? ""));
      return null;
    }) as typeof window.open;
  }, STABLE.WORKTREES_DIR as never);
  await reload(app, browser);
}

/** Loads the app again in the same tab (a new window load, not a server restart). */
export async function reload(app: TestFixtures["app"], browser: Browser) {
  await app.open("/");
  await expect
    .poll(
      () =>
        browser.evaluate(async () => Boolean((await import("/src/nativeApi.ts")).readNativeApi())),
      { timeout: 60_000 },
    )
    .toBe(true);
}

export const probe = (browser: Browser) =>
  browser.evaluate(() => {
    const window_ = window as unknown as {
      __sockets?: string[];
      __opened?: string[];
      __synbotStatuses?: string[];
    };
    return {
      sockets: window_.__sockets?.length ?? 0,
      opened: [...(window_.__opened ?? [])],
      statuses: [...(window_.__synbotStatuses ?? [])],
    };
  }) as Promise<{ sockets: number; opened: string[]; statuses: string[] }>;

/** From now on, every SynBot status the page goes through. */
export const recordSynbotStatuses = (browser: Browser) =>
  browser.evaluate(async () => {
    const { useSynbotStore } = await import("/src/synbot/synbotStore.ts");
    const seen = [useSynbotStore.getState().status];
    (window as unknown as { __synbotStatuses: string[] }).__synbotStatuses = seen;
    useSynbotStore.subscribe((state: { status: string }) => {
      if (seen.at(-1) !== state.status) seen.push(state.status);
    });
  });

export async function signIn(browser: Browser) {
  expect((await call(browser, "account.sendOtp", { email: "scenario@example.invalid" })).ok).toBe(
    true,
  );
  const outcome = await call(browser, "account.authenticateOtp", {
    email: "scenario@example.invalid",
    code: "123456",
  });
  expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
}

/** Back to a signed-out Free host with the network up, whatever a test left behind. */
export async function reset(browser: Browser) {
  await setNetwork(true);
  await setBilling("free");
  const status = await call(browser, "account.status");
  if (status.ok && (status.value as { state?: string }).state === "signed-in") {
    await call(browser, "account.signOut");
  }
}
