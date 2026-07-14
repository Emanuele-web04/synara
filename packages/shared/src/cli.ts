import { Config, Effect, Option, Schema } from "effect";
import { CliError, Flag, type Param } from "effect/unstable/cli";

export interface OptionalBooleanFlagOptions {
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly negativeName?: string;
  readonly negativeDescription?: string;
}

export interface BooleanFlagInput {
  readonly positive: boolean | undefined;
  readonly negative: boolean | undefined;
}

/** Preserves missing values while still rejecting malformed boolean text. */
export const optionalBooleanEnvironmentConfig = (
  name: string,
): Config.Config<boolean | undefined> =>
  Config.schema(Schema.optional(Config.Boolean), name);

const requiredBooleanFlag = (
  name: string,
  options: Pick<OptionalBooleanFlagOptions, "description" | "aliases">,
): Flag.Flag<boolean> => {
  let flag = Flag.boolean(name);
  if (options.description) {
    flag = flag.pipe(Flag.withDescription(options.description));
  }
  for (const alias of options.aliases ?? []) {
    flag = flag.pipe(Flag.withAlias(alias));
  }

  const parse = flag.parse;
  return Object.assign(Object.create(Object.getPrototypeOf(flag)), flag, {
    parse: (args: Param.ParsedArgs) =>
      (args.flags[name]?.length ?? 0) > 0
        ? parse(args)
        : Effect.fail(new CliError.MissingOption({ option: name })),
  }) as Flag.Flag<boolean>;
};

/**
 * A boolean flag that preserves all three configuration states.
 *
 * Effect's standard boolean flag returns `false` when absent, so applying
 * `Flag.optional` cannot distinguish absence from an explicit false. This
 * constructor keeps the normal positive form and adds an explicit negative
 * form. `getBooleanFlagValue` returns `undefined` only when neither spelling
 * was supplied.
 */
export const optionalBooleanFlag = (
  name: string,
  options: OptionalBooleanFlagOptions = {},
): {
  readonly positive: Flag.Flag<boolean | undefined>;
  readonly negative: Flag.Flag<boolean | undefined>;
} => {
  const negativeName = options.negativeName ?? `no-${name}`;
  return {
    positive: requiredBooleanFlag(name, options).pipe(
      Flag.optional,
      Flag.map(Option.getOrUndefined),
    ),
    negative: requiredBooleanFlag(negativeName, {
      description:
        options.negativeDescription ??
        (options.description ? `Disable: ${options.description}` : `Disable --${name}.`),
    }).pipe(Flag.optional, Flag.map(Option.getOrUndefined)),
  };
};

export const getBooleanFlagValue = (input: BooleanFlagInput): boolean | undefined =>
  input.positive !== undefined
    ? input.positive
    : input.negative !== undefined
      ? !input.negative
      : undefined;

export const resolveBooleanConfig = (
  cliInput: BooleanFlagInput,
  environmentValue: boolean | undefined,
  fallback: boolean,
): boolean => getBooleanFlagValue(cliInput) ?? environmentValue ?? fallback;
