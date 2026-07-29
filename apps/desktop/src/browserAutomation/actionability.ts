import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { callFunctionOn, throwIfAborted } from "./cdpRuntime";

export interface ActionablePoint {
  readonly x: number;
  readonly y: number;
}

export interface ActionableTarget {
  readonly point: ActionablePoint;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export type ActionabilityFailureDetail =
  | "not visible"
  | "disabled"
  | "not editable"
  | "moving"
  | "covered"
  | "outside viewport"
  | "ref no longer resolves"
  | "actionability result unavailable";

export type ActionabilityResult =
  | { readonly ok: true; readonly target: ActionableTarget }
  | {
      readonly ok: false;
      readonly reason: "stale_ref" | "timeout";
      readonly detail?: ActionabilityFailureDetail;
    };

export interface WaitForActionableTargetOptions {
  readonly editable?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly point?: ActionablePoint | undefined;
  readonly scroll?: "center" | "nearest" | "none" | undefined;
  readonly signal?: AbortSignal | undefined;
}

const DEFAULT_ACTIONABILITY_TIMEOUT_MS = 5_000;
const MAX_ACTIONABILITY_TIMEOUT_MS = 30_000;

const ACTIONABILITY_FUNCTION = String.raw`async function(options) {
  const timeoutMs = Math.max(1, Math.min(30000, Number(options.timeoutMs) || 5000));
  const deadline = performance.now() + timeoutMs;
  const requiresEditable = options.editable === true;
  const scrollMode = options.scroll === "none" || options.scroll === "nearest"
    ? options.scroll
    : "center";
  const requestedPoint = options.point && Number.isFinite(options.point.x) && Number.isFinite(options.point.y)
    ? options.point
    : null;
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const sameNumber = (left, right) => Math.abs(left - right) < 0.25;
  const sameRect = (left, right) => sameNumber(left.x, right.x) && sameNumber(left.y, right.y) &&
    sameNumber(left.width, right.width) && sameNumber(left.height, right.height);
  const rectValue = (rect) => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  const disabled = (element) => {
    if (String(element.getAttribute?.("aria-disabled") || "").toLowerCase() === "true") return true;
    if (element.closest?.('[aria-disabled="true"]')) return true;
    if (element.disabled === true) return true;
    try { if (element.matches(":disabled")) return true; } catch {}
    return false;
  };
  const editable = (element) => {
    if (disabled(element)) return false;
    if (element.readOnly === true || String(element.getAttribute?.("aria-readonly") || "").toLowerCase() === "true") return false;
    if (element.isContentEditable === true) return true;
    const tag = String(element.localName || "").toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = String(element.getAttribute?.("type") || "text").toLowerCase();
    return !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(type);
  };
  const visible = (element, rect) => {
    let checkVisibility = true;
    try {
      if (typeof element.checkVisibility === "function") {
        checkVisibility = element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
    } catch {}
    const style = getComputedStyle(element);
    return checkVisibility && rect.width > 0 && rect.height > 0 &&
      style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") !== 0;
  };
  const viewportPoint = (rect) => {
    if (requestedPoint) {
      if (requestedPoint.x < 0 || requestedPoint.y < 0 ||
          requestedPoint.x >= window.innerWidth || requestedPoint.y >= window.innerHeight) return null;
      return { x: requestedPoint.x, y: requestedPoint.y };
    }
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right <= left || bottom <= top) return null;
    return { x: left + (right - left) / 2, y: top + (bottom - top) / 2 };
  };
  const deepElementFromPoint = (point) => {
    let hit = document.elementFromPoint(point.x, point.y);
    const visited = new Set();
    while (hit?.shadowRoot && !visited.has(hit)) {
      visited.add(hit);
      const nested = hit.shadowRoot.elementFromPoint?.(point.x, point.y);
      if (!nested || nested === hit) break;
      hit = nested;
    }
    return hit;
  };
  const receivesEvents = (element, point) => {
    const hit = deepElementFromPoint(point);
    return Boolean(hit && (hit === element || element.contains?.(hit)));
  };

  let detail = "not visible";
  while (performance.now() <= deadline) {
    const element = this;
    if (!element || element.nodeType !== 1 || element.isConnected !== true) {
      return { ok: false, reason: "stale_ref", detail: "ref no longer resolves" };
    }
    const initialRect = element.getBoundingClientRect();
    if (!visible(element, initialRect)) {
      detail = "not visible";
      await sleep(25);
      continue;
    }
    if (disabled(element)) {
      detail = "disabled";
      await sleep(25);
      continue;
    }
    if (requiresEditable && !editable(element)) {
      detail = "not editable";
      await sleep(25);
      continue;
    }

    if (scrollMode !== "none") {
      element.scrollIntoView?.({
        block: scrollMode === "nearest" ? "nearest" : "center",
        inline: scrollMode === "nearest" ? "nearest" : "center",
        behavior: "instant",
      });
    }
    await sleep(16);
    const firstRect = element.getBoundingClientRect();
    await sleep(16);
    const secondRect = element.getBoundingClientRect();
    if (!sameRect(firstRect, secondRect)) {
      detail = "moving";
      continue;
    }
    const point = viewportPoint(secondRect);
    if (!point) {
      detail = "outside viewport";
      await sleep(25);
      continue;
    }
    if (!receivesEvents(element, point)) {
      detail = "covered";
      await sleep(25);
      continue;
    }
    return { ok: true, target: { point, rect: rectValue(secondRect) } };
  }
  return { ok: false, reason: "timeout", detail };
}`;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isActionableTarget = (value: unknown): value is ActionableTarget => {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (!target.point || typeof target.point !== "object") return false;
  if (!target.rect || typeof target.rect !== "object") return false;
  const point = target.point as Record<string, unknown>;
  const rect = target.rect as Record<string, unknown>;
  return (
    isFiniteNumber(point.x) &&
    isFiniteNumber(point.y) &&
    isFiniteNumber(rect.x) &&
    isFiniteNumber(rect.y) &&
    isFiniteNumber(rect.width) &&
    isFiniteNumber(rect.height) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
};

const normalizeActionabilityResult = (value: unknown): ActionabilityResult => {
  if (value && typeof value === "object") {
    const result = value as Record<string, unknown>;
    if (result.ok === true && isActionableTarget(result.target)) {
      return { ok: true, target: result.target };
    }
    if (result.ok === false && (result.reason === "stale_ref" || result.reason === "timeout")) {
      const detail =
        typeof result.detail === "string" &&
        [
          "not visible",
          "disabled",
          "not editable",
          "moving",
          "covered",
          "outside viewport",
          "ref no longer resolves",
        ].includes(result.detail)
          ? (result.detail as ActionabilityFailureDetail)
          : undefined;
      return {
        ok: false,
        reason: result.reason,
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }
  return {
    ok: false,
    reason: "timeout",
    detail: "actionability result unavailable",
  };
};

export const waitForActionableTarget = async (
  runtime: BrowserAutomationVisibleRuntime,
  objectId: string,
  options: WaitForActionableTargetOptions = {},
): Promise<ActionabilityResult> => {
  throwIfAborted(options.signal);
  const response = await callFunctionOn<ActionabilityResult>(
    runtime,
    objectId,
    ACTIONABILITY_FUNCTION,
    {
      arguments: [
        {
          editable: options.editable === true,
          scroll: options.scroll ?? "center",
          timeoutMs: Math.max(
            1,
            Math.min(
              MAX_ACTIONABILITY_TIMEOUT_MS,
              options.timeoutMs ?? DEFAULT_ACTIONABILITY_TIMEOUT_MS,
            ),
          ),
          ...(options.point === undefined ? {} : { point: options.point }),
        },
      ],
      effectMayHaveCommitted: false,
      signal: options.signal,
    },
  );
  throwIfAborted(options.signal);
  return normalizeActionabilityResult(response.value);
};
