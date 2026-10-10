import {
  KeybindingCommand,
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  MAX_RESOLVED_KEYBINDINGS_COUNT,
  ResolvedKeybindingsConfig,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";
import {
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import { ServerConfig } from "./config";

import {
  applyKeybindingEdits,
  DEFAULT_KEYBINDINGS,
  KEYBINDING_EDIT_STALE_DETAIL,
  KEYBINDING_LIMIT_DETAIL,
  Keybindings,
  KeybindingsEditRejectedError,
  KeybindingsLive,
  type KeybindingsWriteError,
  ResolvedKeybindingFromConfig,
  compileResolvedKeybindingRule,
  compileResolvedKeybindingsConfig,
  parseKeybindingShortcut,
} from "./keybindings";

const KeybindingsConfigJson = Schema.fromJsonString(KeybindingsConfig);
const makeKeybindingsLayer = () => {
  return KeybindingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "synara-keybindings-test-",
        }),
      ),
    ),
  );
};

const toDetailResult = <A, R>(effect: Effect.Effect<A, KeybindingsWriteError, R>) =>
  effect.pipe(
    Effect.mapError((error) => error.detail),
    Effect.result,
  );

const writeKeybindingsConfig = (configPath: string, rules: readonly KeybindingRule[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeEffect(KeybindingsConfigJson)(rules);
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, encoded);
  });

const writeRawKeybindingsConfig = (configPath: string, entries: readonly unknown[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
    yield* fileSystem.writeFileString(configPath, JSON.stringify(entries));
  });

const readRawKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fileSystem.readFileString(configPath)) as unknown[];
  });

// Project script rules, which no shipped default or reset touches.
const scriptRules = (count: number): KeybindingRule[] =>
  Array.from({ length: count }, (_, index) => ({
    key: "mod+shift+r",
    command: `script.s${index}.run`,
  }));

const readKeybindingsConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const rawConfig = yield* fileSystem.readFileString(configPath);
    return yield* Schema.decodeUnknownEffect(KeybindingsConfigJson)(rawConfig);
  });

