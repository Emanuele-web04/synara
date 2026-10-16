import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExtensionRuntime } from "./extensionRuntime";

const runtimeFile = process.env.SYNARA_TEST_CODE_OSS_HOST;
const enabled = Boolean(runtimeFile) && process.env.SYNARA_TEST_EXTENSION_SANDBOX === "1";

describe.skipIf(!enabled)("real markdownlint extension", () => {
  it("diagnoses an actual Markdown violation and refreshes diagnostics from an unsaved native snapshot", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-linter-extension-"));
    const cwd = path.join(temporary, "workspace"),
      stateDir = path.join(temporary, "state");
    await mkdir(cwd);
    await mkdir(stateDir);
    const contents = "#Heading\n\nText.\n";
    await writeFile(path.join(cwd, "fixture.md"), contents);
    const runtime = new ExtensionRuntime(stateDir, runtimeFile);
    const owner = "linter-extension-fixture";
    let hostId: string | undefined;
    try {
      const installed = await runtime.request(owner, {
        operation: "install",
        id: "DavidAnson.vscode-markdownlint",
      });
      await runtime.request(owner, {
        operation: "setEnabled",
        id: "DavidAnson.vscode-markdownlint",
        enabled: true,
        consent: installed.extensions.map(({ id, digest }) => ({ id, digest })),
      });
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: true });
      hostId = (
        await runtime.runtimeRequest(owner, {
          operation: "start",
          cwd,
          documents: [{ relativePath: "fixture.md", contents, version: 1 }],
        })
      ).hostId;
      await expect
        .poll(
          async () => {
            const state = await runtime.runtimeRequest(owner, {
              operation: "poll",
              cwd,
              hostId: hostId!,
            });
            if (state.status === "failed") throw new Error(JSON.stringify(state.events));
            return state.status;
          },
          { timeout: 30_000, interval: 100 },
        )
        .toBe("running");
      await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "activate",
        paramsJson: JSON.stringify({ id: "davidanson.vscode-markdownlint" }),
      });
      const diagnostics = async () => {
        const result = await runtime.runtimeRequest(owner, {
          operation: "request",
          cwd,
          hostId: hostId!,
          method: "state",
        });
        const state: { diagnostics: unknown } = JSON.parse(result.resultJson!);
        return JSON.stringify(state.diagnostics);
      };
      await expect.poll(diagnostics, { timeout: 20_000, interval: 100 }).toContain("MD018");
      await runtime.runtimeRequest(owner, {
        operation: "sync",
        cwd,
        hostId,
        documents: [{ relativePath: "fixture.md", contents: "# Heading\n\nText.\n", version: 2 }],
      });
      await expect.poll(diagnostics, { timeout: 20_000, interval: 100 }).not.toContain("MD018");
      expect(await readFile(path.join(cwd, "fixture.md"), "utf8")).toBe(contents);
      await runtime.runtimeRequest(owner, { operation: "stop", cwd, hostId });
      console.log(
        "REAL_MARKDOWN_LINTER",
        JSON.stringify({
          extensions: installed.extensions.map(({ id, version, digest }) => ({
            id,
            version,
            digest,
          })),
          actualViolation: "MD018",
          dirtyDocumentDiagnostics: true,
          sandboxed: true,
          unchangedDisk: true,
          cleanup: true,
        }),
      );
    } catch (error) {
      if (hostId)
        console.error(
          "LINTER_EXTENSION_EVENTS",
          JSON.stringify(
            (
              await runtime
                .runtimeRequest(owner, { operation: "poll", cwd, hostId })
                .catch(() => undefined)
            )?.events.slice(-16),
          ).slice(-16_000),
        );
      throw error;
    } finally {
      await runtime.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
