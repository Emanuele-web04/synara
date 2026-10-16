import { URI } from "@code-oss/vs/base/common/uri.js";

/** Capture the exact native buffers at provider invocation, not after it resolves. */
export function snapshotWorkspaceEdit(value, snapshots) {
  if (value == null) return null;
  if (!Array.isArray(value.edits) || value.edits.length > 1_000)
    throw new Error("Invalid extension workspace edit.");
  return {
    edits: value.edits.map((edit) => {
      // Resource create/delete/rename edits need a separate native file-operation
      // transaction. Do not silently convert them into ordinary text writes.
      if (!edit.resource || !edit.textEdit || edit.oldResource || edit.newResource)
        throw new Error("Only versioned text workspace edits are supported.");
      const resource = URI.revive(edit.resource);
      const snapshot = snapshots.get(resource.toString());
      if (!snapshot || (edit.versionId !== undefined && edit.versionId !== snapshot.version))
        throw new Error(
          "Open and synchronize every workspace edit target before applying the action.",
        );
      return {
        resource,
        textEdit: edit.textEdit,
        expectedContents: snapshot.contents,
        versionId: snapshot.version,
      };
    }),
  };
}
