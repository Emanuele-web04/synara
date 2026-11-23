// The SynBot scenario fixture: what e2e cannot know about Synara.
//
//   synbot.script({ rules })   tells the fake agent what every bot does next
//   synbot.log()               what the fake agent saw and did (prompts, tool calls, results)
//   synbot.rpc(method, input)  calls a `bots.*` / `orchestration.*` RPC through the page
//   synbot.bot({ name })       creates a bot on the fake engine
//   synbot.open(bot)           opens the SynBot page on a bot, in-app
//
// Every bot runs on the fake Grok engine, so no model is ever called.
import * as nodeCrypto from "node:crypto";
import * as nodeFs from "node:fs";
import * as nodePath from "node:path";

import { test as base, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";

import type { Script } from "../fake-agent/fakeAcpAgent.ts";
import { RUN_DIR, runPaths } from "../paths.ts";

export const ENGINE = { provider: "grok", model: "grok-4.6" } as const;

export interface Bot {
  readonly id: string;
  readonly name: string;
  readonly threadId: string;
  readonly kind: "main" | "custom";
  readonly status: string;
  readonly autonomy: "auto" | "ask";
  readonly revision: number;
}

export interface LogEntry {
  readonly t: string;
  readonly event: string;
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly args?: unknown;
  readonly failed?: boolean;
  readonly result?: unknown;
  readonly rule?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `api.<namespace>.<method>(input)` in the page. */
const rpcIn = (browser: Browser, method: string, input: unknown) =>
  browser.evaluate(
    async (call: { method: string; input: unknown }) => {
      const module = await import("/src/nativeApi.ts");
      const api = module.readNativeApi();
      if (!api) throw new Error("native API is not ready");
      const [namespace, name] = call.method.split(".");
      const result = await api[namespace][name](call.input);
      return result === undefined ? null : JSON.parse(JSON.stringify(result));
    },
    { method, input } as never,
  );

const readLogAt = (logPath: string): LogEntry[] => {
  try {
    return nodeFs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogEntry);
  } catch {
    return [];
  }
};

export interface Synbot {
  readonly projectId: string;
  readonly main: Bot;
  script(script: Script): void;
  log(): LogEntry[];
  waitForLog(
    predicate: (entry: LogEntry) => boolean,
    options?: { timeoutMs?: number; count?: number },
  ): Promise<LogEntry[]>;
  rpc<T = unknown>(method: string, input?: unknown): Promise<T>;
  bot(input: {
    name: string;
    role?: string;
    autonomy?: "auto" | "ask";
    pinned?: boolean;
  }): Promise<Bot>;
  bots(): Promise<{ bots: Bot[]; delegations: unknown[]; tasks: unknown[]; settings: unknown }>;
  open(bot?: Bot): Promise<void>;
  send(text: string): Promise<void>;
}

/**
 * The fixture for a run whose app keeps its state under `paths` (see paths.ts): the default run,
 * or another flavor's run (`BETA`, `OLD_HOST`).
 */
export const makeSynbotTest = (paths: ReturnType<typeof runPaths>) => {
  const { DEMO_REPO, STATE_DIR, WORKTREES_DIR } = paths;
  const SCRIPT_PATH = nodePath.join(STATE_DIR, "script.json");
  const LOG_PATH = nodePath.join(STATE_DIR, "log.ndjson");
  const PROJECT_PATH = nodePath.join(STATE_DIR, "project.json");
  const readLog = () => readLogAt(LOG_PATH);
  return base.extend<{ synbot: Synbot }>({
    synbot: async ({ app, browser, screen }, use) => {
      // First-run sheets are keyed by the installation's worktrees folder.
      await browser.addInitScript((worktrees: string) => {
        const seen = JSON.stringify([worktrees]);
        localStorage.setItem("synara:app-tour:v1", seen);
        localStorage.setItem("synara:project-import-announcement:v1", seen);
        localStorage.setItem("synara:activity-onboarding:v1", "seen");
        localStorage.setItem("synara:tasks-onboarding:v1", "seen");
      }, WORKTREES_DIR as never);
      nodeFs.mkdirSync(STATE_DIR, { recursive: true });
      // Keep the previous test's log next to it for debugging; every test starts a fresh one.
      if (nodeFs.existsSync(LOG_PATH)) {
        nodeFs.renameSync(LOG_PATH, nodePath.join(STATE_DIR, `log-${Date.now()}.ndjson`));
      }
      nodeFs.writeFileSync(
        SCRIPT_PATH,
        JSON.stringify({ rules: [], fallback: [{ say: "SILENT" }] }),
      );

      await app.open("/");
      await expect
        .poll(
          () =>
            browser.evaluate(async () =>
              Boolean((await import("/src/nativeApi.ts")).readNativeApi()),
            ),
          { timeout: 60_000 },
        )
        .toBe(true);
      // "/" restores the last route or opens a fresh chat, asynchronously. A test that navigates
      // before that lands gets pulled back off its page by the late redirect (an app race on
      // main: RestoreOrCreateChatRoute does not cancel a fresh chat already being created).
      await expect
        .poll(() => browser.evaluate(() => location.pathname), { timeout: 30_000 })
        .toMatch(/^\/.+/);

      const rpc = <T>(method: string, input: unknown = {}) =>
        rpcIn(browser, method, input) as Promise<T>;

      // The server's cwd no longer becomes a project, so register the demo repository once per run.
      let projectId: string;
      try {
        projectId = JSON.parse(nodeFs.readFileSync(PROJECT_PATH, "utf8")).projectId;
      } catch {
        projectId = nodeCrypto.randomUUID();
        await rpc("orchestration.dispatchCommand", {
          type: "project.create",
          commandId: nodeCrypto.randomUUID(),
          projectId,
          kind: "project",
          title: "demo-app",
          workspaceRoot: DEMO_REPO,
          createdAt: new Date().toISOString(),
        });
        nodeFs.writeFileSync(PROJECT_PATH, JSON.stringify({ projectId }));
      }

      // No engine passed: with Codex and Claude disabled, SynBot must pick the one provider that
      // can run here (the fake Grok), as the page itself does on mount.
      const main = await rpc<Bot & { modelSelection: { provider: string } }>("bots.ensureMain", {});
      expect(main.modelSelection.provider).toBe("grok");

      const synbot: Synbot = {
        projectId,
        main,
        script(script) {
          nodeFs.writeFileSync(SCRIPT_PATH, JSON.stringify(script, null, 2));
        },
        log: readLog,
        async waitForLog(predicate, options = {}) {
          const deadline = Date.now() + (options.timeoutMs ?? 30_000);
          const count = options.count ?? 1;
          for (;;) {
            const found = readLog().filter(predicate);
            if (found.length >= count) return found;
            if (Date.now() > deadline) {
              throw new Error(
                `fake agent log never showed ${count} matching entr${count === 1 ? "y" : "ies"}; ` +
                  `last entries: ${JSON.stringify(
                    readLog()
                      .slice(-8)
                      .map((entry) => ({ ...entry, text: entry.text?.slice(-300) })),
                  )}`,
              );
            }
            await sleep(250);
          }
        },
        rpc,
        async bot(input) {
          return rpc<Bot>("bots.create", {
            requestId: `scenario-${input.name}-${nodeCrypto.randomUUID()}`,
            name: input.name,
            role: input.role ?? `${input.name} work`,
            mascot: { shape: "circle", color: "#1a80fa" },
            scope: { projects: "all", paths: [] },
            modelSelection: ENGINE,
            taskModelSelection: ENGINE,
            autonomy: input.autonomy ?? "auto",
            ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
          });
        },
        bots: () => rpc("bots.list"),
        async open(bot) {
          const target = bot && bot.kind !== "main" ? `/synbot?bot=${bot.id}` : "/synbot";
          await browser.evaluate(async (path: string) => {
            (await import("/src/appNavigation.ts")).appHistory.push(path);
          }, target as never);
          // The SynBot page's own composer: the chat home has one too, so any composer would
          // let a test type into home when the navigation has not landed.
          await expect(
            browser.locator('.synbot-shell [data-testid="composer-editor"]'),
          ).toBeVisible({
            timeout: 30_000,
          });
        },
        async send(text) {
          const composer = screen.getByTestId("composer-editor");
          await composer.tap();
          await composer.pressSequentially(text);
          await browser.keyboard.press("Enter");
        },
      };
      await use(synbot);
    },
  });
};

export const test = makeSynbotTest(runPaths(RUN_DIR));

export { expect };
