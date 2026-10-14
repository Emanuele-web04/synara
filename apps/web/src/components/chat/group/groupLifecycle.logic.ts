import type { ToastCopyItem } from "~/components/ui/toast.logic";

export type GroupDeletedNotice = {
  readonly description: string;
  readonly copyItems: ReadonlyArray<ToastCopyItem>;
};

// After a group is deleted the Library and the managed group folder may each
// be left on disk; report them in one notice so each path gets its own copy
// action.
export function buildGroupDeletedNotice(result: {
  readonly libraryLeftOnDiskPath: string | null;
  readonly workspaceLeftOnDiskPath: string | null;
}): GroupDeletedNotice | null {
  const keptParts: string[] = [];
  const copyItems: ToastCopyItem[] = [];

  if (result.libraryLeftOnDiskPath) {
    keptParts.push(`The library folder was left on disk at ${result.libraryLeftOnDiskPath}.`);
    copyItems.push({ label: "library path", text: result.libraryLeftOnDiskPath });
  }
  if (result.workspaceLeftOnDiskPath) {
    keptParts.push(
      `The hub folder has your files, so it was left on disk at ${result.workspaceLeftOnDiskPath}.`,
    );
    copyItems.push({ label: "hub folder path", text: result.workspaceLeftOnDiskPath });
  }

  if (copyItems.length === 0) return null;
  return { description: keptParts.join(" "), copyItems };
}
