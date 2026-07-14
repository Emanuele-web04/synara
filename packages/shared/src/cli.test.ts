import { assert, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import * as ConfigProvider from "effect/ConfigProvider";
import { Command } from "effect/unstable/cli";

import {
  getBooleanFlagValue,
  optionalBooleanEnvironmentConfig,
  optionalBooleanFlag,
  resolveBooleanConfig,
} from "./cli";

const parseBooleanFlag = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const parsed = yield* Ref.make<boolean | undefined>(undefined);
    const command = Command.make("test", {
      feature: optionalBooleanFlag("feature"),
    }).pipe(Command.withHandler(({ feature }) => Ref.set(parsed, getBooleanFlagValue(feature))));

    yield* Command.runWith(command, { version: "test" })(args);
    return yield* Ref.get(parsed);
  });

it.effect("keeps absent, positive, negative, and explicit false boolean flags distinct", () =>
  Effect.gen(function* () {
    assert.equal(yield* parseBooleanFlag([]), undefined);
    assert.equal(yield* parseBooleanFlag(["--feature"]), true);
    assert.equal(yield* parseBooleanFlag(["--no-feature"]), false);
    assert.equal(yield* parseBooleanFlag(["--feature=false"]), false);
  }),
);

it("resolves boolean configuration as CLI then environment then fallback", () => {
  const absent = { positive: undefined, negative: undefined };
  assert.equal(resolveBooleanConfig(absent, undefined, true), true);
  assert.equal(resolveBooleanConfig(absent, false, true), false);
  assert.equal(resolveBooleanConfig({ positive: true, negative: undefined }, false, false), true);
  assert.equal(resolveBooleanConfig({ positive: false, negative: undefined }, true, true), false);
  assert.equal(resolveBooleanConfig({ positive: undefined, negative: true }, true, true), false);
});

it.effect("keeps missing boolean environment values optional but rejects malformed values", () =>
  Effect.gen(function* () {
    const config = optionalBooleanEnvironmentConfig("FEATURE");
    assert.equal(yield* config.parse(ConfigProvider.fromEnv({ env: {} })), undefined);
    assert.equal(yield* config.parse(ConfigProvider.fromEnv({ env: { FEATURE: "true" } })), true);
    assert.equal(yield* config.parse(ConfigProvider.fromEnv({ env: { FEATURE: "0" } })), false);
    const invalid = yield* Effect.exit(
      config.parse(ConfigProvider.fromEnv({ env: { FEATURE: "sometimes" } })),
    );
    assert.equal(invalid._tag, "Failure");
  }),
);
