/**
 * codexAuthBootstrap unit tests — host-side auth resolution and the
 * sandbox-side injection commands.
 *
 * @module executionRuntime/codexAuthBootstrap.test
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildCodexAuthInjectionCommand,
  buildCodexInstructionsInjectionCommand,
  buildMinimalCodexConfigCommand,
  MINIMAL_SANDBOX_CODEX_CONFIG,
  resolveOperatorCodexAuth,
  resolveOperatorCodexInstructions,
} from "./codexAuthBootstrap.ts";

describe("resolveOperatorCodexAuth", () => {
  const tempDirs: string[] = [];
  const makeCodexHome = (authJson: string | null): string => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-auth-"));
    tempDirs.push(home);
    if (authJson !== null) {
      writeFileSync(path.join(home, "auth.json"), authJson, "utf8");
    }
    return home;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads auth.json from the CODEX_HOME base path", () => {
    const home = makeCodexHome('{"tokens":{"access_token":"abc"}}');
    const auth = resolveOperatorCodexAuth({ CODEX_HOME: home });
    expect(auth?.authJson).toBe('{"tokens":{"access_token":"abc"}}');
  });

  it("prefers an explicit home path over CODEX_HOME", () => {
    const explicit = makeCodexHome('{"explicit":true}');
    const env = makeCodexHome('{"env":true}');
    const auth = resolveOperatorCodexAuth({ CODEX_HOME: env }, explicit);
    expect(auth?.authJson).toBe('{"explicit":true}');
  });

  it("returns null when auth.json is absent", () => {
    const home = makeCodexHome(null);
    expect(resolveOperatorCodexAuth({ CODEX_HOME: home })).toBeNull();
  });

  it("returns null for an empty auth.json", () => {
    const home = makeCodexHome("   ");
    expect(resolveOperatorCodexAuth({ CODEX_HOME: home })).toBeNull();
  });
});

describe("buildCodexAuthInjectionCommand", () => {
  it("passes the auth bytes as a base64 positional arg under bash -lc", () => {
    const authJson = '{"tokens":{"access_token":"a\'b"}}';
    const command = buildCodexAuthInjectionCommand({ authJson });
    expect(command.command).toBe("bash");
    expect(command.args[0]).toBe("-lc");
    // The script writes auth.json under $HOME and leaves it owner-writable (600).
    expect(command.args[1]).toContain('"$HOME/.codex/auth.json"');
    expect(command.args[1]).toContain("base64 -d");
    expect(command.args[1]).toContain("chmod 600");
    // The auth content rides as $0 (base64), so a quote in the JSON cannot break
    // the shell — the decoded base64 round-trips to the original bytes.
    const b64 = command.args[2] as string;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(authJson);
  });
});

describe("buildMinimalCodexConfigCommand", () => {
  it("writes the minimal config only when the image ships none", () => {
    const command = buildMinimalCodexConfigCommand();
    expect(command.command).toBe("bash");
    expect(command.args[1]).toContain('if [ ! -f "$HOME/.codex/config.toml" ]');
    const b64 = command.args[2] as string;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(MINIMAL_SANDBOX_CODEX_CONFIG);
  });

  it("omits host-specific config (no browser plugin, no [projects])", () => {
    expect(MINIMAL_SANDBOX_CODEX_CONFIG).not.toContain("dpcode-browser");
    expect(MINIMAL_SANDBOX_CODEX_CONFIG).not.toContain("[projects");
    expect(MINIMAL_SANDBOX_CODEX_CONFIG).toContain("sandbox_mode");
  });
});

describe("resolveOperatorCodexInstructions", () => {
  const tempDirs: string[] = [];
  const makeCodexHome = (agentsMarkdown: string | null): string => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-agents-"));
    tempDirs.push(home);
    if (agentsMarkdown !== null) {
      writeFileSync(path.join(home, "AGENTS.md"), agentsMarkdown, "utf8");
    }
    return home;
  };

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads AGENTS.md from the CODEX_HOME base path", () => {
    const home = makeCodexHome("# Operator rules\n- no any\n");
    expect(resolveOperatorCodexInstructions({ CODEX_HOME: home })?.agentsMarkdown).toBe(
      "# Operator rules\n- no any\n",
    );
  });

  it("returns null when AGENTS.md is absent or empty", () => {
    expect(resolveOperatorCodexInstructions({ CODEX_HOME: makeCodexHome(null) })).toBeNull();
    expect(resolveOperatorCodexInstructions({ CODEX_HOME: makeCodexHome("   ") })).toBeNull();
  });
});

describe("buildCodexInstructionsInjectionCommand", () => {
  it("writes AGENTS.md under $HOME/.codex with the markdown as a base64 arg", () => {
    const agentsMarkdown = "# Rules\n- prefer existing patterns\n- run lint+typecheck\n";
    const command = buildCodexInstructionsInjectionCommand({ agentsMarkdown });
    expect(command.command).toBe("bash");
    expect(command.args[0]).toBe("-lc");
    expect(command.args[1]).toContain('"$HOME/.codex/AGENTS.md"');
    expect(command.args[1]).toContain("base64 -d");
    const b64 = command.args[2] as string;
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(agentsMarkdown);
  });
});
