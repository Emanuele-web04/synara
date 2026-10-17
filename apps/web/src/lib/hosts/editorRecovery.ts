import { controlAccountScope } from "./controlQueryScope";
import { readExecutionContext } from "./executionContext";

/** Local export only. Account B cannot enumerate A's remote editor recoveries. */
export function readRecoverableEditorDrafts(): unknown[] {
  const context = readExecutionContext();
  if (!context) return [];
  const binding = context.remote
    ? JSON.stringify([
        context.remote.accountAuthority,
        context.remote.userId,
        context.remote.organizationId,
      ])
    : controlAccountScope();
  const records: unknown[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    const match = key && /^synara:execution:([^:]+):editor-recovery:/.exec(key);
    if (!match || !key) continue;
    try {
      const namespace: unknown = JSON.parse(decodeURIComponent(match[1]!));
      if (!Array.isArray(namespace)) continue;
      const local = namespace[0] === "local" && namespace[1] === context.controller.environmentId;
      const remote = namespace[0] === "remote" && JSON.stringify(namespace.slice(1, 4)) === binding;
      if (!local && !remote) continue;
      const raw = localStorage.getItem(key);
      if (raw) records.push({ key, environmentId: namespace.at(-1), drafts: JSON.parse(raw) });
    } catch {
      /* Preserve malformed records; do not erase them during export. */
    }
  }
  return records;
}
