import { toastManager } from "~/components/ui/toast";
import type { EditorActionRow } from "./EditorActionPicker";

export interface ExtensionProgress {
  handle: number;
  title: string;
  message: string;
  value: number | null;
  cancellable: boolean;
}
export interface ExtensionStatus {
  id: string;
  label: string;
  detail: string;
  actionable: boolean;
}
export interface ExtensionContributionsSnapshot {
  progress: readonly ExtensionProgress[];
  status: readonly ExtensionStatus[];
}
export const EMPTY_EXTENSION_CONTRIBUTIONS: ExtensionContributionsSnapshot = {
  progress: [],
  status: [],
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid extension contribution.");
  return value as Record<string, unknown>;
}
function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, 4_096) : fallback;
}
function handle(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0)
    throw new Error("Invalid extension contribution handle.");
  return value;
}
function items(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 1_000)
    throw new Error("Invalid extension list contribution.");
  return value.map(object);
}

/** Bounded ephemeral contributions; uses existing picker and notification primitives. */
export class ExtensionContributions {
  private readonly progress = new Map<number, ExtensionProgress>();
  private readonly status = new Map<string, ExtensionStatus>();
  private notices = 0;
  private noticeWindow = Date.now();
  constructor(
    private readonly invoke: (
      method: "tree" | "ui",
      params: Record<string, unknown>,
    ) => Promise<unknown>,
    private readonly changed: (snapshot: ExtensionContributionsSnapshot) => void,
  ) {}
  private publish() {
    this.changed({ progress: [...this.progress.values()], status: [...this.status.values()] });
  }
  clear() {
    this.progress.clear();
    this.status.clear();
    this.publish();
  }
  consume(event: string, body: unknown): boolean {
    if (
      ![
        "progress.start",
        "progress.report",
        "progress.end",
        "nativeStatus.set",
        "nativeStatus.remove",
      ].includes(event)
    )
      return false;
    const data = object(body);
    if (event === "progress.start") {
      const id = handle(data.handle),
        options = object(data.options);
      if (this.progress.size >= 16 && !this.progress.has(id))
        throw new Error("Extension progress limit reached.");
      this.progress.set(id, {
        handle: id,
        title: text(options.title, "Extension task"),
        message: "",
        value: null,
        cancellable: options.cancellable === true,
      });
    } else if (event === "progress.report") {
      const id = handle(data.handle),
        existing = this.progress.get(id),
        step = object(data.step);
      if (existing)
        this.progress.set(id, {
          ...existing,
          message: text(step.message, existing.message),
          value:
            typeof step.increment === "number" && Number.isFinite(step.increment)
              ? Math.max(0, Math.min(100, (existing.value ?? 0) + step.increment))
              : existing.value,
        });
    } else if (event === "progress.end") this.progress.delete(handle(data.handle));
    else if (event === "nativeStatus.set") {
      const id = text(data.id);
      if (!id || (this.status.size >= 32 && !this.status.has(id)))
        throw new Error("Extension status limit reached.");
      this.status.set(id, {
        id,
        label: text(data.label),
        detail: text(data.detail),
        actionable: data.actionable === true,
      });
    } else this.status.delete(text(data.id));
    this.publish();
    return true;
  }
  notify(params: Record<string, unknown>): void {
    if (Date.now() - this.noticeWindow > 60_000) {
      this.noticeWindow = Date.now();
      this.notices = 0;
    }
    if (++this.notices > 20) throw new Error("Extension notification limit reached.");
    toastManager.add({
      title: "Editor extension",
      description: text(params.message),
      type: params.severity === 3 ? "error" : params.severity === 2 ? "warning" : "info",
      data: { allowCrossThreadVisibility: true },
    });
  }
  async cancel(handle: number) {
    await this.invoke("ui", { operation: "cancelProgress", handle });
  }
  async chooseStatus(id: string) {
    await this.invoke("ui", { operation: "statusCommand", id });
  }
  async views(show: (title: string, rows: EditorActionRow[]) => void): Promise<void> {
    const views = items(await this.invoke("tree", { operation: "list" }));
    show(
      "Extension views",
      views.map((view) => ({
        id: text(view.id),
        label: text(view.name),
        run: () => this.tree(text(view.id), text(view.name), [], show),
      })),
    );
  }
  private async tree(
    id: string,
    title: string,
    parents: string[],
    show: (title: string, rows: EditorActionRow[]) => void,
  ): Promise<void> {
    if (parents.length > 32) throw new Error("Extension tree exceeds the navigation depth limit.");
    const children = items(
      await this.invoke("tree", {
        operation: "children",
        id,
        ...(parents.length ? { parent: parents.at(-1) } : {}),
      }),
    );
    const rows: EditorActionRow[] = [
      {
        id: "synara:tree:back",
        label: parents.length ? "Back to parent" : "Back to extension views",
        run: async () => {
          if (parents.length) await this.tree(id, title, parents.slice(0, -1), show);
          else {
            await this.invoke("tree", { operation: "close", id });
            await this.views(show);
          }
        },
      },
    ];
    rows.push(
      ...children.map((item) => ({
        id: `item:${text(item.handle)}`,
        label: text(item.label),
        detail: item.children ? "Open children" : text(item.description),
        run: async () => {
          if (item.children) await this.tree(id, title, [...parents, text(item.handle)], show);
          else await this.invoke("tree", { operation: "choose", id, handle: text(item.handle) });
        },
      })),
    );
    show(title, rows);
  }
}
