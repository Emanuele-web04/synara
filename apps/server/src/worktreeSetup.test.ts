import type { ProjectScript } from "@synara/contracts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./processRunner.ts", () => ({
  runProcess: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  })),
}));

import { runProcess } from "./processRunner.ts";
import { findWorktreeSetupScript, runWorktreeSetupScript } from "./worktreeSetup.ts";

const scripts: ProjectScript[] = [
  {
    id: "test",
    name: "Test",
    command: "bun run test",
    icon: "test",
    runOnWorktreeCreate: false,
  },
  {
    id: "setup",
    name: "Setup",
    command: "bun install",
    icon: "configure",
    runOnWorktreeCreate: true,
  },
];

describe("worktree setup", () => {
  let codexHome: string;
  beforeEach(() => {
    vi.mocked(runProcess).mockClear();
    codexHome = mkdtempSync(path.join(os.tmpdir(), "synara-setup-codex-"));
    vi.stubEnv("CODEX_HOME", codexHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(codexHome, { recursive: true, force: true });
  });

  it("selects and runs the configured setup script in the new worktree", async () => {
    expect(findWorktreeSetupScript(scripts)?.id).toBe("setup");

    await runWorktreeSetupScript(scripts, "/tmp/new-worktree");

    expect(runProcess).toHaveBeenCalledOnce();
    const [shell, args, options] = vi.mocked(runProcess).mock.calls[0]!;
    expect(shell.length).toBeGreaterThan(0);
    expect(args).toContain("bun install");
    expect(options).toMatchObject({ cwd: "/tmp/new-worktree" });
  });

  it("does not expose provider or Synara credentials to repository setup code", async () => {
    vi.stubEnv("OPENAI_API_KEY", "provider-secret");
    vi.stubEnv("SYNARA_AUTH_TOKEN", "control-plane-secret");

    try {
      await runWorktreeSetupScript(scripts, "/tmp/new-worktree");

      const [, , options] = vi.mocked(runProcess).mock.calls[0]!;
      expect(options?.env?.OPENAI_API_KEY).toBeUndefined();
      expect(options?.env?.SYNARA_AUTH_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("forwards the abort signal so interruption can kill the setup process", async () => {
    const controller = new AbortController();

    await runWorktreeSetupScript(scripts, "/tmp/new-worktree", controller.signal);

    const [, , options] = vi.mocked(runProcess).mock.calls[0]!;
    expect(options?.signal).toBe(controller.signal);
  });

  it("withholds arbitrary active and inactive Codex credentials before provider startup", async () => {
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "work"',
        "[model_providers.work]",
        'env_key = "ACME_SETUP_CREDENTIAL"',
        "[model_providers.other]",
        'env_key = "ACME_UNSELECTED_LICENSE"',
      ].join("\n"),
    );
    vi.stubEnv("ACME_SETUP_CREDENTIAL", "synthetic-active-secret");
    vi.stubEnv("ACME_UNSELECTED_LICENSE", "synthetic-inactive-secret");
    vi.stubEnv("PROJECT_SETUP_COLOR", "blue");

    await runWorktreeSetupScript(scripts, "/tmp/new-worktree");

    const [, , options] = vi.mocked(runProcess).mock.calls[0]!;
    expect(options?.env?.ACME_SETUP_CREDENTIAL).toBeUndefined();
    expect(options?.env?.ACME_UNSELECTED_LICENSE).toBeUndefined();
    expect(options?.env?.PROJECT_SETUP_COLOR).toBe("blue");
    expect(process.env.ACME_SETUP_CREDENTIAL).toBe("synthetic-active-secret");
  });

  it("does nothing when no setup script is configured", async () => {
    await runWorktreeSetupScript(
      scripts.filter((script) => !script.runOnWorktreeCreate),
      "/tmp",
    );
    expect(runProcess).not.toHaveBeenCalled();
  });

  it("does not launch setup when configured credentials cannot be classified safely", async () => {
    writeFileSync(
      path.join(codexHome, "config.toml"),
      '[model_providers.invalid\nenv_key = "SECRET"',
    );

    await expect(runWorktreeSetupScript(scripts, "/tmp/new-worktree")).rejects.toThrow(
      "Codex config.toml must be valid TOML so Synara can verify managed account state safely.",
    );
    expect(runProcess).not.toHaveBeenCalled();
  });
});
