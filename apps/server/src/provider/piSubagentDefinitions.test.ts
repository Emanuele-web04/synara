import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { listPiSubagentDefinitions } from "./piSubagentDefinitions.ts";

function writeAgent(dir: string, fileName: string, frontmatter: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, fileName), `---\n${frontmatter}\n---\n\nBody\n`);
}

describe("listPiSubagentDefinitions", () => {
  it("reads global and project Pi subagent definitions with project overrides", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-pi-agents-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo");

    writeAgent(
      path.join(agentDir, "agents"),
      "scout.md",
      [
        "name: scout",
        "description: Global scout",
        "model: openai/gpt-5.5",
        "thinking: low",
      ].join("\n"),
    );
    writeAgent(
      path.join(cwd, ".pi", "agents"),
      "scout.md",
      ["name: scout", "description: Project scout", "enabled: true"].join("\n"),
    );
    writeAgent(
      path.join(cwd, ".pi", "agents"),
      "disabled.md",
      ["name: disabled", "description: Hidden", "enabled: false"].join("\n"),
    );

    expect(listPiSubagentDefinitions({ agentDir, cwd })).toEqual([
      {
        name: "scout",
        displayName: "Scout",
        description: "Project scout",
        scope: "project",
      },
    ]);
  });

  it("discovers project agents from the nearest ancestor .pi directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-pi-agents-"));
    const agentDir = path.join(root, "agent");
    const cwd = path.join(root, "repo", "packages", "app");

    writeAgent(
      path.join(root, "repo", ".pi", "agents"),
      "scout.md",
      ["name: scout", "description: Ancestor project scout"].join("\n"),
    );
    mkdirSync(cwd, { recursive: true });

    expect(listPiSubagentDefinitions({ agentDir, cwd })).toEqual([
      {
        name: "scout",
        displayName: "Scout",
        description: "Ancestor project scout",
        scope: "project",
      },
    ]);
  });

  it("skips unreadable Pi agent definition files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-pi-agents-"));
    const agentDir = path.join(root, "agent");
    const agentsDir = path.join(agentDir, "agents");
    const cwd = path.join(root, "repo");
    mkdirSync(agentsDir, { recursive: true });
    symlinkSync(path.join(root, "missing.md"), path.join(agentsDir, "broken.md"));
    writeAgent(agentsDir, "scout.md", ["name: scout", "description: Valid scout"].join("\n"));

    expect(listPiSubagentDefinitions({ agentDir, cwd })).toEqual([
      {
        name: "scout",
        displayName: "Scout",
        description: "Valid scout",
        scope: "global",
      },
    ]);
  });
});