it.layer(NodeServices.layer)("keybindings", (it) => {
  it.effect("parses shortcuts including plus key", () =>
    Effect.sync(() => {
      assert.deepEqual(parseKeybindingShortcut("mod+j"), {
        key: "j",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
      assert.deepEqual(parseKeybindingShortcut("mod++"), {
        key: "+",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      });
    }),
  );

  it.effect("compiles valid rule with parsed when AST", () =>
    Effect.sync(() => {
      const compiled = compileResolvedKeybindingRule({
        key: "mod+d",
        command: "terminal.split",
        when: "terminalOpen && !terminalFocus",
      });

      assert.deepEqual(compiled, {
        command: "terminal.split",
        shortcut: {
          key: "d",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
        whenAst: {
          type: "and",
          left: { type: "identifier", name: "terminalOpen" },
          right: {
            type: "not",
            node: { type: "identifier", name: "terminalFocus" },
          },
        },
      });
    }),
  );

  it.effect("defaults workspace search outside terminal focus", () =>
    Effect.sync(() => {
      assert.deepEqual(
        DEFAULT_KEYBINDINGS.find((rule) => rule.command === "search.files"),
        { key: "mod+p", command: "search.files", when: "!terminalFocus" },
      );
      assert.deepEqual(
        DEFAULT_KEYBINDINGS.find((rule) => rule.command === "search.content"),
        { key: "mod+shift+f", command: "search.content", when: "!terminalFocus" },
      );
    }),
  );

  it.effect("encodes resolved plus-key shortcuts", () =>
    Effect.gen(function* () {
      const encoded = yield* Schema.encodeEffect(ResolvedKeybindingFromConfig)({
        command: "terminal.toggle",
        shortcut: {
          key: "+",
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      });

      assert.equal(encoded.key, "mod++");
      assert.equal(encoded.command, "terminal.toggle");
    }),
  );

  it.effect("rejects invalid rules", () =>
    Effect.sync(() => {
      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+shift+d+o",
          command: "terminal.new",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: "terminalFocus && (",
        }),
      );

      assert.isNull(
        compileResolvedKeybindingRule({
          key: "mod+d",
          command: "terminal.split",
          when: `${"!".repeat(300)}terminalFocus`,
        }),
      );
    }),
  );

  it.effect("keeps the shipped thread tab chords distinct from space navigation", () =>
    Effect.gen(function* () {
      const keybindings = yield* Keybindings;
      const snapshot = yield* keybindings.loadConfigState;
      for (const direction of ["previous", "next"] as const) {
        const tabRules = snapshot.keybindings.filter(
          (rule) => rule.command === `threadTab.${direction}`,
        );
        const spaceRules = snapshot.keybindings.filter(
          (rule) => rule.command === `space.${direction}`,
        );
        assert.lengthOf(tabRules, 2);
        assert.lengthOf(spaceRules, 1);
        for (const tabRule of tabRules) {
          for (const spaceRule of spaceRules) {
            assert.notDeepEqual(tabRule.shortcut, spaceRule.shortcut);
          }
        }
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("bootstraps default keybindings when config file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      assert.isFalse(yield* fs.exists(keybindingsConfigPath));

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("allows startup to retry and owns one watcher until the service closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const attached = yield* Deferred.make<void>();
      let activeWatchers = 0;
      const watchedFs = {
        ...fs,
        watch: (...args: Parameters<typeof fs.watch>) =>
          Stream.unwrap(
            Effect.acquireRelease(
              Effect.gen(function* () {
                activeWatchers += 1;
                yield* Deferred.succeed(attached, undefined);
                return fs.watch(...args);
              }),
              () =>
                Effect.sync(() => {
                  activeWatchers -= 1;
                }),
            ),
          ),
      };
      yield* Effect.gen(function* () {
        const path = yield* Path.Path;
        const { keybindingsConfigPath } = yield* ServerConfig;
        const keybindings = yield* Keybindings;
        const configDirectory = path.dirname(keybindingsConfigPath);

        yield* fs.remove(configDirectory, { recursive: true });
        yield* fs.writeFileString(configDirectory, "temporarily blocked");
        const firstStart = yield* keybindings.start.pipe(Effect.exit);
        assert.equal(firstStart._tag, "Failure");
        assert.equal(activeWatchers, 0);

        yield* fs.remove(configDirectory);
        yield* keybindings.start;
        yield* keybindings.ready;
        yield* Deferred.await(attached);
        yield* keybindings.start;
        assert.isTrue(yield* fs.exists(keybindingsConfigPath));
        assert.equal(activeWatchers, 1);
      }).pipe(
        Effect.provide(makeKeybindingsLayer()),
        Effect.provideService(FileSystem.FileSystem, watchedFs),
      );
      assert.equal(activeWatchers, 0);
    }),
  );

  it.effect("shares a failed startup attempt with concurrent callers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reads = 0;
      const blockedFs = {
        ...fs,
        exists: (target: string) =>
          Effect.gen(function* () {
            if (!target.endsWith("/keybindings.json")) return yield* fs.exists(target);
            reads += 1;
            if (reads === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
            return yield* fs.exists(target);
          }),
      };
      yield* Effect.gen(function* () {
        const path = yield* Path.Path;
        const { keybindingsConfigPath } = yield* ServerConfig;
        const keybindings = yield* Keybindings;
        const directory = path.dirname(keybindingsConfigPath);
        yield* fs.remove(directory, { recursive: true });
        yield* fs.writeFileString(directory, "blocked");
        const first = yield* keybindings.start.pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(entered);
        const second = yield* keybindings.start.pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        assert.equal((yield* Fiber.join(first))._tag, "Failure");
        assert.equal((yield* Fiber.join(second))._tag, "Failure");
        assert.equal(reads, 1);
      }).pipe(
        Effect.provide(makeKeybindingsLayer()),
        Effect.provideService(FileSystem.FileSystem, blockedFs),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("publishes interrupted startup and allows the next attempt to recover", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const entered = yield* Deferred.make<void>();
      let reads = 0;
      const blockedFs = {
        ...fs,
        exists: (target: string) =>
          Effect.gen(function* () {
            if (!target.endsWith("/keybindings.json")) return yield* fs.exists(target);
            reads += 1;
            if (reads === 1) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return yield* fs.exists(target);
          }),
      };
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const first = yield* keybindings.start.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const readiness = yield* keybindings.ready.pipe(Effect.exit, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        yield* Effect.yieldNow;
        assert.isDefined(readiness.pollUnsafe(), "readiness must receive the interrupted attempt");
        assert.equal((yield* Fiber.join(readiness))._tag, "Failure");
        yield* keybindings.start;
        yield* keybindings.ready;
      }).pipe(
        Effect.provide(makeKeybindingsLayer()),
        Effect.provideService(FileSystem.FileSystem, blockedFs),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("uses defaults in runtime when config is malformed without overriding file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.malformed-config",
          message: configState.issues[0]?.message ?? "",
        },
      ]);
      assert.equal(yield* fs.readFileString(keybindingsConfigPath), "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats empty object config as empty and heals file on startup sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{}\n");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(persisted, DEFAULT_KEYBINDINGS);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats a whitespace-only config file as empty config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "  \n");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("treats a null config file as empty config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "null");

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings,
        compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("unwraps object config with a keybindings array and heals file on startup sync", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify({ keybindings: [{ key: "mod+9", command: "terminal.toggle" }] }),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "9",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some((entry) => entry.key === "mod+9" && entry.command === "terminal.toggle"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("wraps a single keybinding rule object into a one-entry config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        '{"key":"mod+9","command":"terminal.toggle"}',
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "9",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("upserts keybindings on top of an empty object config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{}");

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("ignores invalid entries in runtime and reports them as issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+j", command: "terminal.toggle" },
          { key: "mod+shift+d+o", command: "terminal.new" },
          { key: "mod+x", command: "invalid.command" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.isTrue(configState.keybindings.some((entry) => entry.command === "terminal.toggle"));
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "invalid.command"),
      );
      assert.deepEqual(configState.issues, [
        {
          kind: "keybindings.invalid-entry",
          index: 1,
          message: configState.issues[0]?.message ?? "",
        },
        {
          kind: "keybindings.invalid-entry",
          index: 2,
          message: configState.issues[1]?.message ?? "",
        },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates legacy command palette keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([{ key: "mod+shift+p", command: "commandPalette.toggle" }]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "sidebar.search" && entry.shortcut.key === "p",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+p" && entry.command === "sidebar.search",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates colliding Mac tab defaults while preserving custom tab and space rules", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const rules: KeybindingRule[] = [
        { key: "mod+alt+arrowleft", command: "threadTab.previous", when: "isMac" },
        { key: "mod+alt+arrowright", command: "threadTab.next", when: "isMac" },
        { key: "mod+alt+arrowleft", command: "space.previous", when: "!terminalFocus" },
        { key: "mod+alt+arrowright", command: "space.next", when: "!terminalFocus" },
        { key: "mod+shift+g", command: "threadTab.next", when: "!terminalFocus" },
        { key: "mod+alt+arrowleft", command: "threadTab.previous", when: "!terminalFocus" },
      ];
      yield* writeKeybindingsConfig(keybindingsConfigPath, rules);
      const keybindings = yield* Keybindings;
      const snapshot = yield* keybindings.loadConfigState;
      const expected: KeybindingRule[] = rules.map((rule, index) =>
        index < 2
          ? { ...rule, key: index === 0 ? "mod+ctrl+arrowleft" : "mod+ctrl+arrowright" }
          : rule,
      );
      assert.deepEqual(
        snapshot.keybindings.filter((rule) => rule.command.startsWith("threadTab.")),
        compileResolvedKeybindingsConfig(
          expected.filter((rule) => rule.command.startsWith("threadTab.")),
        ),
      );
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      for (const rule of expected) assert.deepInclude(persisted, rule);
      assert.isFalse(
        persisted.some((rule) =>
          rules
            .slice(0, 2)
            .some(
              (old) =>
                old.command === rule.command && old.key === rule.key && old.when === rule.when,
            ),
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates old recent-view defaults to work with terminal focus", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "ctrl+tab", command: "view.recent.next", when: "!terminalFocus" },
        { key: "ctrl+shift+tab", command: "view.recent.previous", when: "!terminalFocus" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      const next = configState.keybindings.find((entry) => entry.command === "view.recent.next");
      const previous = configState.keybindings.find(
        (entry) => entry.command === "view.recent.previous",
      );
      assert.isUndefined(next?.whenAst);
      assert.isUndefined(previous?.whenAst);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+tab" &&
            entry.command === "view.recent.next" &&
            entry.when === undefined,
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+shift+tab" &&
            entry.command === "view.recent.previous" &&
            entry.when === undefined,
        ),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.command === "view.recent.next" && entry.when === "!terminalFocus",
        ),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.command === "view.recent.previous" && entry.when === "!terminalFocus",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates the old sidebar search default without preserving macOS Ctrl+K", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+k", command: "sidebar.search" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });
      const searchBindings = configState.keybindings.filter(
        (entry) => entry.command === "sidebar.search",
      );
      assert.deepEqual(
        searchBindings.map((entry) => ({
          shortcut: entry.shortcut,
          whenAst: entry.whenAst,
        })),
        [
          {
            shortcut: {
              key: "k",
              metaKey: true,
              ctrlKey: false,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
            whenAst: undefined,
          },
          {
            shortcut: {
              key: "k",
              metaKey: false,
              ctrlKey: true,
              shiftKey: false,
              altKey: false,
              modKey: false,
            },
            whenAst: { type: "not", node: { type: "identifier", name: "isMac" } },
          },
        ],
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "sidebar.search"),
        [
          { key: "cmd+k", command: "sidebar.search" },
          { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
        ],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("preserves new-chat Cmd/Option/N while relaxing its terminal guard", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      // existing configs persisted the old shipped keys — startup only relaxes the creation guard; it must not move new-chat off Cmd/Option/N
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+shift+o", command: "sidebar.addProject", when: "!terminalFocus" },
        { key: "mod+alt+n", command: "chat.newChat", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+shift+o" &&
            entry.command === "sidebar.addProject" &&
            entry.when === "!terminalFocus",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+alt+n" &&
            entry.command === "chat.newChat" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      assert.isFalse(
        persisted.some((entry) => entry.key === "mod+shift+o" && entry.command === "chat.newChat"),
      );
      assert.isFalse(
        persisted.some(
          (entry) => entry.key === "mod+shift+p" && entry.command === "sidebar.addProject",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("relaxes creation-command terminal guards so macOS can create from the terminal", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      // a config still carrying the old bare `!terminalFocus` on creation commands, incl. one the user rebound
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+n", command: "chat.new", when: "!terminalFocus" },
        { key: "mod+shift+k", command: "chat.newTerminal", when: "!terminalFocus" },
        { key: "mod+shift+u", command: "settings.usage", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      // creation commands gain the `|| isMac` escape hatch even on a rebound key
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+n" &&
            entry.command === "chat.new" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+shift+k" &&
            entry.command === "chat.newTerminal" &&
            entry.when === "!terminalFocus || isMac",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.command === "settings.usage" && entry.when === "!terminalFocus",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("migrates numbered terminal workspace defaults without changing custom rules", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        {
          key: "mod+1",
          command: "terminal.workspace.terminal",
          when: "terminalWorkspaceOpen",
        },
        { key: "mod+2", command: "terminal.workspace.chat", when: "terminalWorkspaceOpen" },
        {
          key: "mod+1",
          command: "thread.jump.1",
          when: "!terminalFocus && !terminalWorkspaceOpen",
        },
        {
          key: "mod+shift+3",
          command: "thread.jump.3",
          when: "!terminalFocus && !terminalWorkspaceOpen",
        },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+1" &&
            entry.command === "terminal.workspace.terminal" &&
            entry.when === "terminalWorkspaceOpen",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "ctrl+2" &&
            entry.command === "terminal.workspace.chat" &&
            entry.when === "terminalWorkspaceOpen",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+1" &&
            entry.command === "thread.jump.1" &&
            entry.when === "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) =>
            entry.key === "mod+shift+3" &&
            entry.command === "thread.jump.3" &&
            entry.when === "!terminalFocus && !terminalWorkspaceOpen",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("accepts synced composer picker keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+shift+m", command: "modelPicker.toggle" },
          { key: "mod+shift+e", command: "effortPicker.toggle" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "modelPicker.toggle" && entry.shortcut.key === "m",
        ),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "traitsPicker.toggle" && entry.shortcut.key === "e",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+m" && entry.command === "modelPicker.toggle",
        ),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+e" && entry.command === "traitsPicker.toggle",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("syncs the composer effort shortcut into existing user keybindings", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+g", command: "terminal.toggle" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.deepEqual(
        configState.keybindings.find((entry) => entry.command === "model.effort.next"),
        {
          command: "model.effort.next",
          shortcut: {
            key: "tab",
            metaKey: false,
            ctrlKey: false,
            shiftKey: true,
            altKey: false,
            modKey: false,
          },
          whenAst: { type: "identifier", name: "composerFocus" },
        },
      );
      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.includeDeepMembers(
        [...persisted],
        [
          { key: "shift+tab", command: "model.effort.next", when: "composerFocus" },
          { key: "mod+g", command: "terminal.toggle" },
        ],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("drops retired legacy keybindings without startup issues", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(
        keybindingsConfigPath,
        JSON.stringify([
          { key: "mod+1", command: "modelPicker.jump.1" },
          { key: "mod+2", command: "composer.modelPicker.jump.2" },
          { key: "mod+alt+g", command: "chat.newGemini" },
          { key: "mod+k", command: "sidebar.search" },
        ]),
      );

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(configState.issues, []);
      assert.isFalse(
        configState.keybindings.some((entry) =>
          String(entry.command).includes("modelPicker.jump."),
        ),
      );
      assert.isFalse(
        configState.keybindings.some((entry) => String(entry.command) === "chat.newGemini"),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "modelPicker.toggle" && entry.shortcut.key === "m",
        ),
      );
      assert.isTrue(
        configState.keybindings.some(
          (entry) => entry.command === "thread.jump.1" && entry.shortcut.key === "1",
        ),
      );

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(
        persisted.some((entry) => String(entry.command).includes("modelPicker.jump.")),
      );
      assert.isFalse(persisted.some((entry) => String(entry.command) === "chat.newGemini"));
      assert.isFalse(
        persisted.some((entry) => entry.command === "modelPicker.toggle" && entry.key === "mod+1"),
      );
      assert.isTrue(
        persisted.some(
          (entry) => entry.key === "mod+shift+m" && entry.command === "modelPicker.toggle",
        ),
      );
      assert.isTrue(
        persisted.some((entry) => entry.key === "mod+1" && entry.command === "thread.jump.1"),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect(
    "upserts missing default keybindings on startup without overriding existing command rules",
    () =>
      Effect.gen(function* () {
        const { keybindingsConfigPath } = yield* ServerConfig;
        yield* writeKeybindingsConfig(keybindingsConfigPath, [
          { key: "mod+shift+t", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ]);

        yield* Effect.gen(function* () {
          const keybindings = yield* Keybindings;
          yield* keybindings.syncDefaultKeybindingsOnStartup;
        });

        const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
        const byCommand = new Map(persisted.map((entry) => [entry.command, entry]));

        const persistedToggle = byCommand.get("terminal.toggle");
        assert.isNotNull(persistedToggle);
        assert.equal(persistedToggle?.key, "mod+shift+t");
        assert.isFalse(
          persisted.some((entry) => entry.command === "terminal.toggle" && entry.key === "mod+j"),
        );

        const persistedNewTerminalThread = byCommand.get("chat.newTerminal");
        assert.isNotNull(persistedNewTerminalThread);
        assert.equal(persistedNewTerminalThread?.key, "mod+shift+t");

        for (const defaultRule of DEFAULT_KEYBINDINGS) {
          assert.isTrue(byCommand.has(defaultRule.command), `expected ${defaultRule.command}`);
        }
        assert.isTrue(byCommand.has("script.run-tests.run"));
      }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips conflicting default keybindings on startup and logs a detailed warning", () => {
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });

    return Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "script.custom-action.run" },
        { key: "mod+ctrl+arrowright", command: "script.custom-tabs.run", when: "isMac" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.isFalse(persisted.some((entry) => entry.command === "terminal.toggle"));
      assert.isTrue(persisted.some((entry) => entry.command === "script.custom-action.run"));
      assert.isFalse(
        persisted.some((entry) => entry.command === "threadTab.next" && entry.when === "isMac"),
      );
      assert.deepInclude(persisted, {
        key: "mod+ctrl+arrowright",
        command: "script.custom-tabs.run",
        when: "isMac",
      });

      assert.isTrue(
        messages.some((message) =>
          message.includes("skipping default keybinding due to shortcut conflict"),
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          makeKeybindingsLayer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("upserts custom keybindings to configured path", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));

      assert.deepEqual(persistedView, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+r", command: "script.run-tests.run" },
      ]);
      assert.isTrue(resolved.some((entry) => entry.command === "script.run-tests.run"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("replaces existing custom keybinding for the same command", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+r", command: "script.run-tests.run" },
      ]);
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+shift+r", command: "script.run-tests.run" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("preserves sibling conditions when replacing one keybinding rule", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "cmd+k", command: "sidebar.search" },
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule(
          { key: "meta+shift+k", command: "sidebar.search" },
          { key: "meta+k", command: "sidebar.search" },
        );
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
        { key: "meta+shift+k", command: "sidebar.search" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("rejects invalid conditions without overwriting the existing binding", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const existingRule = {
        key: "mod+r",
        command: "script.run-tests.run",
        when: "!terminalFocus",
      } as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [existingRule]);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
          when: "!terminalFocus &&",
        });
      }).pipe(toDetailResult);

      assertFailure(result, "invalid shortcut or condition expression");
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [existingRule]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses to overwrite malformed keybindings config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, "{ not-json");

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assert.isTrue(Result.isFailure(result));
      assert.match(Result.isFailure(result) ? result.failure : "", /^expected JSON array/);

      const persistedRaw = yield* fs.readFileString(keybindingsConfigPath);
      assert.equal(persistedRaw, "{ not-json");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reports non-array config parse errors without duplicate prefix", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* fs.writeFileString(keybindingsConfigPath, '{"keybindings":{"key":"mod+j"}}');

      const firstResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(firstResult, "expected JSON array, got object");

      const secondResult = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(secondResult, "expected JSON array, got object");
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("fails when config directory is not writable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { keybindingsConfigPath } = yield* ServerConfig;
      const { dirname } = yield* Path.Path;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);
      yield* fs.chmod(dirname(keybindingsConfigPath), 0o500);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
      }).pipe(toDetailResult);
      assertFailure(result, "failed to write keybindings config");

      yield* fs.chmod(dirname(keybindingsConfigPath), 0o700);

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedView = persisted.map(({ key, command }) => ({ key, command }));
      assert.deepEqual(persistedView, [{ key: "mod+j", command: "terminal.toggle" }]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("caches loaded resolved config across repeated reads", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const firstLoad = (yield* keybindings.loadConfigState).keybindings;
        const secondLoad = (yield* keybindings.loadConfigState).keybindings;
        return [firstLoad, secondLoad] as const;
      });

      assert.deepEqual(first, second);
      assert.isTrue(second.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("updates cached resolved config after upsert", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const loadedAfterUpsert = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.loadConfigState;
        yield* keybindings.upsertKeybindingRule({
          key: "mod+shift+r",
          command: "script.run-tests.run",
        });
        return (yield* keybindings.loadConfigState).keybindings;
      });

      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "script.run-tests.run"));
      assert.isTrue(loadedAfterUpsert.some((entry) => entry.command === "terminal.toggle"));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("serializes concurrent upserts to avoid lost updates", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, []);

      const commands = Array.from(
        { length: 20 },
        (_, index): KeybindingCommand => `script.concurrent-${index}.run`,
      );
      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* Effect.all(
          commands.map((command, index) =>
            keybindings.upsertKeybindingRule({
              key: `mod+${String.fromCharCode(97 + index)}`,
              command,
            }),
          ),
          { concurrency: "unbounded", discard: true },
        );
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      const persistedCommands = new Set(persisted.map((entry) => entry.command));
      for (const command of commands) {
        assert.isTrue(persistedCommands.has(command), `expected persisted command ${command}`);
      }
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("leaves a command unassigned when its last binding is removed", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
      ]);

      const resolved = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.editKeybindings([
          { type: "remove", rule: { key: "mod+j", command: "terminal.toggle" } },
        ]);
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "unassigned", command: "terminal.toggle" },
      ]);
      // The marker is the command's only resolved rule: the shipped Mod+J is not merged
      // back in, and the web fallback table sees the command as configured.
      assert.deepEqual(
        resolved
          .filter((entry) => entry.command === "terminal.toggle")
          .map((entry) => entry.shortcut.key),
        ["unassigned"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps an unassigned command unassigned across startup", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "unassigned", command: "terminal.toggle" },
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        return yield* keybindings.loadConfigState;
      });

      const persisted = yield* readKeybindingsConfig(keybindingsConfigPath);
      assert.deepEqual(
        persisted.filter((entry) => entry.command === "terminal.toggle"),
        [{ key: "unassigned", command: "terminal.toggle" }],
      );
      assert.isFalse(
        configState.keybindings.some(
          (entry) => entry.command === "terminal.toggle" && entry.shortcut.key === "j",
        ),
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("moves a shortcut between commands in one write", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+j", command: "terminal.toggle" },
        { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.editKeybindings([
          { type: "remove", rule: { key: "mod+j", command: "terminal.toggle" } },
          {
            type: "set",
            rule: { key: "mod+j", command: "browser.toggle", when: "!terminalFocus" },
            replacing: { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
          },
        ]);
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "unassigned", command: "terminal.toggle" },
        { key: "mod+j", command: "browser.toggle", when: "!terminalFocus" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("rejects an edit batch without writing any of it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const existing = [{ key: "mod+j", command: "terminal.toggle" }] as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, existing);

      const result = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.editKeybindings([
          { type: "remove", rule: { key: "mod+j", command: "terminal.toggle" } },
          { type: "set", rule: { key: "mod+shift+d+o", command: "browser.toggle" } },
        ]);
      }).pipe(toDetailResult);

      assertFailure(result, "invalid shortcut or condition expression");
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), existing);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("clears the unassigned marker when a command gets a binding again", () =>
    Effect.sync(() => {
      const unassigned = [{ key: "unassigned", command: "terminal.toggle" }] as const;

      assert.deepEqual(
        applyKeybindingEdits(unassigned, [
          { type: "set", rule: { key: "mod+g", command: "terminal.toggle" } },
        ]),
        { _tag: "success", rules: [{ key: "mod+g", command: "terminal.toggle" }] },
      );
      // The marker itself is not a shortcut a command can be given.
      assert.deepEqual(
        applyKeybindingEdits(
          [],
          [{ type: "set", rule: { key: "unassigned", command: "terminal.toggle" } }],
        ),
        { _tag: "failure", reason: "invalid", detail: "invalid shortcut or condition expression" },
      );
    }),
  );

  it.effect("adds a second binding without touching the first", () =>
    Effect.sync(() => {
      assert.deepEqual(
        applyKeybindingEdits(
          [{ key: "mod+j", command: "terminal.toggle" }],
          [{ type: "set", rule: { key: "ctrl+`", command: "terminal.toggle" } }],
        ),
        {
          _tag: "success",
          rules: [
            { key: "mod+j", command: "terminal.toggle" },
            { key: "ctrl+`", command: "terminal.toggle" },
          ],
        },
      );
    }),
  );

  it.effect("writes out a command's shipped bindings before editing one of them", () =>
    Effect.sync(() => {
      // Startup can leave a shipped command off disk; it is still live through the merge
      // with the defaults, so removing one binding must not take its sibling along.
      const result = applyKeybindingEdits(
        [],
        [{ type: "remove", rule: { key: "meta+k", command: "sidebar.search" } }],
      );

      assert.deepEqual(result, {
        _tag: "success",
        rules: [{ key: "ctrl+k", command: "sidebar.search", when: "!isMac" }],
      });
    }),
  );

  it.effect("does not mark a command without shipped bindings as unassigned", () =>
    Effect.sync(() => {
      assert.deepEqual(
        applyKeybindingEdits(
          [{ key: "mod+shift+r", command: "script.run-tests.run" }],
          [{ type: "remove", rule: { key: "mod+shift+r", command: "script.run-tests.run" } }],
        ),
        { _tag: "success", rules: [] },
      );
    }),
  );

  it.effect("resets one command to its shipped position", () =>
    Effect.sync(() => {
      // Mod+W closes a terminal tab or the workspace panel depending on which rule is
      // last; restoring the first must not move it after the second.
      const result = applyKeybindingEdits(
        [
          {
            key: "mod+w",
            command: "terminal.workspace.closeActive",
            when: "terminalWorkspaceOpen",
          },
          { key: "mod+shift+r", command: "script.run-tests.run" },
          { key: "mod+alt+w", command: "terminal.close", when: "terminalFocus" },
        ],
        [{ type: "reset", command: "terminal.close" }],
      );

      assert.deepEqual(result, {
        _tag: "success",
        rules: [
          { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
          {
            key: "mod+w",
            command: "terminal.workspace.closeActive",
            when: "terminalWorkspaceOpen",
          },
          { key: "mod+shift+r", command: "script.run-tests.run" },
        ],
      });
    }),
  );

  it.effect("resets every built-in command and keeps project script shortcuts", () =>
    Effect.sync(() => {
      const result = applyKeybindingEdits(
        [
          { key: "unassigned", command: "terminal.toggle" },
          { key: "mod+shift+r", command: "script.run-tests.run" },
          { key: "mod+alt+w", command: "terminal.close", when: "terminalFocus" },
        ],
        [{ type: "reset" }],
      );

      assert.deepEqual(result, {
        _tag: "success",
        rules: [...DEFAULT_KEYBINDINGS, { key: "mod+shift+r", command: "script.run-tests.run" }],
      });
    }),
  );

  it.effect("refuses edits made against rules that are no longer there", () =>
    Effect.sync(() => {
      const rules = [{ key: "mod+g", command: "terminal.toggle" }] as const;
      const stale = {
        _tag: "failure",
        reason: "stale",
        detail: KEYBINDING_EDIT_STALE_DETAIL,
      } as const;

      assert.deepEqual(
        applyKeybindingEdits(rules, [
          {
            type: "set",
            rule: { key: "mod+h", command: "terminal.toggle" },
            replacing: { key: "mod+j", command: "terminal.toggle" },
          },
        ]),
        stale,
      );
      assert.deepEqual(
        applyKeybindingEdits(rules, [
          { type: "remove", rule: { key: "mod+j", command: "terminal.toggle" } },
        ]),
        stale,
      );
      // One stale edit refuses the whole batch, including the valid edits before it.
      assert.deepEqual(
        applyKeybindingEdits(rules, [
          { type: "remove", rule: { key: "mod+g", command: "terminal.toggle" } },
          { type: "remove", rule: { key: "mod+g", command: "terminal.toggle" } },
        ]),
        stale,
      );
      // Identity is resolved, so another spelling of a live rule is not stale.
      assert.deepEqual(
        applyKeybindingEdits(
          [{ key: "cmd+k", command: "sidebar.search" }],
          [{ type: "remove", rule: { key: "meta+k", command: "sidebar.search" } }],
        ),
        { _tag: "success", rules: [{ key: "unassigned", command: "sidebar.search" }] },
      );
      // A reset names no rule, so it is never stale.
      assert.equal(
        applyKeybindingEdits([], [{ type: "reset", command: "terminal.toggle" }])._tag,
        "success",
      );
    }),
  );

  it.effect("rejects a stale edit with a plain message and writes nothing", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const existing = [{ key: "mod+g", command: "terminal.toggle" }] as const;
      yield* writeKeybindingsConfig(keybindingsConfigPath, existing);

      const error = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.editKeybindings([
          {
            type: "set",
            rule: { key: "mod+h", command: "terminal.toggle" },
            replacing: { key: "mod+j", command: "terminal.toggle" },
          },
        ]);
      }).pipe(Effect.flip);

      // The web toasts `error.message` as is.
      assert.instanceOf(error, KeybindingsEditRejectedError);
      assert.instanceOf(error, Error);
      assert.equal(error.message, KEYBINDING_EDIT_STALE_DETAIL);
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), existing);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("reloads the config it serves when an edit turns out stale", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+g", command: "terminal.toggle" },
      ]);
      const keybindings = yield* Keybindings;
      yield* keybindings.loadConfigState;

      // Changed on disk without the cache hearing about it.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+l", command: "terminal.toggle" },
      ]);
      yield* keybindings
        .editKeybindings([{ type: "remove", rule: { key: "mod+g", command: "terminal.toggle" } }])
        .pipe(Effect.flip);

      const served = (yield* keybindings.getSnapshot).keybindings.filter(
        (rule) => rule.command === "terminal.toggle",
      );
      assert.deepEqual(
        served.map((rule) => rule.shortcut.key),
        ["l"],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("saves a recorded rule in the shape the next load gives it", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "cmd+k", command: "sidebar.search" },
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);
      const keybindings = yield* Keybindings;

      // Cmd+K recorded on macOS arrives as the old portable default, `mod+k`.
      yield* keybindings.editKeybindings([
        {
          type: "set",
          rule: { key: "mod+k", command: "sidebar.search" },
          replacing: { key: "cmd+k", command: "sidebar.search" },
        },
      ]);
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "cmd+k", command: "sidebar.search" },
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);

      // What was cached matches the file, so the next edit is not refused as stale.
      yield* keybindings.editKeybindings([
        { type: "remove", rule: { key: "cmd+k", command: "sidebar.search" } },
      ]);
      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it("refuses an edit naming a rule that does not compile as invalid, not stale", () => {
    const rules = [{ key: "mod+j", command: "terminal.toggle" }] as const;
    const result = applyKeybindingEdits(rules, [
      { type: "remove", rule: { key: "mod+j+k", command: "terminal.toggle" } },
    ]);

    assert.equal(result._tag, "failure");
    assert.equal(result._tag === "failure" ? result.reason : null, "invalid");
  });

  it.effect("edits the migrated rules the runtime shows", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      // The old sidebar search default, which the runtime shows as Cmd+K and Ctrl+K.
      yield* writeKeybindingsConfig(keybindingsConfigPath, [
        { key: "mod+k", command: "sidebar.search" },
      ]);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        return yield* keybindings.editKeybindings([
          { type: "remove", rule: { key: "cmd+k", command: "sidebar.search" } },
        ]);
      });

      assert.deepEqual(yield* readKeybindingsConfig(keybindingsConfigPath), [
        { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
      ]);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("keeps entries it cannot read when saving", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const unreadable = [
        { key: "mod+shift+d+o", command: "terminal.new" },
        { key: "mod+x", command: "invalid.command", note: "hand edited" },
      ];
      yield* writeRawKeybindingsConfig(keybindingsConfigPath, [
        unreadable[0],
        { key: "mod+g", command: "terminal.toggle" },
        unreadable[1],
      ]);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.editKeybindings([
          { type: "set", rule: { key: "mod+h", command: "script.build.run" } },
        ]);
        return yield* keybindings.loadConfigState;
      });

      assert.deepEqual(yield* readRawKeybindingsConfig(keybindingsConfigPath), [
        { key: "mod+g", command: "terminal.toggle" },
        { key: "mod+h", command: "script.build.run" },
        ...unreadable,
      ]);
      assert.deepEqual(
        configState.issues.map((issue) => [issue.kind, "index" in issue ? issue.index : null]),
        [
          ["keybindings.invalid-entry", 2],
          ["keybindings.invalid-entry", 3],
        ],
      );
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("refuses a write past the rule limit instead of dropping old rules", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const full = scriptRules(MAX_KEYBINDINGS_COUNT);
      yield* writeRawKeybindingsConfig(keybindingsConfigPath, full);

      const [upsertError, editError] = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const upsert = yield* keybindings
          .upsertKeybindingRule({ key: "mod+g", command: "script.extra.run" })
          .pipe(Effect.flip);
        const edit = yield* keybindings
          .editKeybindings([{ type: "set", rule: { key: "mod+g", command: "terminal.toggle" } }])
          .pipe(Effect.flip);
        return [upsert, edit] as const;
      });

      assert.equal(upsertError.message, KEYBINDING_LIMIT_DETAIL);
      assert.equal(editError.message, KEYBINDING_LIMIT_DETAIL);
      assert.deepEqual(yield* readRawKeybindingsConfig(keybindingsConfigPath), full);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("still loads and shrinks a config already over the rule limit", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const overLimit = scriptRules(MAX_KEYBINDINGS_COUNT + 4);
      yield* writeRawKeybindingsConfig(keybindingsConfigPath, overLimit);

      const configState = yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        const loaded = yield* keybindings.loadConfigState;
        yield* keybindings.editKeybindings([{ type: "remove", rule: overLimit[0]! }]);
        return loaded;
      });

      assert.deepEqual(configState.issues, []);
      assert.equal(configState.keybindings.at(-1)?.command, overLimit.at(-1)?.command);
      assert.deepEqual(
        configState.keybindings
          .filter((rule) => rule.command.startsWith("script."))
          .map((rule) => rule.command),
        overLimit.slice(-MAX_KEYBINDINGS_COUNT).map((rule) => rule.command),
      );
      yield* Schema.decodeUnknownEffect(ResolvedKeybindingsConfig)(configState.keybindings);
      assert.deepEqual(yield* readRawKeybindingsConfig(keybindingsConfigPath), overLimit.slice(1));
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );

  it.effect("skips the startup backfill rather than trimming a full config", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const full = scriptRules(MAX_KEYBINDINGS_COUNT);
      yield* writeRawKeybindingsConfig(keybindingsConfigPath, full);

      yield* Effect.gen(function* () {
        const keybindings = yield* Keybindings;
        yield* keybindings.syncDefaultKeybindingsOnStartup;
        const snapshot = yield* keybindings.loadConfigState;
        assert.isTrue(snapshot.keybindings.some((rule) => rule.command === "sidebar.toggle"));
        assert.isTrue(snapshot.keybindings.some((rule) => rule.command === "chat.new"));
        assert.deepEqual(
          snapshot.keybindings.filter((rule) => !rule.command.startsWith("script.")),
          compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS),
        );
        assert.isAtMost(snapshot.keybindings.length, MAX_RESOLVED_KEYBINDINGS_COUNT);
        yield* Schema.decodeUnknownEffect(ResolvedKeybindingsConfig)(snapshot.keybindings);
        assert.deepEqual(
          snapshot.keybindings
            .filter((rule) => rule.command.startsWith("script."))
            .map((rule) => rule.command),
          full.map((rule) => rule.command),
        );
        assert.equal(snapshot.keybindings.at(-1)?.command, full.at(-1)?.command);
      });

      assert.deepEqual(yield* readRawKeybindingsConfig(keybindingsConfigPath), full);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
  it.effect("keeps custom built-ins and unassigned markers at the user rule cap", () =>
    Effect.gen(function* () {
      const { keybindingsConfigPath } = yield* ServerConfig;
      const full: KeybindingRule[] = [
        { key: "unassigned", command: "sidebar.toggle" },
        { key: "mod+shift+l", command: "browser.toggle", when: "!terminalFocus" },
        ...scriptRules(MAX_KEYBINDINGS_COUNT - 2),
      ];
      yield* writeRawKeybindingsConfig(keybindingsConfigPath, full);
      const keybindings = yield* Keybindings;
      yield* keybindings.syncDefaultKeybindingsOnStartup;
      const snapshot = yield* keybindings.loadConfigState;
      assert.deepEqual(
        snapshot.keybindings.filter(
          (rule) => rule.command === "sidebar.toggle" || rule.command === "browser.toggle",
        ),
        compileResolvedKeybindingsConfig(full.slice(0, 2)),
      );
      yield* Schema.decodeUnknownEffect(ResolvedKeybindingsConfig)(snapshot.keybindings);
      assert.deepEqual(yield* readRawKeybindingsConfig(keybindingsConfigPath), full);
    }).pipe(Effect.provide(makeKeybindingsLayer())),
  );
});
