import type {
  BrowserAriaRole,
  BrowserElementRef,
  BrowserNodeTarget,
  BrowserPointerTarget,
  BrowserTabId,
} from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import {
  callFunctionOn,
  evaluateInContext,
  observePage,
  sendCdpCommand,
  throwIfAborted,
} from "./cdpRuntime";
import {
  BROWSER_AUTOMATION_BASE_STATE_BOOTSTRAP,
  createAutomationWorld,
  type BrowserSnapshotHandle,
} from "./semanticSnapshot";
import { BrowserAutomationHostError, browserHostError } from "./hostErrors";

export interface BrowserResolvedTargetInfo {
  readonly ref?: BrowserElementRef;
  readonly role?: BrowserAriaRole;
  readonly name?: string;
}

export interface ResolvedBrowserTarget {
  readonly point: { readonly x: number; readonly y: number };
  readonly info: BrowserResolvedTargetInfo;
  readonly objectId?: string;
  readonly attached: boolean;
  readonly visible: boolean;
  readonly enabled: boolean;
  readonly editable: boolean;
}

interface BrowserTargetResolutionOptions {
  readonly requireEditable?: boolean | undefined;
  readonly requireVisible?: boolean | undefined;
  readonly resolvePointElement?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

function targetError(
  code:
    | "BrowserStaleReference"
    | "BrowserTargetNotFound"
    | "BrowserTargetAmbiguous"
    | "BrowserTargetNotVisible"
    | "BrowserTargetNotEditable"
    | "BrowserInvalidLocator",
  tabId: string,
): never {
  if (code === "BrowserTargetAmbiguous") {
    return browserHostError({ code, tabId: tabId as BrowserTabId });
  }
  return browserHostError({
    code,
    retryable: code === "BrowserStaleReference",
    phase: "target",
    effectMayHaveCommitted: false,
    tabId: tabId as BrowserTabId,
  });
}

const TARGET_DESCRIPTION_FUNCTION = String.raw`function() {
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  const attached = this.isConnected === true;
  let checkVisible = true;
  try {
    if (typeof this.checkVisibility === "function") {
      checkVisible = this.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
  } catch {}
  const visible = attached && checkVisible && rect.width > 0 && rect.height > 0 && style.display !== "none" &&
    style.visibility !== "hidden" && Number(style.opacity || 1) !== 0;
  const tag = this.localName;
  const type = String(this.getAttribute("type") || "").toLowerCase();
  let nativelyDisabled = this.disabled === true;
  try { nativelyDisabled ||= this.matches(":disabled"); } catch {}
  const enabled = !nativelyDisabled && String(this.getAttribute("aria-disabled") || "").toLowerCase() !== "true";
  const readOnly = this.readOnly === true || String(this.getAttribute("aria-readonly") || "").toLowerCase() === "true";
  const editable = attached && enabled && !readOnly &&
    (this.isContentEditable || tag === "textarea" || tag === "select" ||
      (tag === "input" && !["button", "submit", "reset", "checkbox", "radio", "range", "file", "hidden"].includes(type)));
  let implicit = "none";
  if (tag === "a" && this.hasAttribute("href")) implicit = "link";
  else if (tag === "button" || tag === "summary") implicit = "button";
  else if (tag === "textarea") implicit = "textbox";
  else if (tag === "select") implicit = "combobox";
  else if (tag === "input") {
    if (type === "checkbox") implicit = "checkbox";
    else if (type === "radio") implicit = "radio";
    else implicit = "textbox";
  }
  const supportedRoles = new Set("alert alertdialog application article banner button cell checkbox columnheader combobox complementary contentinfo definition dialog directory document feed figure form grid gridcell group heading img link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem".split(" "));
  const rawRole = String(this.getAttribute("role") || implicit).split(" ")[0].toLowerCase();
  const role = supportedRoles.has(rawRole) ? rawRole : "none";
  const name = String(this.getAttribute("aria-label") || this.getAttribute("placeholder") ||
    this.getAttribute("alt") || this.textContent || "").replace(/\s+/g, " ").trim().slice(0, 512);
  return { attached, visible, enabled, editable, role, name,
    point: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } };
}`;

const pointElementExpression = (x: number, y: number): string => String.raw`(() => {
  let candidate = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
  const visited = new Set();
  while (candidate?.shadowRoot && !visited.has(candidate)) {
    visited.add(candidate);
    const nested = candidate.shadowRoot.elementFromPoint?.(${JSON.stringify(x)}, ${JSON.stringify(y)});
    if (!nested || nested === candidate) break;
    candidate = nested;
  }
  return candidate;
})()`;

const stateExpression = (body: string): string => String.raw`(() => {
  ${BROWSER_AUTOMATION_BASE_STATE_BOOTSTRAP}
  ${body}
})()`;

const locatorBody = (target: BrowserNodeTarget): string => {
  if ("ref" in target) {
    return `const entry = state.refs.get(${JSON.stringify(target.ref)}); state.currentTarget = entry?.element || null; const stale = !entry || !state.currentTarget?.isConnected || entry.fingerprint !== state.fingerprint(state.currentTarget); return { count: stale ? 0 : 1, stale };`;
  }
  if ("selector" in target) {
    return String.raw`
      const matches = [];
      const visit = (root) => {
        for (const element of root.querySelectorAll(${JSON.stringify(target.selector)})) matches.push(element);
        for (const element of root.querySelectorAll("*")) if (element.shadowRoot) {
          state.observe(element.shadowRoot); visit(element.shadowRoot);
        }
      };
      try { visit(document); } catch (error) { return { invalid: true, message: String(error) }; }
      state.currentTarget = matches.length === 1 ? matches[0] : null;
      return { count: matches.length, generation: state.generation };`;
  }

  const locator = target.locator;
  return String.raw`
    const all = [];
    const visit = (root) => {
      for (const element of root.querySelectorAll("*")) {
        all.push(element);
        if (element.shadowRoot) { state.observe(element.shadowRoot); visit(element.shadowRoot); }
      }
    };
    visit(document);
    const normalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
    const equals = (actual, expected, exact) => exact ? normalize(actual) === normalize(expected) :
      normalize(actual).toLowerCase().includes(normalize(expected).toLowerCase());
    const implicitRole = (element) => {
      const tag = element.localName;
      const type = String(element.getAttribute("type") || "").toLowerCase();
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "button" || tag === "summary") return "button";
      if (tag === "textarea") return "textbox";
      if (tag === "select") return element.multiple ? "listbox" : "combobox";
      if (tag === "input") {
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      if (/^h[1-6]$/.test(tag)) return "heading";
      return "none";
    };
    const name = (element) => normalize(element.getAttribute("aria-label") || element.getAttribute("placeholder") ||
      element.getAttribute("alt") || element.textContent || "");
    const locator = ${JSON.stringify(locator)};
    const matches = all.filter((element) => {
      if (locator.kind === "role") {
        const role = normalize(element.getAttribute("role") || implicitRole(element)).split(" ")[0].toLowerCase();
        return role === locator.role && (locator.name === undefined || equals(name(element), locator.name, locator.exact === true));
      }
      if (locator.kind === "text") return equals(element.textContent || "", locator.text, locator.exact === true);
      if (locator.kind === "placeholder") return equals(element.getAttribute("placeholder") || "", locator.text, locator.exact === true);
      if (locator.kind === "testId") return element.getAttribute("data-testid") === locator.value;
      if (locator.kind === "label") {
        const labels = element.labels ? Array.from(element.labels).map((item) => item.textContent || "").join(" ") : "";
        return equals(labels || element.getAttribute("aria-label") || "", locator.text, locator.exact === true);
      }
      return false;
    });
    state.currentTarget = matches.length === 1 ? matches[0] : null;
    return { count: matches.length, generation: state.generation };`;
};

export const resolveBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  target: BrowserPointerTarget,
  snapshot: BrowserSnapshotHandle | undefined,
  options: BrowserTargetResolutionOptions = {},
): Promise<ResolvedBrowserTarget> => {
  throwIfAborted(options.signal);
  if ("point" in target) {
    const page = await observePage(runtime, options.signal);
    const visible =
      target.point.x >= 0 &&
      target.point.y >= 0 &&
      target.point.x < page.viewport.width &&
      target.point.y < page.viewport.height;
    if (!visible) targetError("BrowserTargetNotVisible", runtime.tabId);
    if (!options.resolvePointElement) {
      return {
        point: target.point,
        info: {},
        attached: true,
        visible: true,
        enabled: false,
        editable: false,
      };
    }
    const object = await evaluateInContext(
      runtime,
      pointElementExpression(target.point.x, target.point.y),
      {
        returnByValue: false,
        signal: options.signal,
      },
    );
    if (!object.objectId) targetError("BrowserTargetNotFound", runtime.tabId);
    return {
      objectId: object.objectId,
      point: target.point,
      info: {},
      attached: true,
      visible: true,
      enabled: true,
      editable: false,
    };
  }

  if ("ref" in target) {
    if (
      !snapshot ||
      snapshot.snapshotId !== target.snapshotId ||
      snapshot.tabId !== runtime.tabId
    ) {
      targetError("BrowserStaleReference", runtime.tabId);
    }
  }

  const contextId =
    "ref" in target && snapshot
      ? snapshot.contextId
      : await createAutomationWorld(runtime, options.signal);
  let selection: {
    readonly count?: number;
    readonly generation?: number;
    readonly invalid?: boolean;
    readonly stale?: boolean;
  };
  try {
    const result = await evaluateInContext<typeof selection>(
      runtime,
      stateExpression(locatorBody(target)),
      { contextId, signal: options.signal },
    );
    selection = result.value ?? {};
  } catch (error) {
    if (error instanceof BrowserAutomationHostError) throw error;
    if ("ref" in target) targetError("BrowserStaleReference", runtime.tabId);
    targetError("BrowserInvalidLocator", runtime.tabId);
  }
  if (selection.invalid) targetError("BrowserInvalidLocator", runtime.tabId);
  if ("ref" in target && selection.stale) targetError("BrowserStaleReference", runtime.tabId);
  if (selection.count === 0 || selection.count === undefined) {
    targetError("BrowserTargetNotFound", runtime.tabId);
  }
  if (selection.count !== 1) targetError("BrowserTargetAmbiguous", runtime.tabId);

  const object = await evaluateInContext(
    runtime,
    "globalThis.__synaraBrowserAutomationV1.currentTarget",
    {
      contextId,
      returnByValue: false,
      signal: options.signal,
    },
  );
  if (!object.objectId) targetError("BrowserTargetNotFound", runtime.tabId);
  const details = await callFunctionOn<{
    readonly attached: boolean;
    readonly visible: boolean;
    readonly enabled: boolean;
    readonly editable: boolean;
    readonly role: BrowserAriaRole;
    readonly name: string;
    readonly point: { readonly x: number; readonly y: number };
  }>(runtime, object.objectId, TARGET_DESCRIPTION_FUNCTION, { signal: options.signal });
  throwIfAborted(options.signal);
  if (!details.value) targetError("BrowserTargetNotFound", runtime.tabId);
  if ("ref" in target && !details.value.attached) {
    targetError("BrowserStaleReference", runtime.tabId);
  }
  if ((options.requireVisible ?? true) && !details.value.visible) {
    targetError("BrowserTargetNotVisible", runtime.tabId);
  }
  if (options.requireEditable && !details.value.editable) {
    targetError("BrowserTargetNotEditable", runtime.tabId);
  }
  return {
    objectId: object.objectId,
    attached: details.value.attached,
    visible: details.value.visible,
    enabled: details.value.enabled,
    editable: details.value.editable,
    point: details.value.point,
    info: {
      ...(target && "ref" in target ? { ref: target.ref } : {}),
      role: details.value.role,
      name: details.value.name,
    },
  };
};

export const releaseBrowserTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  target: ResolvedBrowserTarget,
  signal?: AbortSignal,
): Promise<void> => {
  if (!target.objectId || signal?.aborted) return;
  try {
    await sendCdpCommand(runtime, "Runtime.releaseObject", { objectId: target.objectId }, signal);
  } catch {
    // The page may have navigated after the action; remote handles are already gone.
  }
};
