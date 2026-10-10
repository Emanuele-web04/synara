import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { Effect } from "effect";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { normalizeProjectDocumentPath } from "@synara/shared/projectAgent";

export function projectContextRoot(stateDir: string, projectId: string): string {
  return path.join(stateDir, "project-context", projectId);
}

export function hashDocumentContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function materializeDocumentPath(
  stateDir: string,
  projectId: string,
  logicalPath: string,
): string {
  const normalized = normalizeProjectDocumentPath(logicalPath);
  const root = projectContextRoot(stateDir, projectId);
  const resolved = path.resolve(root, normalized);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Materialized path escaped project context: ${logicalPath}`);
  }
  return resolved;
}

export function writeProjectDocumentMirror(input: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly logicalPath: string;
  readonly content: string;
}) {
  const filePath = materializeDocumentPath(input.stateDir, input.projectId, input.logicalPath);
  return writeFileStringAtomically({ filePath, contents: input.content });
}

export function readProjectDocumentMirror(input: {
  readonly stateDir: string;
  readonly projectId: string;
  readonly logicalPath: string;
}) {
  const filePath = materializeDocumentPath(input.stateDir, input.projectId, input.logicalPath);
  return Effect.tryPromise({
    try: async () => {
      try {
        const handle = await fs.open(filePath, "r");
        try {
          const stat = await handle.stat();
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Project context path is not a regular file: ${filePath}`);
          }
          return await handle.readFile("utf8");
        } finally {
          await handle.close();
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw cause;
      }
    },
    catch: (cause) => cause,
  });
}
