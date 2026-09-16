import type { ProjectId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { readNativeApi } from "~/nativeApi";
import { useProjectInstructionsStore } from "~/projectInstructionsStore";

export function useProjectInstructionsSource(projectId: ProjectId | null) {
  const localInstructions = useProjectInstructionsStore((state) =>
    projectId ? (state.instructionsByProjectId[projectId] ?? "") : "",
  );
  const setLocalInstructions = useProjectInstructionsStore((state) => state.setInstructions);
  const [serverInstructions, setServerInstructions] = useState<string | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [serverBacked, setServerBacked] = useState(false);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    if (!projectId) {
      setServerInstructions(null);
      setServerBacked(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const api = readNativeApi();
      if (!api?.projectAgent) return;
      try {
        const overview = await api.projectAgent.getOverview({ projectId });
        if (cancelled || projectIdRef.current !== projectId) return;
        if (!overview.configured) {
          setServerBacked(false);
          setServerInstructions(null);
          return;
        }
        const read = await api.projectAgent.readDocument({
          projectId,
          logicalPath: "instructions.md",
        });
        if (cancelled || projectIdRef.current !== projectId) return;
        setServerBacked(true);
        setServerInstructions(read.document.content);
        setRevision(read.document.revision);
        setConflict(
          read.head.conflictPending
            ? "Project instructions changed on disk. Save again to import the external copy."
            : null,
        );
      } catch {
        if (cancelled || projectIdRef.current !== projectId) return;
        setServerBacked(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const onChange = useCallback(
    (nextProjectId: ProjectId, instructions: string) => {
      const api = readNativeApi();
      if (serverBacked && api?.projectAgent && revision !== null) {
        void api.projectAgent
          .writeDocument({
            requestId: crypto.randomUUID(),
            projectId: nextProjectId,
            logicalPath: "instructions.md",
            content: instructions,
            expectedRevision: revision,
          })
          .then((saved) => {
            if (projectIdRef.current !== nextProjectId) return;
            setServerInstructions(saved.content);
            setRevision(saved.revision);
            setConflict(null);
          })
          .catch((cause: unknown) => {
            if (projectIdRef.current !== nextProjectId) return;
            setConflict(cause instanceof Error ? cause.message : "Failed to save project instructions.");
          });
        return;
      }
      setLocalInstructions(nextProjectId, instructions);
    },
    [revision, serverBacked, setLocalInstructions],
  );

  return {
    instructions: serverBacked ? (serverInstructions ?? localInstructions) : localInstructions,
    onChange,
    conflict,
    serverBacked,
  };
}
