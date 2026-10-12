import { describe, expect, it } from "vitest";
import {
  ProviderLaunchArgsError,
  buildCodexAppServerArgs,
  parseProviderLaunchArgs,
} from "./providerLaunchArgs";

describe("parseProviderLaunchArgs", () => {
  it("returns empty sides for blank input", () => {
    expect(parseProviderLaunchArgs("")).toEqual({ prefix: [], suffix: [] });
    expect(parseProviderLaunchArgs("   ")).toEqual({ prefix: [], suffix: [] });
  });

  it("tokenizes quoted values and escaped spaces", () => {
    expect(
      parseProviderLaunchArgs(`-c model_provider="apitoken" -c 'model="gpt-6-astra"'`),
    ).toEqual({
      prefix: ["-c", "model_provider=apitoken", "-c", 'model="gpt-6-astra"'],
      suffix: [],
    });
    expect(parseProviderLaunchArgs(`--config model="gpt 6"`)).toEqual({
      prefix: ["--config", "model=gpt 6"],
      suffix: [],
    });
  });

  it("splits unquoted -- into prefix and suffix", () => {
    expect(parseProviderLaunchArgs(`--profile apitoken -- -c notify=[]`)).toEqual({
      prefix: ["--profile", "apitoken"],
      suffix: ["-c", "notify=[]"],
    });
  });

  it("rejects unmatched quotes and dangling escapes", () => {
    expect(() => parseProviderLaunchArgs(`-c model="gpt`)).toThrow(ProviderLaunchArgsError);
    expect(() => parseProviderLaunchArgs(`-c model=gpt\\`)).toThrow(ProviderLaunchArgsError);
  });
});

describe("buildCodexAppServerArgs", () => {
  it("spawns a bare app-server when launch args are empty", () => {
    expect(buildCodexAppServerArgs()).toEqual(["app-server"]);
    expect(buildCodexAppServerArgs("")).toEqual(["app-server"]);
  });

  it("inserts global flags before app-server", () => {
    expect(buildCodexAppServerArgs(`-c model_provider="apitoken"`)).toEqual([
      "-c",
      "model_provider=apitoken",
      "app-server",
    ]);
  });

  it("appends tokens after -- to the app-server subcommand", () => {
    expect(buildCodexAppServerArgs(`-c model_provider="apitoken" -- --listen stdio://`)).toEqual([
      "-c",
      "model_provider=apitoken",
      "app-server",
      "--listen",
      "stdio://",
    ]);
  });
});

// Regression coverage for literal argv preservation across the app-server boundary.
describe("literal provider launch arguments", () => {
  it.each(['-c "--"', "-c '--'", '-c -"-"', '-c --""', "-c \\--"])(
    "keeps a protected separator as an option value: %s",
    (input) => {
      expect(buildCodexAppServerArgs(input)).toEqual(["-c", "--", "app-server"]);
    },
  );

  it("splits only the first unquoted separator after quoted values", () => {
    expect(buildCodexAppServerArgs('-c "--" -- --listen "stdio://" --')).toEqual([
      "-c",
      "--",
      "app-server",
      "--listen",
      "stdio://",
      "--",
    ]);
  });

  it("preserves double-quoted backslashes that POSIX quoting does not escape", () => {
    expect(buildCodexAppServerArgs('-c path="C:\\tools\\codex"')).toEqual([
      "-c",
      "path=C:\\tools\\codex",
      "app-server",
    ]);
  });

  it("unescapes only the supported characters inside double quotes", () => {
    const input = '-c "\\$\\"\\\\\\`"';
    expect(buildCodexAppServerArgs(input)).toEqual(["-c", '$"\\\x60', "app-server"]);
  });

  it.each(['-c ""', "-c ''", "-c \"\"''"])(
    "retains an explicit empty option value: %s",
    (input) => {
      expect(buildCodexAppServerArgs(input)).toEqual(["-c", "", "app-server"]);
    },
  );

  it("preserves empty suffix arguments and joins adjacent quoted fragments", () => {
    expect(buildCodexAppServerArgs('a""b -- --name "" \'\'')).toEqual([
      "ab",
      "app-server",
      "--name",
      "",
      "",
    ]);
  });

  it("preserves escaped trailing spaces without trimming their argument", () => {
    expect(buildCodexAppServerArgs("-c value\\ ")).toEqual(["-c", "value ", "app-server"]);
  });

  it("treats escaped newlines as continuations rather than argv characters", () => {
    expect(buildCodexAppServerArgs('-c va\\\nlue -- "su\\\nffix"')).toEqual([
      "-c",
      "value",
      "app-server",
      "suffix",
    ]);
    expect(buildCodexAppServerArgs("\\\n")).toEqual(["app-server"]);
  });

  it("does not expand shell variables or execute shell substitutions", () => {
    expect(buildCodexAppServerArgs('-c "$HOME" -c "$(literal)"')).toEqual([
      "-c",
      "$HOME",
      "-c",
      "$(literal)",
      "app-server",
    ]);
  });

  it("preserves every character between single quotes", () => {
    expect(buildCodexAppServerArgs("-c 'C:\\tools\\$HOME'")).toEqual([
      "-c",
      "C:\\tools\\$HOME",
      "app-server",
    ]);
  });
});
