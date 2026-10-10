// Authentication launch proof uses disposable CLI fixtures; it never signs in to real providers.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type ProviderKind, type ServerSettings } from "@synara/contracts";
import { applyServerSettingsPatch } from "@synara/shared/serverSettings";
import {
  providerStartOptionsFromInstance,
  deriveProviderInstances,
} from "@synara/shared/providerInstances";
import { afterEach, expect, it } from "vitest";
import { ServerSettingsService } from "../serverSettings";
import { getDevinApiKeyEnv } from "../provider/acp/DevinAcpSupport";
import { PtyAdapter } from "./Services/PTY";
import { layer as NodePtyLive } from "./Layers/NodePTY";
import { TerminalManagerRuntime } from "./Layers/Manager";
import {
  prepareProviderAuthenticationSettings,
  resolveProviderAuthenticationLaunch,
} from "./providerAuthentication";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(provider: ProviderKind) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "synara-login-")));
  roots.push(root);
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  mkdirSync(homeDir);
  mkdirSync(stateDir);
  // Deliberately exercise an absolute executable containing spaces and shell metacharacters.
  const binaryPath = path.join(root, "provider ' fixture");
  writeFileSync(
    binaryPath,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const env = process.env;
const home = env.CODEX_HOME || env.CLAUDE_CONFIG_DIR || env.CURSOR_CONFIG_DIR || env.GROK_HOME || env.PI_CODING_AGENT_DIR || env.HOME;
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home, user: env.USER, logname: env.LOGNAME, ambient: env.OPENAI_API_KEY || env.FACTORY_API_KEY || env.WINDSURF_API_KEY || env.GEMINI_API_KEY || '', authority: env.SYNARA_AUTH_TOKEN || '', nativeFlag: env.ELECTRON_RUN_AS_NODE || '' }));
process.stdin.once('data', () => { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'fixture-auth.json'), 'fixture-only'); process.exit(0); });
`,
    { mode: 0o755 },
  );
  const instanceId = `${provider}_work`;
  const settings: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [instanceId]: { driver: provider, config: { binaryPath } },
    },
  };
  const baseEnv = {
    PATH: path.dirname(process.execPath),
    HOME: homeDir,
    USER: "fixture-user",
    LOGNAME: "fixture-user",
    SYNARA_HOME: path.join(root, "synara"),
    OPENAI_API_KEY: "ambient-fixture",
    FACTORY_API_KEY: "ambient-fixture",
    WINDSURF_API_KEY: "ambient-fixture",
    windsurf_api_key: "ambient-lowercase-fixture",
    GEMINI_API_KEY: "ambient-fixture",
    SYNARA_AUTH_TOKEN: "authority-fixture",
    ELECTRON_RUN_AS_NODE: "1",
  };
  return { root, homeDir, stateDir, instanceId, settings, baseEnv };
}

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Fixture terminal did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

it.skipIf(process.platform === "win32").each([
  ["codex", ["login"]],
  ["claudeAgent", ["auth", "login"]],
  ["cursor", ["login"]],
  ["devin", ["auth", "login"]],
  ["antigravity", []],
  ["grok", ["login"]],
  ["droid", []],
  ["opencode", ["auth", "login"]],
  ["pi", []],
  ["omp", []],
] as const)(
  "runs %s authentication through a real isolated PTY and preserves a completed login on reattach",
  async (provider, argv) => {
    const input = fixture(provider);
    const patch = prepareProviderAuthenticationSettings(input);
    const settings = patch ? applyServerSettingsPatch(input.settings, patch) : input.settings;
    const launch = await resolveProviderAuthenticationLaunch({ ...input, settings });
    // Native providers must persist exactly the roots later managed sessions receive.
    if (["devin", "antigravity", "droid"].includes(provider)) {
      const instance = deriveProviderInstances(settings).find(
        (entry) => entry.instanceId === input.instanceId,
      )!;
      const options = providerStartOptionsFromInstance(instance) as Record<
        string,
        { environment: Record<string, string> }
      >;
      expect(options[provider]?.environment.HOME).toBe(launch.env.HOME);
      expect(options[provider]?.environment.XDG_DATA_HOME).toBe(launch.env.XDG_DATA_HOME);
      if (provider === "droid") expect(options[provider]?.environment.FACTORY_API_KEY).toBe("");
      if (provider === "devin")
        expect(
          getDevinApiKeyEnv({ ...input.baseEnv, ...options[provider]?.environment }),
        ).toBeUndefined();
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const ptyAdapter = yield* PtyAdapter;
          const manager = new TerminalManagerRuntime({
            logsDir: path.join(input.root, "logs"),
            ptyAdapter,
            providerAuthResolver: async () => launch,
          });
          try {
            const events: string[] = [];
            manager.on("event", (event) => {
              if (event.type === "output") events.push(event.data);
            });
            const open = {
              threadId: "auth-fixture",
              terminalId: "login",
              cwd: input.root,
              providerAuthInstanceId: input.instanceId,
            };
            const snapshot = yield* Effect.promise(() => manager.open(open));
            expect(snapshot.status).toBe("running");
            yield* Effect.promise(() => until(() => events.join("").includes('"argv"')));
            const line = events
              .join("")
              .split(/\r?\n/)
              .find((value) => value.startsWith('{"argv"'))!;
            const output = JSON.parse(line);
            expect(output.argv).toEqual(argv);
            expect(output.cwd).toBe(launch.cwd);
            expect(output.home.startsWith(input.root)).toBe(true);
            expect(output.home).not.toBe(input.homeDir);
            expect(output.ambient).toBe("");
            expect(output.authority).toBe("");
            expect(output.nativeFlag).toBe("");
            expect(output.user).toBe("fixture-user");
            expect(output.logname).toBe("fixture-user");
            const exited = new Promise<void>((resolve) =>
              manager.on("event", (event) => {
                if (event.type === "exited") resolve();
              }),
            );
            yield* Effect.promise(() => manager.write({ ...open, data: "complete\r" }));
            yield* Effect.promise(() => exited);
            expect(readFileSync(path.join(output.home, "fixture-auth.json"), "utf8")).toBe(
              "fixture-only",
            );
            const reattached = yield* Effect.promise(() => manager.open(open));
            expect(reattached.status).toBe("exited");
            expect(reattached.exitCode).toBe(0);
            expect(
              readdirSync(path.join(input.root, "logs")).filter((name) => name.endsWith(".log")),
            ).toEqual([]);
            yield* Effect.promise(() => manager.close({ ...open, deleteHistory: true }));
          } finally {
            yield* Effect.sync(() => manager.dispose());
          }
        }),
      ).pipe(Effect.provide(Layer.provide(NodePtyLive, NodeServices.layer))),
    );
  },
);

it("preserves selected native credentials and imported directories while preparing account isolation", async () => {
  const input = fixture("devin");
  const imported = path.join(input.root, "imported");
  input.settings = {
    ...input.settings,
    providerInstances: {
      [input.instanceId]: {
        driver: "devin",
        config: { profileDir: imported, binaryPath: path.join(input.root, "provider ' fixture") },
        environment: [{ name: "WINDSURF_API_KEY", value: "selected-fixture", sensitive: true }],
      },
    },
  };
  const patch = prepareProviderAuthenticationSettings(input)!;
  const settings = applyServerSettingsPatch(input.settings, patch);
  const instance = deriveProviderInstances(settings).find(
    (entry) => entry.instanceId === input.instanceId,
  )!;
  expect(instance.environment.HOME).toBe(imported);
  expect(instance.environment.WINDSURF_API_KEY).toBe("selected-fixture");
  const launch = await resolveProviderAuthenticationLaunch({ ...input, settings });
  expect(launch.env.WINDSURF_API_KEY).toBe("selected-fixture");
  expect(prepareProviderAuthenticationSettings({ ...input, settings })).toBeNull();
});

it("refuses disabled accounts and external OpenCode servers before preparing a login", () => {
  const input = fixture("opencode");
  input.settings = {
    ...input.settings,
    providerInstances: { [input.instanceId]: { driver: "opencode", enabled: false } },
  };
  expect(() => prepareProviderAuthenticationSettings(input)).toThrow(/missing or disabled/);
  input.settings = {
    ...input.settings,
    providerInstances: {
      [input.instanceId]: {
        driver: "opencode",
        config: { serverUrl: "https://example.invalid" },
      },
    },
  };
  expect(() => prepareProviderAuthenticationSettings(input)).toThrow(/Authenticate on that server/);
});

it("prepares account roots against current settings without dropping an account added by another client", async () => {
  const input = fixture("devin");
  const stalePatch = prepareProviderAuthenticationSettings(input)!;
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* ServerSettingsService;
      yield* service.updateSettings({
        providerInstances: {
          ...input.settings.providerInstances,
          devin_other: { driver: "devin", displayName: "Other" },
        },
      });
      const updated = yield* service.updateSettings(
        stalePatch,
        (current) => prepareProviderAuthenticationSettings({ ...input, settings: current }) ?? {},
      );
      expect(updated.providerInstances.devin_other?.displayName).toBe("Other");
      expect(
        deriveProviderInstances(updated).find((entry) => entry.instanceId === input.instanceId)
          ?.environment.HOME,
      ).toContain(input.stateDir);
    }).pipe(Effect.provide(ServerSettingsService.layerTest(input.settings))),
  );
});
