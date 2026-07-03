// FILE: browserStyleSourceEdit.ts
// Purpose: Plan/apply/revert helpers for live-editor "Apply to source" style edits.
// Layer: Browser editor source bridge

import type { NativeApi } from "@t3tools/contracts";

/** Planned source change returned by a preview-mode style edit. */
export interface BrowserStyleEditSourcePlan {
  relativePath: string;
  /** 1-based line of the matched opening tag. */
  line: number;
  /** Opening tag before the edit. */
  before: string;
  /** Opening tag after the edit. */
  after: string;
}

export interface AppliedBrowserStyleEdit extends BrowserStyleEditSourcePlan {
  cwd: string;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    if (count > 1) {
      return count;
    }
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Reverts a previously applied style edit by restoring the original opening
 * tag. Verifies the edited tag still exists exactly once so a stale undo can
 * never clobber unrelated changes. Throws with a user-readable message.
 */
export async function revertBrowserStyleEdit(
  projects: Pick<NativeApi["projects"], "readFile" | "writeFile">,
  edit: AppliedBrowserStyleEdit,
): Promise<void> {
  const file = await projects.readFile({ cwd: edit.cwd, relativePath: edit.relativePath });
  if (file.truncated) {
    throw new Error(`${edit.relativePath} is too large to revert automatically.`);
  }
  if (countOccurrences(file.contents, edit.after) !== 1) {
    throw new Error(
      `${edit.relativePath} changed after the edit, so it was not reverted. Undo it in your editor instead.`,
    );
  }
  const index = file.contents.indexOf(edit.after);
  // Splice by index: String.replace would reinterpret "$"-patterns in the tag.
  const contents = `${file.contents.slice(0, index)}${edit.before}${file.contents.slice(index + edit.after.length)}`;
  await projects.writeFile({ cwd: edit.cwd, relativePath: edit.relativePath, contents });
}
