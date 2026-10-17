import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface DraftGuard {
  mark: (id: string, dirty: boolean) => void;
  mayLeave: () => boolean;
  error: string | null;
}

const Context = createContext<DraftGuard | null>(null);

/** Protect local drafts on navigation without putting document content in browser storage. */
export function NotionDraftBoundary({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const mark = useCallback((id: string, value: boolean) => {
    if (value) dirty.current.add(id);
    else dirty.current.delete(id);
    if (!dirty.current.size) setError(null);
  }, []);
  const mayLeave = useCallback(() => {
    if (!dirty.current.size) {
      setError(null);
      return true;
    }
    setError(
      "Save or cancel your unsaved edits before navigating, hiding content, or closing this window.",
    );
    return false;
  }, []);
  useEffect(() => {
    const handleUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => window.removeEventListener("beforeunload", handleUnload);
  }, []);
  const value = useMemo(() => ({ mark, mayLeave, error }), [mark, mayLeave, error]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useNotionDraft(dirty: boolean) {
  const id = useId();
  const mark = useContext(Context)?.mark;
  useEffect(() => {
    mark?.(id, dirty);
    return () => mark?.(id, false);
  }, [id, mark, dirty]);
}

export function useNotionDraftGuard() {
  return useContext(Context);
}
