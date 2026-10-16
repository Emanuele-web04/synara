import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ExtensionRuntime } from "./extensionRuntime";

const runtimeFile = process.env.SYNARA_TEST_CODE_OSS_HOST;
const enabled = Boolean(runtimeFile) && process.env.SYNARA_TEST_EXTENSION_SANDBOX === "1";
const hostState = z.object({
  providers: z.array(z.object({ handle: z.number(), kind: z.string() })),
  active: z.array(z.string()),
  diagnostics: z.array(z.unknown()),
});

/** A real Open VSX language-server extension, using only a local fixture schema. */
describe.skipIf(!enabled)("real YAML language-server extension", () => {
  it("runs schema diagnostics and completions in the production sandbox", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "synara-yaml-extension-"));
    const cwd = path.join(temporary, "workspace"),
      stateDir = path.join(temporary, "state");
    await mkdir(cwd);
    await mkdir(stateDir);
    const contents = "answer: wrong\n";
    await writeFile(path.join(cwd, "fixture.yaml"), contents);
    const schemaFile = path.join(cwd, "schema.json");
    await writeFile(
      schemaFile,
      JSON.stringify({
        type: "object",
        properties: { answer: { type: "number", description: "The numeric answer." } },
        required: ["answer"],
        additionalProperties: false,
      }),
    );
    const runtime = new ExtensionRuntime(stateDir, runtimeFile);
    const owner = "yaml-extension-fixture";
    let hostId: string | undefined;
    try {
      const installed = await runtime.request(owner, {
        operation: "install",
        id: "redhat.vscode-yaml",
      });
      await runtime.request(owner, {
        operation: "configure",
        id: "redhat.vscode-yaml",
        configurationJson: JSON.stringify({
          "redhat.telemetry.enabled": false,
          "telemetry.telemetryLevel": "off",
          "yaml.schemaStore.enable": false,
          "yaml.kubernetesCRDStore.enable": false,
          "yaml.extension.recommendations": false,
          "yaml.schemas": { [pathToFileURL(schemaFile).toString()]: ["fixture.yaml"] },
        }),
      });
      await runtime.request(owner, {
        operation: "setEnabled",
        id: "redhat.vscode-yaml",
        enabled: true,
        consent: installed.extensions.map((entry) => ({ id: entry.id, digest: entry.digest })),
      });
      await runtime.request(owner, { operation: "setTrust", cwd, trusted: true });
      hostId = (
        await runtime.runtimeRequest(owner, {
          operation: "start",
          cwd,
          documents: [{ relativePath: "fixture.yaml", contents, version: 1 }],
        })
      ).hostId;
      const deadline = Date.now() + 30_000;
      while (true) {
        const state = await runtime.runtimeRequest(owner, { operation: "poll", cwd, hostId });
        if (state.status === "failed")
          throw new Error(
            JSON.stringify(
              state.events.filter((entry) =>
                ["error", "activationError", "extensionError", "stderr"].includes(entry.event),
              ),
            ).slice(-12_000),
          );
        if (state.status === "running") break;
        if (Date.now() > deadline) throw new Error("The YAML host did not become ready.");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "activate",
        paramsJson: JSON.stringify({ id: "redhat.vscode-yaml" }),
      });
      const state = async () =>
        hostState.parse(
          JSON.parse(
            (
              await runtime.runtimeRequest(owner, {
                operation: "request",
                cwd,
                hostId: hostId!,
                method: "state",
              })
            ).resultJson!,
          ),
        );
      await expect
        .poll(async () => JSON.stringify((await state()).diagnostics), {
          timeout: 20_000,
          interval: 100,
        })
        .toContain("number");
      const active = await state();
      expect(active.active).toContain("redhat.vscode-yaml");
      expect(JSON.stringify(active.diagnostics)).toContain("fixture.yaml");
      await runtime.runtimeRequest(owner, {
        operation: "sync",
        cwd,
        hostId,
        documents: [{ relativePath: "fixture.yaml", contents: "ans", version: 2 }],
      });
      const provider = (await state()).providers.find((entry) => entry.kind === "completion");
      expect(provider).toBeDefined();
      const completed = await runtime.runtimeRequest(owner, {
        operation: "request",
        cwd,
        hostId,
        method: "language",
        paramsJson: JSON.stringify({
          handle: provider!.handle,
          relativePath: "fixture.yaml",
          position: { lineNumber: 1, column: 4 },
          context: { triggerKind: 0 },
        }),
      });
      const suggestions = z
        .object({
          suggestions: z.array(
            z.object({ label: z.union([z.string(), z.object({ label: z.string() })]) }),
          ),
        })
        .parse(JSON.parse(completed.resultJson!));
      expect(
        suggestions.suggestions.some((item) =>
          (typeof item.label === "string" ? item.label : item.label.label).includes("answer"),
        ),
      ).toBe(true);
      expect(await readFile(path.join(cwd, "fixture.yaml"), "utf8")).toBe(contents);
      await runtime.runtimeRequest(owner, { operation: "stop", cwd, hostId });
      console.log(
        "REAL_YAML_LANGUAGE_SERVER",
        JSON.stringify({
          extensions: installed.extensions.map(({ id, version, digest }) => ({
            id,
            version,
            digest,
          })),
          sandboxed: true,
          schemaDiagnostics: true,
          schemaCompletion: true,
          unchangedDisk: true,
          cleanup: true,
        }),
      );
    } catch (error) {
      if (hostId) {
        const state = await runtime
          .runtimeRequest(owner, { operation: "poll", cwd, hostId })
          .catch(() => undefined);
        console.error("YAML_HOST_EVENTS", JSON.stringify(state?.events.slice(-12)).slice(-16_000));
      }
      throw error;
    } finally {
      await runtime.dispose();
      await rm(temporary, { recursive: true, force: true });
    }
  }, 120_000);
});
