import { URI } from "@code-oss/vs/base/common/uri.js";

const text = (value) => {
  if (typeof value !== "string" || value.length > 16_384)
    throw new Error("Invalid native extension contribution text.");
  return value;
};

/** Native trees use the upstream data provider; presentation stays in Synara's
 * existing list picker. No extension HTML, icons or remote image URLs are loaded. */
export class NativeExtensionContributions {
  constructor(actor, initialization, emit) {
    this.actor = actor;
    this.initialization = initialization;
    this.emit = emit;
    this.trees = new Map();
    this.items = new Map();
    this.status = new Map();
    this.contentProviders = new Map();
    this.visibleTree = undefined;
  }
  catalog() {
    return this.initialization()
      .extensions.flatMap(({ manifest }) =>
        Object.values(manifest.contributes?.views ?? {}).flatMap((views) =>
          (Array.isArray(views) ? views : [])
            .filter((view) => view.type !== "webview" && typeof view.id === "string")
            .map((view) => ({
              id: view.id,
              name: typeof view.name === "string" ? view.name : view.id,
            })),
        ),
      )
      .slice(0, 64);
  }
  mainThreadTrees() {
    return {
      $registerTreeViewDataProvider: (id, options) => {
        if (this.trees.size >= 64 && !this.trees.has(id))
          throw new Error("Native extension tree limit reached.");
        this.trees.set(text(id), options);
        this.emit("tree.register", { id, options });
      },
      $disposeTree: (id) => {
        this.trees.delete(id);
        this.items.delete(id);
        this.emit("tree.remove", { id });
      },
      $refresh: (id) => {
        this.items.delete(id);
        this.emit("tree.refresh", { id });
      },
      $setMessage: (id, message) =>
        this.emit("tree.message", { id, message: typeof message === "string" ? message : "" }),
      $setTitle: (id, title, description) => this.emit("tree.title", { id, title, description }),
      $setBadge: (id, badge) => this.emit("tree.badge", { id, badge }),
      $reveal() {
        throw new Error("Open extension trees through Synara's native command picker.");
      },
    };
  }
  mainThreadStatus() {
    return {
      $setEntry: (entryId, _id, _extension, name, label, tooltip, _hasTooltipProvider, command) => {
        if (this.status.size >= 32 && !this.status.has(entryId))
          throw new Error("Extension status contribution limit reached.");
        this.status.set(text(entryId), command);
        this.emit("nativeStatus.set", {
          id: entryId,
          label: text(label)
            .replace(/\$\([^)]*\)/g, "")
            .trim()
            .slice(0, 256),
          detail:
            typeof tooltip === "string"
              ? tooltip.slice(0, 1_024)
              : typeof name === "string"
                ? name
                : "",
          actionable: Boolean(command?.id),
        });
      },
      $disposeEntry: (id) => {
        this.status.delete(id);
        this.emit("nativeStatus.remove", { id });
      },
    };
  }
  mainThreadContent() {
    return {
      // Registration is independent of rendering a virtual document. Keep the
      // contribution discoverable, but do not claim a memory/webview editor.
      $registerTextContentProvider: (handle, scheme) => {
        if (
          this.contentProviders.size >= 64 ||
          !/^[a-z][a-z0-9+.-]{0,127}$/i.test(scheme) ||
          ["file", "http", "https", "data"].includes(scheme)
        )
          throw new Error("Unsupported virtual document scheme.");
        this.contentProviders.set(handle, scheme);
        this.emit("capability.virtualDocument", { handle, scheme, nativePreview: false });
      },
      $unregisterTextContentProvider: (handle) => {
        this.contentProviders.delete(handle);
      },
      $onVirtualDocumentChange: (resource) => {
        const uri = URI.revive(resource);
        if (![...this.contentProviders.values()].includes(uri.scheme))
          throw new Error("Unknown virtual document provider.");
      },
    };
  }
  async tree(params) {
    if (params.operation === "list") return this.catalog();
    const id = text(params.id);
    if (!this.catalog().some((view) => view.id === id))
      throw new Error("The extension tree is not contributed by an enabled extension.");
    await this.actor("ExtHostExtensionService").$activateByEvent(`onView:${id}`, 0);
    if (!this.trees.has(id))
      throw new Error("The extension did not register its tree data provider.");
    const target = this.actor("ExtHostTreeViews");
    if (params.operation === "close") {
      await target.$setVisible(id, false);
      if (this.visibleTree === id) this.visibleTree = undefined;
      return true;
    }
    if (this.visibleTree && this.visibleTree !== id)
      await target.$setVisible(this.visibleTree, false);
    this.visibleTree = id;
    await target.$setVisible(id, true);
    if (params.operation === "children") {
      const parent = params.parent === undefined ? undefined : text(params.parent);
      const cache = this.items.get(id) ?? new Map();
      if (parent !== undefined && !cache.has(parent))
        throw new Error("The selected tree item expired; reopen the tree.");
      if (parent) await target.$setExpanded(id, parent, true);
      else cache.clear();
      const batches = await target.$getChildren(id, parent === undefined ? undefined : [parent]);
      const children = batches?.[0]?.slice(1) ?? [];
      if (children.length > 1_000 || cache.size + children.length > 5_000)
        throw new Error("Extension tree exceeds the native list limit.");
      for (const item of children) cache.set(text(item.handle), item);
      this.items.set(id, cache);
      return children.map((item) => ({
        handle: item.handle,
        label:
          typeof item.label === "string"
            ? item.label
            : typeof item.label?.label === "string"
              ? item.label.label
              : item.handle,
        description: typeof item.description === "string" ? item.description : "",
        children: item.collapsibleState === 1 || item.collapsibleState === 2,
        actionable: Boolean(item.command?.id),
      }));
    }
    if (params.operation === "choose") {
      const handle = text(params.handle),
        item = this.items.get(id)?.get(handle);
      if (!item) throw new Error("The selected tree item expired; reopen the tree.");
      await target.$setSelectionAndFocus(id, [handle], handle);
      if (item.command?.id)
        await this.actor("ExtHostCommands").$executeContributedCommand(
          item.command.id,
          ...(item.command.arguments ?? []),
        );
      return true;
    }
    throw new Error("Unsupported native extension tree operation.");
  }
  async ui(params) {
    if (params.operation === "cancelProgress") {
      if (!Number.isSafeInteger(params.handle) || params.handle < 0)
        throw new Error("Invalid extension progress handle.");
      await this.actor("ExtHostProgress").$acceptProgressCanceled(params.handle);
      return true;
    }
    if (params.operation === "statusCommand") {
      const command = this.status.get(text(params.id));
      if (!command?.id) throw new Error("Extension status command is no longer available.");
      return this.actor("ExtHostCommands").$executeContributedCommand(
        command.id,
        ...(command.arguments ?? []),
      );
    }
    throw new Error("Unsupported native extension UI operation.");
  }
}
