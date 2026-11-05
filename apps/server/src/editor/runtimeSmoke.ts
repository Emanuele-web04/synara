// Exercises the real compiler worker and standard libraries inside the packaged app.
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EditorLanguageService } from "./languageService";

export async function verifyEditorLanguageRuntime(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "synara-editor-runtime-smoke-"));
  const service = new EditorLanguageService();
  try {
    // The valid chain needs Array, Number and String declarations. The final,
    // deliberate error also proves the worker evaluated the supplied document.
    const contents =
      'export const rounded: string = [1, 2].map(value => value.toFixed(1)).join(",");\nrounded.synaraMissingMember();\n';
    await writeFile(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", lib: ["ES2022"] } }),
    );
    await writeFile(join(root, "smoke.ts"), contents);
    const result = await service.request("packaged-runtime-smoke", {
      cwd: root,
      relativePath: "smoke.ts",
      documents: [{ relativePath: "smoke.ts", contents, version: 1 }],
      operation: "diagnostics",
      offset: 0,
      length: 0,
    });
    const errors = result.diagnostics?.filter((item) => item.severity === "error");
    assert.deepEqual(
      errors?.map(({ code, start }) => [code, start]),
      [[2339, contents.lastIndexOf("synaraMissingMember")]],
      "Packaged editor worker must report the deliberate type error with standard libraries loaded.",
    );
  } finally {
    service.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
