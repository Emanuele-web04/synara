import { EditProvider, type CreateEditor } from "@pierre/diffs/react";
import { useEffect, useState, type ReactNode } from "react";

import { loadPierreEdit } from "./pierreEdit";

export function CodeEditBoundary(props: { fallback: ReactNode; children: ReactNode }) {
  const [createEditor, setCreateEditor] = useState<CreateEditor<undefined> | null>(null);

  useEffect(() => {
    let active = true;
    void loadPierreEdit().then((module) => {
      if (active) {
        setCreateEditor(() => (options: Parameters<CreateEditor<undefined>>[0]) => {
          return new module.Editor(options);
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (!createEditor) {
    return props.fallback;
  }
  return <EditProvider createEditor={createEditor}>{props.children}</EditProvider>;
}
