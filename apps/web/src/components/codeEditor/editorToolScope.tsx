import { createContext, useState, type ReactNode } from "react";

export type EditorTool = "outline" | "problems" | "debug" | "extensions" | "commands";
export interface EditorToolTarget {
  filePath: string;
  available: readonly EditorTool[];
  selected: EditorTool | null;
  problemCount: number;
  debugging: boolean;
  open: (tool: EditorTool, manageExtensions?: () => void) => void;
}

/** Presentation-only command ownership, local to one editor shell, never global focus. */
export class EditorToolScope {
  private readonly targets = new Map<object, EditorToolTarget>();
  private readonly listeners = new Set<() => void>();
  private owner: object | null = null;
  private snapshot: EditorToolTarget | null = null;
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish() {
    const next = this.owner ? (this.targets.get(this.owner) ?? null) : null;
    if (next === this.snapshot) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  attach(owner: object, target: EditorToolTarget): () => void {
    this.targets.set(owner, target);
    this.owner ??= owner;
    this.publish();
    return () => {
      this.targets.delete(owner);
      if (this.owner === owner) this.owner = [...this.targets.keys()].at(-1) ?? null;
      this.publish();
    };
  }
  update(owner: object, patch: Partial<EditorToolTarget>) {
    const target = this.targets.get(owner);
    if (!target) return;
    this.targets.set(owner, { ...target, ...patch });
    this.publish();
  }
  focus(owner: object) {
    if (!this.targets.has(owner)) return;
    this.owner = owner;
    this.publish();
  }
}
export const EditorToolScopeContext = createContext<EditorToolScope | null>(null);
export function EditorToolScopeProvider({ children }: { children: ReactNode }) {
  const [scope] = useState(() => new EditorToolScope());
  return (
    <EditorToolScopeContext.Provider value={scope}>{children}</EditorToolScopeContext.Provider>
  );
}
