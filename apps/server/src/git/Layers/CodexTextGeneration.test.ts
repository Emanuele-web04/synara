// FILE: CodexTextGeneration.test.ts
// Purpose: Verifies isolated Codex text generation, account auth selection, and CLI safety.
// Layer: Server text-generation integration tests.

import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Duration, Effect, Fiber, FileSystem, Layer, Path } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";

import {
  resolveCodexHomeOverlayAccountSegment,
  resolveSynaraCodexHomeOverlayPath,
} from "../../codexHomePaths.ts";
import { ServerConfig } from "../../config.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { TextGenerationError } from "../Errors.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

const CodexTextGenerationTestLayer = CodexTextGenerationLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-codex-text-generation-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

let codexEnvQueue = Promise.resolve();

function acquireCodexEnvLock() {
  return Effect.promise(async () => {
    let releaseLock = () => {};
    const previous = codexEnvQueue;
    codexEnvQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    await previous;
    return releaseLock;
  });
}

function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(path)) {
        resolve();
      } else if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for test marker: ${path}`));
      } else {
        setTimeout(poll, 10);
      }
    };
    poll();
  });
}

function makeFakeCodexBinary(dir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const binDir = path.join(dir, "bin");
    const codexPath = path.join(binDir, "codex");
    yield* fs.makeDirectory(binDir, { recursive: true });

    yield* fs.writeFileString(
      codexPath,
      [
        "#!/bin/sh",
        'output_path=""',
        'schema_path=""',
        "while [ $# -gt 0 ]; do",
        '  if [ "$1" = "--image" ]; then',
        "    shift",
        '    if [ -n "$1" ]; then',
        '      seen_image="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--skip-git-repo-check" ]; then',
        '    seen_skip_git_repo_check="1"',
        "  fi",
        '  if [ "$1" = "--ignore-user-config" ]; then',
        '    seen_ignore_user_config="1"',
        "  fi",
        '  if [ "$1" = "--config" ]; then',
        "    shift",
        '    if [ "$1" = "approval_policy=\\"never\\"" ]; then',
        '      seen_approval_never="1"',
        "    fi",
        "    continue",
        "  fi",
        '  if [ "$1" = "--output-last-message" ]; then',
        "    shift",
        '    output_path="$1"',
        "  fi",
        '  if [ "$1" = "--output-schema" ]; then',
        "    shift",
        '    schema_path="$1"',
        "  fi",
        "  shift",
        "done",
        'stdin_content="$(cat)"',
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_IMAGE" = "1" ] && [ "$seen_image" != "1" ]; then',
        '  printf "%s\\n" "missing --image input" >&2',
        "  exit 2",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK" = "1" ] && [ "$seen_skip_git_repo_check" != "1" ]; then',
        '  printf "%s\\n" "missing --skip-git-repo-check" >&2',
        "  exit 9",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER" = "1" ] && [ "$seen_approval_never" != "1" ]; then',
        '  printf "%s\\n" "missing approval_policy=never" >&2',
        "  exit 10",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG" = "1" ] && [ "$seen_ignore_user_config" = "1" ]; then',
        '  printf "%s\\n" "error: unexpected argument --ignore-user-config" >&2',
        "  exit 12",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN" ]; then',
        '  printf "%s" "$stdin_content" | grep -F -- "$SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN" >/dev/null || {',
        '    printf "%s\\n" "stdin missing expected content" >&2',
        "    exit 3",
        "  }",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" ]; then',
        '  if printf "%s" "$stdin_content" | grep -F -- "$SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN" >/dev/null; then',
        '    printf "%s\\n" "stdin contained forbidden content" >&2',
        "    exit 4",
        "  fi",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME" = "1" ] && [ -z "$CODEX_HOME" ]; then',
        '  printf "%s\\n" "missing CODEX_HOME" >&2',
        "  exit 5",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON" = "1" ] && [ ! -f "$CODEX_HOME/auth.json" ]; then',
        '  printf "%s\\n" "missing auth.json in CODEX_HOME" >&2',
        "  exit 6",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_FORBID_AUTH_JSON" = "1" ] && [ -f "$CODEX_HOME/auth.json" ]; then',
        '  printf "%s\\n" "unexpected auth.json in CODEX_HOME" >&2',
        "  exit 11",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" ]; then',
        '  grep -F -- "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null || {',
        '    printf "%s\\n" "CODEX_HOME config missing expected content" >&2',
        "    exit 7",
        "  }",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" ]; then',
        '  if grep -F -- "$SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN" "$CODEX_HOME/config.toml" >/dev/null; then',
        '    printf "%s\\n" "CODEX_HOME config contained forbidden content" >&2',
        "    exit 8",
        "  fi",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING" = "1" ]; then',
        '  grep -F -- \"model_provider = \\\"azure\\\"\" "$CODEX_HOME/config.toml" >/dev/null || exit 13',
        '  grep -F -- "[model_providers.azure]" "$CODEX_HOME/config.toml" >/dev/null || exit 14',
        '  grep -F -- \"env_key = \\\"AZURE_OPENAI_API_KEY\\\"\" "$CODEX_HOME/config.toml" >/dev/null || exit 15',
        '  grep -F -- \"base_url = \\\"https://example.openai.azure.com/openai\\\"\" "$CODEX_HOME/config.toml" >/dev/null || exit 19',
        '  [ "$AZURE_OPENAI_API_KEY" = "test-key" ] || exit 16',
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS" = "1" ]; then',
        '  if grep -F -- "[[skills.config]]" "$CODEX_HOME/config.toml" >/dev/null || grep -F -- "[plugins." "$CODEX_HOME/config.toml" >/dev/null; then',
        '    printf "%s\\n" "user extension config leaked into CODEX_HOME" >&2',
        "    exit 17",
        "  fi",
        '  if grep -E -- "^(notify|sqlite_home|instructions)[[:space:]]*=|^\\[(mcp_servers|projects|shell_environment_policy)" "$CODEX_HOME/config.toml" >/dev/null; then',
        '    printf "%s\\n" "executable or unrelated config leaked into CODEX_HOME" >&2',
        "    exit 22",
        "  fi",
        '  if [ -e "$CODEX_HOME/skills" ] || [ -e "$CODEX_HOME/plugins" ]; then',
        '    printf "%s\\n" "user extension assets leaked into CODEX_HOME" >&2',
        "    exit 18",
        "  fi",
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_REQUIRE_SECURE_ISOLATION" = "1" ]; then',
        '  if [ "$CODEX_SQLITE_HOME" != "$CODEX_HOME" ]; then',
        '    printf "%s\\n" "CODEX_SQLITE_HOME is not isolated with CODEX_HOME" >&2',
        "    exit 20",
        "  fi",
        '  node -e \'const fs=require("node:fs"); const [home,cwd,config,schema,output,forbidden]=process.argv.slice(1); const mode=(p)=>fs.statSync(p).mode & 0o777; if (home===forbidden || cwd===forbidden || fs.readdirSync(cwd).length!==0 || mode(home)!==0o700 || mode(cwd)!==0o700 || mode(config)!==0o600 || mode(schema)!==0o600 || mode(output)!==0o600) process.exit(1);\' "$CODEX_HOME" "$PWD" "$CODEX_HOME/config.toml" "$schema_path" "$output_path" "$SYNARA_FAKE_CODEX_FORBIDDEN_CWD" || {',
        '    printf "%s\\n" "Codex process resources were not privately isolated" >&2',
        "    exit 21",
        "  }",
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_RESOURCE_MANIFEST" ]; then',
        '  node -e \'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)));\' "$SYNARA_FAKE_CODEX_RESOURCE_MANIFEST" "$CODEX_HOME" "$PWD" "$schema_path" "$output_path"',
        "fi",
        'if [ "$SYNARA_FAKE_CODEX_TRAP_TERM" = "1" ]; then',
        '  exec node -e \'const fs=require("node:fs"); const [term,pid,ready]=process.argv.slice(1); fs.writeFileSync(pid,String(process.pid)); process.on("SIGTERM",()=>fs.appendFileSync(term,"TERM\\n")); fs.writeFileSync(ready,"ready"); setInterval(()=>{},1000);\' "$SYNARA_FAKE_CODEX_TERM_MARKER" "$SYNARA_FAKE_CODEX_PID_MARKER" "$SYNARA_FAKE_CODEX_READY_MARKER"',
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_STDERR" ]; then',
        '  printf "%s\\n" "$SYNARA_FAKE_CODEX_STDERR" >&2',
        "fi",
        'if [ -n "$SYNARA_FAKE_CODEX_ROTATED_AUTH" ]; then',
        '  printf "%s" "$SYNARA_FAKE_CODEX_ROTATED_AUTH" > "$CODEX_HOME/auth.json"',
        "fi",
        'if [ -n "$output_path" ]; then',
        '  node -e \'const fs=require("node:fs"); const value=process.argv[2] ?? ""; fs.writeFileSync(process.argv[1], Buffer.from(value, "base64"));\' "$output_path" "${SYNARA_FAKE_CODEX_OUTPUT_B64:-e30=}"',
        "fi",
        'exit "${SYNARA_FAKE_CODEX_EXIT_CODE:-0}"',
        "",
      ].join("\n"),
    );
    yield* fs.chmod(codexPath, 0o755);
    return binDir;
  });
}

function withFakeCodexEnv<A, E, R>(
  input: {
    output: string;
    exitCode?: number;
    stderr?: string;
    requireImage?: boolean;
    stdinMustContain?: string;
    stdinMustNotContain?: string;
    requireCodexHome?: boolean;
    requireAuthJson?: boolean;
    forbidAuthJson?: boolean;
    requireSkipGitRepoCheck?: boolean;
    requireApprovalNever?: boolean;
    forbidIgnoreUserConfig?: boolean;
    requireAzureProviderRouting?: boolean;
    requireNoUserExtensions?: boolean;
    requireSecureIsolation?: boolean;
    forbiddenCwd?: string;
    trapTerm?: boolean;
    termMarkerPath?: string;
    pidMarkerPath?: string;
    readyMarkerPath?: string;
    resourceManifestPath?: string;
    permissiveUmask?: boolean;
    rotatedAuth?: string;
    codexHomeConfigMustContain?: string;
    codexHomeConfigMustNotContain?: string;
  },
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.acquireUseRelease(
    Effect.gen(function* () {
      const releaseLock = yield* acquireCodexEnvLock();
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "synara-codex-text-" });
      const binDir = yield* makeFakeCodexBinary(tempDir);
      const previousPath = process.env.PATH;
      const previousSynaraHome = process.env.SYNARA_HOME;
      const previousOutput = process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
      const previousExitCode = process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
      const previousStderr = process.env.SYNARA_FAKE_CODEX_STDERR;
      const previousRequireImage = process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
      const previousStdinMustContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
      const previousStdinMustNotContain = process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
      const previousRequireCodexHome = process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
      const previousRequireAuthJson = process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
      const previousRequireSkipGitRepoCheck =
        process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
      const previousRequireApprovalNever = process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
      const previousForbidIgnoreUserConfig =
        process.env.SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG;
      const previousRequireAzureProviderRouting =
        process.env.SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING;
      const previousRequireNoUserExtensions =
        process.env.SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS;
      const previousRotatedAuth = process.env.SYNARA_FAKE_CODEX_ROTATED_AUTH;
      const previousForbidAuthJson = process.env.SYNARA_FAKE_CODEX_FORBID_AUTH_JSON;
      const previousCodexHomeConfigMustContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
      const previousCodexHomeConfigMustNotContain =
        process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
      const previousRequireSecureIsolation = process.env.SYNARA_FAKE_CODEX_REQUIRE_SECURE_ISOLATION;
      const previousForbiddenCwd = process.env.SYNARA_FAKE_CODEX_FORBIDDEN_CWD;
      const previousTrapTerm = process.env.SYNARA_FAKE_CODEX_TRAP_TERM;
      const previousTermMarker = process.env.SYNARA_FAKE_CODEX_TERM_MARKER;
      const previousPidMarker = process.env.SYNARA_FAKE_CODEX_PID_MARKER;
      const previousReadyMarker = process.env.SYNARA_FAKE_CODEX_READY_MARKER;
      const previousResourceManifest = process.env.SYNARA_FAKE_CODEX_RESOURCE_MANIFEST;
      const previousUmask = process.umask();

      yield* Effect.sync(() => {
        process.env.PATH = `${binDir}:${previousPath ?? ""}`;
        process.env.SYNARA_HOME = tempDir;
        if (input.permissiveUmask) process.umask(0);
        process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = Buffer.from(input.output, "utf8").toString(
          "base64",
        );

        if (input.exitCode !== undefined) {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = String(input.exitCode);
        } else {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        }

        if (input.stderr !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDERR = input.stderr;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        }

        if (input.requireImage) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        }

        if (input.stdinMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = input.stdinMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        }

        if (input.stdinMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN = input.stdinMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        }

        if (input.requireCodexHome) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        }

        if (input.requireAuthJson) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        }
        if (input.forbidAuthJson) {
          process.env.SYNARA_FAKE_CODEX_FORBID_AUTH_JSON = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_FORBID_AUTH_JSON;
        }

        if (input.requireSkipGitRepoCheck) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        }

        if (input.requireApprovalNever) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        }

        if (input.forbidIgnoreUserConfig) {
          process.env.SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG;
        }
        if (input.requireAzureProviderRouting) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING;
        }
        if (input.requireNoUserExtensions) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS;
        }
        if (input.requireSecureIsolation) {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SECURE_ISOLATION = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SECURE_ISOLATION;
        }
        if (input.forbiddenCwd !== undefined) {
          process.env.SYNARA_FAKE_CODEX_FORBIDDEN_CWD = input.forbiddenCwd;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_FORBIDDEN_CWD;
        }
        if (input.trapTerm) {
          process.env.SYNARA_FAKE_CODEX_TRAP_TERM = "1";
        } else {
          delete process.env.SYNARA_FAKE_CODEX_TRAP_TERM;
        }
        for (const [key, value] of [
          ["SYNARA_FAKE_CODEX_TERM_MARKER", input.termMarkerPath],
          ["SYNARA_FAKE_CODEX_PID_MARKER", input.pidMarkerPath],
          ["SYNARA_FAKE_CODEX_READY_MARKER", input.readyMarkerPath],
          ["SYNARA_FAKE_CODEX_RESOURCE_MANIFEST", input.resourceManifestPath],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        if (input.rotatedAuth !== undefined) {
          process.env.SYNARA_FAKE_CODEX_ROTATED_AUTH = input.rotatedAuth;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_ROTATED_AUTH;
        }

        if (input.codexHomeConfigMustContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            input.codexHomeConfigMustContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        }

        if (input.codexHomeConfigMustNotContain !== undefined) {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            input.codexHomeConfigMustNotContain;
        } else {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        }
      });

      return {
        previousPath,
        previousSynaraHome,
        previousOutput,
        previousExitCode,
        previousStderr,
        previousRequireImage,
        previousStdinMustContain,
        previousStdinMustNotContain,
        previousRequireCodexHome,
        previousRequireAuthJson,
        previousForbidAuthJson,
        previousRequireSkipGitRepoCheck,
        previousRequireApprovalNever,
        previousForbidIgnoreUserConfig,
        previousRequireAzureProviderRouting,
        previousRequireNoUserExtensions,
        previousRotatedAuth,
        previousCodexHomeConfigMustContain,
        previousCodexHomeConfigMustNotContain,
        previousRequireSecureIsolation,
        previousForbiddenCwd,
        previousTrapTerm,
        previousTermMarker,
        previousPidMarker,
        previousReadyMarker,
        previousResourceManifest,
        previousUmask,
        releaseLock,
      };
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.PATH = previous.previousPath;
        if (previous.previousSynaraHome === undefined) {
          delete process.env.SYNARA_HOME;
        } else {
          process.env.SYNARA_HOME = previous.previousSynaraHome;
        }

        if (previous.previousOutput === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_OUTPUT_B64;
        } else {
          process.env.SYNARA_FAKE_CODEX_OUTPUT_B64 = previous.previousOutput;
        }

        if (previous.previousExitCode === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_EXIT_CODE;
        } else {
          process.env.SYNARA_FAKE_CODEX_EXIT_CODE = previous.previousExitCode;
        }

        if (previous.previousStderr === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDERR;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDERR = previous.previousStderr;
        }

        if (previous.previousRequireImage === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_IMAGE = previous.previousRequireImage;
        }

        if (previous.previousStdinMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_CONTAIN = previous.previousStdinMustContain;
        }

        if (previous.previousStdinMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_STDIN_MUST_NOT_CONTAIN =
            previous.previousStdinMustNotContain;
        }

        if (previous.previousRequireCodexHome === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_CODEX_HOME = previous.previousRequireCodexHome;
        }

        if (previous.previousRequireAuthJson === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AUTH_JSON = previous.previousRequireAuthJson;
        }
        if (previous.previousForbidAuthJson === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_FORBID_AUTH_JSON;
        } else {
          process.env.SYNARA_FAKE_CODEX_FORBID_AUTH_JSON = previous.previousForbidAuthJson;
        }

        if (previous.previousRequireSkipGitRepoCheck === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_SKIP_GIT_REPO_CHECK =
            previous.previousRequireSkipGitRepoCheck;
        }

        if (previous.previousRequireApprovalNever === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_APPROVAL_NEVER =
            previous.previousRequireApprovalNever;
        }

        if (previous.previousForbidIgnoreUserConfig === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG;
        } else {
          process.env.SYNARA_FAKE_CODEX_FORBID_IGNORE_USER_CONFIG =
            previous.previousForbidIgnoreUserConfig;
        }
        if (previous.previousRequireAzureProviderRouting === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_AZURE_PROVIDER_ROUTING =
            previous.previousRequireAzureProviderRouting;
        }
        if (previous.previousRequireNoUserExtensions === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS;
        } else {
          process.env.SYNARA_FAKE_CODEX_REQUIRE_NO_USER_EXTENSIONS =
            previous.previousRequireNoUserExtensions;
        }
        if (previous.previousRotatedAuth === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_ROTATED_AUTH;
        } else {
          process.env.SYNARA_FAKE_CODEX_ROTATED_AUTH = previous.previousRotatedAuth;
        }

        if (previous.previousCodexHomeConfigMustContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_CONTAIN =
            previous.previousCodexHomeConfigMustContain;
        }

        if (previous.previousCodexHomeConfigMustNotContain === undefined) {
          delete process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN;
        } else {
          process.env.SYNARA_FAKE_CODEX_CODEX_HOME_CONFIG_MUST_NOT_CONTAIN =
            previous.previousCodexHomeConfigMustNotContain;
        }

        for (const [key, value] of [
          ["SYNARA_FAKE_CODEX_REQUIRE_SECURE_ISOLATION", previous.previousRequireSecureIsolation],
          ["SYNARA_FAKE_CODEX_FORBIDDEN_CWD", previous.previousForbiddenCwd],
          ["SYNARA_FAKE_CODEX_TRAP_TERM", previous.previousTrapTerm],
          ["SYNARA_FAKE_CODEX_TERM_MARKER", previous.previousTermMarker],
          ["SYNARA_FAKE_CODEX_PID_MARKER", previous.previousPidMarker],
          ["SYNARA_FAKE_CODEX_READY_MARKER", previous.previousReadyMarker],
          ["SYNARA_FAKE_CODEX_RESOURCE_MANIFEST", previous.previousResourceManifest],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        process.umask(previous.previousUmask);

        previous.releaseLock();
      }),
  );
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGenerationLive", (it) => {
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
        });

        expect(generated.subject.length).toBeLessThanOrEqual(72);
        expect(generated.subject.endsWith(".")).toBe(false);
        expect(generated.body).toBe("- added migration\n- updated tests");
        expect(generated.branch).toBeUndefined();
      }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          includeBranch: true,
        });

        expect(generated.subject).toBe("Add important change");
        expect(generated.branch).toBe("feature/fix/important-system-change");
      }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generatePrContent({
          cwd: process.cwd(),
          baseBranch: "main",
          headBranch: "feature/codex-effect",
          commitSummary: "feat: improve orchestration flow",
          diffSummary: "2 files changed",
          diffPatch: "diff --git a/a.ts b/a.ts",
        });

        expect(generated.title).toBe("Improve orchestration flow");
        expect(generated.body.startsWith("## Summary")).toBe(true);
        expect(generated.body.endsWith("\n\n")).toBe(false);
      }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Please update session handling.",
        });

        expect(generated.branch).toBe("feat/session");
      }),
    ),
  );

  it.effect("generates compact thread titles from the first user message", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: ' "Polish sidebar loading state." ',
        }),
        stdinMustContain: "Never exceed 6 words.",
        requireSkipGitRepoCheck: true,
        requireApprovalNever: true,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "The sidebar loading state feels noisy and needs polish.",
        });

        expect(generated.title).toBe("Polish sidebar loading state");
      }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration.generateBranchName({
          cwd: process.cwd(),
          message: "Fix timeout behavior.",
        });

        expect(generated.branch).toBe("fix/session-timeout");
      }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-branch-image-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(Effect.ensuring(fs.remove(attachmentPath).pipe(Effect.catch(() => Effect.void))));

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const attachmentId = `thread-1-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
        yield* fs.makeDirectory(attachmentsDir, { recursive: true });
        yield* fs.writeFile(imagePath, Buffer.from("hello"));

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.tap(() =>
              fs.stat(imagePath).pipe(
                Effect.map((fileInfo) => {
                  expect(fileInfo.type).toBe("File");
                }),
              ),
            ),
            Effect.ensuring(fs.remove(imagePath).pipe(Effect.catch(() => Effect.void))),
          );

        expect(generated.branch).toBe("fix/ui-regression");
      }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { attachmentsDir } = yield* ServerConfig;
        const missingAttachmentId = `thread-missing-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
        yield* fs.remove(missingPath).pipe(Effect.catch(() => Effect.void));

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: missingAttachmentId,
                name: "outside.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("missing --image input");
        }
      }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        Effect.gen(function* () {
          const textGeneration = yield* TextGeneration;

          const result = yield* textGeneration
            .generateBranchName({
              cwd: process.cwd(),
              message: "Fix websocket reconnect flake",
            })
            .pipe(
              Effect.match({
                onFailure: (error) => ({ _tag: "Left" as const, left: error }),
                onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
              }),
            );

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left).toBeInstanceOf(TextGenerationError);
            expect(result.left.message).toContain("Codex returned invalid structured output");
          }
        }),
      ),
  );

  it.effect("keeps an exit-zero auth rotation when downstream output decoding fails", () => {
    const rotatedAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "workspace-1", access_token: "after" },
    });
    return withFakeCodexEnv(
      {
        output: JSON.stringify({ title: "This is not a branch payload" }),
        requireAuthJson: true,
        rotatedAuth,
      },
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const accountHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "synara-output-error-auth-",
        });
        const authPath = path.join(accountHome, "auth.json");
        yield* fileSystem.writeFileString(
          authPath,
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: { account_id: "workspace-1", access_token: "before" },
          }),
        );

        const textGeneration = yield* TextGeneration;
        const error = yield* textGeneration
          .generateBranchName({
            cwd: process.cwd(),
            message: "Fix websocket reconnect flake",
            providerOptions: { codex: { homePath: accountHome } },
          })
          .pipe(Effect.flip);

        expect(error).toBeInstanceOf(TextGenerationError);
        expect(error.message).toContain("Codex returned invalid structured output");
        expect(error.message).not.toContain("auth changed");
        expect(yield* fileSystem.readFileString(authPath)).toBe(rotatedAuth);
      }),
    );
  });

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;

        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-error",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
          })
          .pipe(
            Effect.match({
              onFailure: (error) => ({ _tag: "Left" as const, left: error }),
              onSuccess: (value) => ({ _tag: "Right" as const, right: value }),
            }),
          );

        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left).toBeInstanceOf(TextGenerationError);
          expect(result.left.message).toContain("Codex CLI command failed: codex execution failed");
        }
      }),
    ),
  );

  it.effect("omits the newer config flag while preserving custom provider routing", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        requireAuthJson: true,
        forbidIgnoreUserConfig: true,
        requireAzureProviderRouting: true,
        requireNoUserExtensions: true,
        requireSecureIsolation: true,
        forbiddenCwd: process.cwd(),
        permissiveUmask: true,
        codexHomeConfigMustNotContain: "sqlite_home",
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const wrongCodexHome = yield* fs.makeTempDirectoryScoped({ prefix: "synara-wrong-codex-" });
        const customCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-custom-codex-",
        });
        const previousCodexHome = process.env.CODEX_HOME;

        yield* fs.writeFileString(
          path.join(customCodexHome, "config.toml"),
          [
            'profile = "work"',
            'sqlite_home = "/shared/codex.sqlite"',
            'notify = ["/bin/sh", "-c", "unsafe"]',
            'instructions = "unsafe inherited instructions"',
            "",
            "[profiles.work]",
            'model_provider = "azure"',
            'model = "gpt-5.6-mini"',
            "",
            "[model_providers.azure]",
            'base_url = "https://example.openai.azure.com/openai"',
            'env_key = "AZURE_OPENAI_API_KEY"',
            'wire_api = "responses"',
            "",
            "[[skills.config]]",
            'path = "/broken/skill/SKILL.md"',
            "enabled = true",
            "",
            '[plugins."custom-tools@local"]',
            "enabled = true",
            "",
            "[features]",
            "fast_mode = true",
            "",
            "[mcp_servers.unsafe]",
            'command = "unsafe-mcp"',
            "",
            '[projects."/repo"]',
            'trust_level = "trusted"',
            "",
            "[shell_environment_policy]",
            'include_only = ["SECRET"]',
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(customCodexHome, "auth.json"),
          '{"access_token":"test"}',
        );
        yield* fs.makeDirectory(path.join(customCodexHome, "skills", "unsafe"), {
          recursive: true,
        });
        yield* fs.makeDirectory(path.join(customCodexHome, "plugins", "unsafe"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(wrongCodexHome, "config.toml"), 'model = "gpt-5.4"');

        yield* Effect.sync(() => {
          process.env.CODEX_HOME = wrongCodexHome;
        });

        const textGeneration = yield* TextGeneration;

        const generated = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            codexHomePath: wrongCodexHome,
            providerOptions: {
              codex: {
                homePath: customCodexHome,
                environment: { AZURE_OPENAI_API_KEY: "test-key" },
              },
            },
          })
          .pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (previousCodexHome === undefined) {
                  delete process.env.CODEX_HOME;
                } else {
                  process.env.CODEX_HOME = previousCodexHome;
                }
              }),
            ),
          );

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("persists auth rotation in the selected shadow account home", () => {
    const rotatedAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "workspace-1",
        access_token: "access-2",
        refresh_token: "refresh-2",
      },
    });
    return withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireAuthJson: true,
        forbidIgnoreUserConfig: true,
        rotatedAuth,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-config-codex-",
        });
        const accountHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-authoritative-codex-",
        });
        const defaultAuth = '{"access_token":"default-account"}';
        const defaultAuthPath = path.join(configHome, "auth.json");
        const authPath = path.join(accountHome, "auth.json");
        yield* fs.writeFileString(defaultAuthPath, defaultAuth);
        yield* fs.writeFileString(
          authPath,
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              account_id: "workspace-1",
              access_token: "access-1",
              refresh_token: "refresh-1",
            },
          }),
        );

        const textGeneration = yield* TextGeneration;
        yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-auth-rotation",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: { homePath: configHome, shadowHomePath: accountHome, accountId: "work" },
          },
        });

        expect(yield* fs.readFileString(authPath)).toBe(rotatedAuth);
        expect(yield* fs.readFileString(defaultAuthPath)).toBe(defaultAuth);
      }),
    );
  });

  it.effect("rejects unobservable Codex auth stores before isolated text generation", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "must not run", body: "" }),
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const customCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-keyring-codex-",
        });
        yield* fs.writeFileString(
          path.join(customCodexHome, "config.toml"),
          'cli_auth_credentials_store = "keyring"\n',
        );

        const textGeneration = yield* TextGeneration;
        const result = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-keyring",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            codexHomePath: customCodexHome,
          })
          .pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(TextGenerationError);
          expect(result.failure.message).toMatch(/require file-backed Codex auth/);
        }
      }),
    ),
  );

  it.effect("prefers the routed instance home over a legacy Codex home", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        codexHomeConfigMustContain: 'model = "gpt-5.4-instance"',
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const legacyHome = yield* fs.makeTempDirectoryScoped({ prefix: "synara-legacy-codex-" });
        const instanceHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-instance-codex-",
        });
        yield* fs.writeFileString(path.join(legacyHome, "config.toml"), 'model = "legacy"');
        yield* fs.writeFileString(
          path.join(instanceHome, "config.toml"),
          'model = "gpt-5.4-instance"',
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          codexHomePath: legacyHome,
          providerOptions: { codex: { homePath: instanceHome, accountId: "work" } },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("copies auth from an account's own dedicated text-generation home", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        requireAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const customCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-account-home-codex-",
        });
        yield* fs.writeFileString(
          path.join(customCodexHome, "auth.json"),
          '{"access_token":"work-account"}',
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: {
              homePath: customCodexHome,
              accountId: "work",
            },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("does not copy shared default auth into account-only text-generation homes", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shared-codex-",
        });
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );
        const previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = sharedCodexHome;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousCodexHome === undefined) {
              delete process.env.CODEX_HOME;
            } else {
              process.env.CODEX_HOME = previousCodexHome;
            }
          }),
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: {
              accountId: "work",
            },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("does not treat an explicit ambient Codex home as dedicated account auth", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-explicit-shared-codex-",
        });
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );
        const previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = sharedCodexHome;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
            else process.env.CODEX_HOME = previousCodexHome;
          }),
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: { homePath: sharedCodexHome, accountId: "work" },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("expands a tilde shadow home before copying account auth", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireCodexHome: true,
        requireAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const shadowHome = mkdtempSync(path.join(homedir(), ".synara-codex-shadow-test-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => rmSync(shadowHome, { recursive: true, force: true })),
        );
        yield* fs.writeFileString(
          path.join(shadowHome, "auth.json"),
          '{"access_token":"work-account"}',
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: { shadowHomePath: `~/${path.relative(homedir(), shadowHome)}` },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );

  it.effect("does not fall back to shared auth when shadow auth is a symlink", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shared-codex-",
        });
        const shadowHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shadow-codex-",
        });
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );
        symlinkSync(path.join(sharedCodexHome, "auth.json"), path.join(shadowHome, "auth.json"));

        const textGeneration = yield* TextGeneration;
        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-account",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            providerOptions: {
              codex: { homePath: sharedCodexHome, shadowHomePath: shadowHome },
            },
          })
          .pipe(Effect.flip);

        expect(error.message).toMatch(/private state.*symlink/i);
      }),
    ),
  );

  it.effect("does not copy auth through a symlinked shadow-home directory", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shared-codex-",
        });
        const shadowTarget = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shadow-target-codex-",
        });
        const shadowAliasRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shadow-alias-codex-",
        });
        const shadowAlias = path.join(shadowAliasRoot, "shadow");
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );
        yield* fs.writeFileString(
          path.join(shadowTarget, "auth.json"),
          '{"access_token":"work-account"}',
        );
        symlinkSync(shadowTarget, shadowAlias);

        const textGeneration = yield* TextGeneration;
        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-account",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            providerOptions: {
              codex: { homePath: sharedCodexHome, shadowHomePath: shadowAlias },
            },
          })
          .pipe(Effect.flip);

        expect(error.message).toMatch(/shadow home.*symlink/i);
      }),
    ),
  );

  it.effect("does not copy auth through a symlinked shadow-home parent", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "Add important change", body: "" }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const defaultParent = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-default-parent-codex-",
        });
        const sharedCodexHome = path.join(defaultParent, "codex-home");
        const aliasRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shadow-parent-alias-codex-",
        });
        const parentAlias = path.join(aliasRoot, "parent-alias");
        const aliasedShadowHome = path.join(parentAlias, "codex-home");
        yield* fs.makeDirectory(sharedCodexHome, { recursive: true });
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );
        symlinkSync(defaultParent, parentAlias, "dir");

        const textGeneration = yield* TextGeneration;
        const error = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-account",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            providerOptions: {
              codex: { homePath: sharedCodexHome, shadowHomePath: aliasedShadowHome },
            },
          })
          .pipe(Effect.flip);

        expect(error.message).toMatch(/shadow home must be different/i);
      }),
    ),
  );

  it.effect("does not copy symlinked account-overlay auth into text-generation homes", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireCodexHome: true,
        forbidAuthJson: true,
      },
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const sharedCodexHome = yield* fs.makeTempDirectoryScoped({
          prefix: "synara-shared-codex-",
        });
        yield* fs.writeFileString(
          path.join(sharedCodexHome, "auth.json"),
          '{"access_token":"default-account"}',
        );

        const accountSegment = resolveCodexHomeOverlayAccountSegment({
          homePath: sharedCodexHome,
          accountId: "work",
        });
        expect(accountSegment).toBeDefined();
        const accountOverlayHome = resolveSynaraCodexHomeOverlayPath(
          process.env,
          sharedCodexHome,
          accountSegment,
        );
        yield* fs.makeDirectory(accountOverlayHome, { recursive: true });
        symlinkSync(
          path.join(sharedCodexHome, "auth.json"),
          path.join(accountOverlayHome, "auth.json"),
        );

        const previousCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = sharedCodexHome;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previousCodexHome === undefined) {
              delete process.env.CODEX_HOME;
            } else {
              process.env.CODEX_HOME = previousCodexHome;
            }
          }),
        );

        const textGeneration = yield* TextGeneration;
        const generated = yield* textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-account",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          providerOptions: {
            codex: {
              accountId: "work",
            },
          },
        });

        expect(generated.subject).toBe("Add important change");
      }),
    ),
  );
});

it.effect("escalates from TERM to KILL when a timed-out child traps TERM", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const markerDirectory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "synara-codex-term-markers-",
    });
    const termMarkerPath = `${markerDirectory}/term`;
    const pidMarkerPath = `${markerDirectory}/pid`;
    const readyMarkerPath = `${markerDirectory}/ready`;
    const resourceManifestPath = `${markerDirectory}/resources.json`;

    const requestFiber = yield* withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "never written", body: "" }),
        trapTerm: true,
        termMarkerPath,
        pidMarkerPath,
        readyMarkerPath,
        resourceManifestPath,
      },
      Effect.gen(function* () {
        const textGeneration = yield* TextGeneration;
        const requestExit = yield* textGeneration
          .generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/timeout",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
          })
          .pipe(Effect.exit);
        const resourcePaths = JSON.parse(
          readFileSync(resourceManifestPath, "utf8"),
        ) as readonly string[];
        return {
          requestExit,
          leakedResourcePaths: resourcePaths.filter(existsSync),
        };
      }),
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Effect.promise(() => waitForFile(readyMarkerPath));
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(180_000));
    if (process.platform !== "win32") {
      yield* Effect.promise(() => waitForFile(termMarkerPath));
    } else {
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
    yield* TestClock.adjust(Duration.millis(1_500));
    const result = yield* Fiber.join(requestFiber);

    expect(result.requestExit._tag).toBe("Failure");
    expect(result.leakedResourcePaths).toEqual([]);
    expect(existsSync(readyMarkerPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(readFileSync(termMarkerPath, "utf8")).toContain("TERM");
    }
    const pid = Number(readFileSync(pidMarkerPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }).pipe(Effect.provide(CodexTextGenerationTestLayer)),
);
