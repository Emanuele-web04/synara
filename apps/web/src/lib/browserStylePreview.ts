// FILE: browserStylePreview.ts
// Purpose: Runtime style preview helpers for the in-app browser editor.
// Layer: Browser editor DOM bridge

import type { BrowserElementStylePatch } from "./browserEditorContext";

export type BrowserStylePreviewMode = "preview" | "clear" | "commit";

const PREVIEW_STYLE_ATTR = "data-synara-style-preview";
const PREVIEW_TARGET_ATTR = "data-synara-style-preview-target";
const PREVIEW_ORIGINAL_TARGET_ATTR = "data-synara-style-preview-original-target";
const PREVIEW_HAD_TARGET_ATTR = "data-synara-style-preview-had-target";
const PREVIEW_EFFECT_TARGET_ATTR = "data-synara-style-preview-effect-target";
const PREVIEW_TARGET_VALUE = "active";
const BROWSER_STYLE_PREVIEW_RUNTIME_KEY = "__synaraBrowserStylePreviewRuntime";
const BROWSER_STYLE_PREVIEW_RUNTIME_VERSION = "1";

const BROWSER_STYLE_PATCH_CSS_PROPERTIES: Partial<Record<keyof BrowserElementStylePatch, string>> = {
  color: "color",
  backgroundColor: "background-color",
  backgroundImage: "background-image",
  backgroundPosition: "background-position",
  backgroundSize: "background-size",
  fontFamily: "font-family",
  fontSize: "font-size",
  fontWeight: "font-weight",
  fontStyle: "font-style",
  lineHeight: "line-height",
  letterSpacing: "letter-spacing",
  textAlign: "text-align",
  opacity: "opacity",
  padding: "padding",
  margin: "margin",
  borderWidth: "border-width",
  borderColor: "border-color",
  borderRadius: "border-radius",
  boxShadow: "box-shadow",
  filter: "filter",
  animationName: "animation-name",
  animationDuration: "animation-duration",
  animationTimingFunction: "animation-timing-function",
  animationIterationCount: "animation-iteration-count",
};

function restorePreviewTargets(document: Document): void {
  for (const element of Array.from(document.querySelectorAll(`[${PREVIEW_ORIGINAL_TARGET_ATTR}]`))) {
    const hadTarget = element.getAttribute(PREVIEW_HAD_TARGET_ATTR) === "true";
    const originalTarget = element.getAttribute(PREVIEW_ORIGINAL_TARGET_ATTR) ?? "";
    if (hadTarget) {
      element.setAttribute(PREVIEW_TARGET_ATTR, originalTarget);
    } else {
      element.removeAttribute(PREVIEW_TARGET_ATTR);
    }
    element.removeAttribute(PREVIEW_ORIGINAL_TARGET_ATTR);
    element.removeAttribute(PREVIEW_HAD_TARGET_ATTR);
  }
}

function clearPreviewStyle(document: Document): void {
  document.querySelector(`style[${PREVIEW_STYLE_ATTR}]`)?.remove();
  restorePreviewTargets(document);
}

function markPreviewTarget(element: HTMLElement): void {
  const originalTarget = element.getAttribute(PREVIEW_TARGET_ATTR);
  if (!element.hasAttribute(PREVIEW_ORIGINAL_TARGET_ATTR)) {
    element.setAttribute(PREVIEW_ORIGINAL_TARGET_ATTR, originalTarget ?? "");
    element.setAttribute(PREVIEW_HAD_TARGET_ATTR, originalTarget === null ? "false" : "true");
  }
  element.setAttribute(PREVIEW_TARGET_ATTR, PREVIEW_TARGET_VALUE);
}

function previewRuleSelector(effectTarget: BrowserElementStylePatch["effectTarget"]): string {
  const pseudo = effectTarget === "::before" || effectTarget === "::after" ? effectTarget : "";
  return `[${PREVIEW_TARGET_ATTR}="${PREVIEW_TARGET_VALUE}"]${pseudo}`;
}

function ensurePreviewRule(
  document: Document,
  effectTarget: BrowserElementStylePatch["effectTarget"] = "element",
): CSSStyleDeclaration | null {
  let styleElement = document.querySelector<HTMLStyleElement>(`style[${PREVIEW_STYLE_ATTR}]`);
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.setAttribute(PREVIEW_STYLE_ATTR, "true");
    document.head.append(styleElement);
  }
  if (
    styleElement.getAttribute(PREVIEW_EFFECT_TARGET_ATTR) !== effectTarget ||
    !styleElement.sheet?.cssRules[0]
  ) {
    styleElement.setAttribute(PREVIEW_EFFECT_TARGET_ATTR, effectTarget);
    styleElement.textContent = `${previewRuleSelector(effectTarget)} {}`;
  }
  const sheet = styleElement.sheet;
  const rule = sheet?.cssRules[0];
  return rule instanceof CSSStyleRule ? rule.style : null;
}

function applyPatchToDeclaration(
  declaration: CSSStyleDeclaration,
  patch: BrowserElementStylePatch,
  priority: string,
): void {
  for (const [key, cssProperty] of Object.entries(BROWSER_STYLE_PATCH_CSS_PROPERTIES) as Array<
    [keyof BrowserElementStylePatch, string]
  >) {
    if (!cssProperty) {
      continue;
    }
    const value = patch[key]?.trim();
    if (value) {
      declaration.setProperty(cssProperty, value, priority);
    }
  }
}

function applyCommit(element: HTMLElement, patch: BrowserElementStylePatch): void {
  applyPatchToDeclaration(element.style, patch, "");
}

export function applyBrowserStylePreviewToDocument(input: {
  document: Document;
  selector: string;
  patch: BrowserElementStylePatch;
  mode: BrowserStylePreviewMode;
}): boolean {
  if (input.mode === "clear") {
    clearPreviewStyle(input.document);
    return true;
  }

  const element = input.document.querySelector(input.selector);
  const HTMLElementCtor = input.document.defaultView?.HTMLElement ?? HTMLElement;
  if (!element || !(element instanceof HTMLElementCtor)) {
    return false;
  }

  if (input.mode === "commit") {
    if (input.patch.effectTarget === "::before" || input.patch.effectTarget === "::after") {
      markPreviewTarget(element as HTMLElement);
      const declaration = ensurePreviewRule(input.document, input.patch.effectTarget);
      if (!declaration) {
        return false;
      }
      applyPatchToDeclaration(declaration, input.patch, "");
      return true;
    }
    applyCommit(element as HTMLElement, input.patch);
    clearPreviewStyle(input.document);
    return true;
  }

  restorePreviewTargets(input.document);
  markPreviewTarget(element as HTMLElement);
  const declaration = ensurePreviewRule(input.document, input.patch.effectTarget);
  if (!declaration) {
    return false;
  }
  applyPatchToDeclaration(declaration, input.patch, "important");
  return true;
}

export function browserStylePreviewInstallExpression(): string {
  return `(() => {
    const runtimeKey = ${JSON.stringify(BROWSER_STYLE_PREVIEW_RUNTIME_KEY)};
    const version = ${JSON.stringify(BROWSER_STYLE_PREVIEW_RUNTIME_VERSION)};
    const existing = window[runtimeKey];
    if (existing && existing.version === version && typeof existing.apply === "function") {
      return { ok: true, version };
    }

    const styleAttr = ${JSON.stringify(PREVIEW_STYLE_ATTR)};
    const targetAttr = ${JSON.stringify(PREVIEW_TARGET_ATTR)};
    const originalTargetAttr = ${JSON.stringify(PREVIEW_ORIGINAL_TARGET_ATTR)};
    const hadTargetAttr = ${JSON.stringify(PREVIEW_HAD_TARGET_ATTR)};
    const effectTargetAttr = ${JSON.stringify(PREVIEW_EFFECT_TARGET_ATTR)};
    const targetValue = ${JSON.stringify(PREVIEW_TARGET_VALUE)};
    const propertyMap = ${JSON.stringify(BROWSER_STYLE_PATCH_CSS_PROPERTIES)};
    const previewSelector = (effectTarget) => {
      const pseudo = effectTarget === "::before" || effectTarget === "::after" ? effectTarget : "";
      return "[" + targetAttr + "=\\"" + targetValue + "\\"]" + pseudo;
    };
    const restoreTargets = () => {
      for (const element of Array.from(document.querySelectorAll("[" + originalTargetAttr + "]"))) {
        const hadTarget = element.getAttribute(hadTargetAttr) === "true";
        const originalTarget = element.getAttribute(originalTargetAttr) || "";
        if (hadTarget) {
          element.setAttribute(targetAttr, originalTarget);
        } else {
          element.removeAttribute(targetAttr);
        }
        element.removeAttribute(originalTargetAttr);
        element.removeAttribute(hadTargetAttr);
      }
    };
    const clearPreview = () => {
      const styleElement = document.querySelector("style[" + styleAttr + "]");
      if (styleElement) styleElement.remove();
      restoreTargets();
    };
    const markTarget = (element) => {
      if (!element.hasAttribute(originalTargetAttr)) {
        const originalTarget = element.getAttribute(targetAttr);
        element.setAttribute(originalTargetAttr, originalTarget || "");
        element.setAttribute(hadTargetAttr, originalTarget === null ? "false" : "true");
      }
      element.setAttribute(targetAttr, targetValue);
    };
    const previewRule = (effectTarget) => {
      let styleElement = document.querySelector("style[" + styleAttr + "]");
      if (!styleElement) {
        styleElement = document.createElement("style");
        styleElement.setAttribute(styleAttr, "true");
        document.head.append(styleElement);
      }
      const nextEffectTarget = effectTarget || "element";
      if (styleElement.getAttribute(effectTargetAttr) !== nextEffectTarget || !(styleElement.sheet && styleElement.sheet.cssRules[0])) {
        styleElement.setAttribute(effectTargetAttr, nextEffectTarget);
        styleElement.textContent = previewSelector(nextEffectTarget) + " {}";
      }
      const rule = styleElement.sheet && styleElement.sheet.cssRules[0];
      return rule instanceof CSSStyleRule ? rule.style : null;
    };
    const applyPatch = (declaration, patch, priority) => {
      for (const [key, cssProperty] of Object.entries(propertyMap)) {
        const value = typeof patch[key] === "string" ? patch[key].trim() : "";
        if (value) declaration.setProperty(cssProperty, value, priority);
      }
    };

    window[runtimeKey] = {
      version,
      apply(input) {
        try {
          if (!input || input.mode === "clear") {
            clearPreview();
            return { ok: true };
          }
          const element = document.querySelector(input.selector);
          if (!(element instanceof HTMLElement)) {
            return { ok: false };
          }
          const patch = input.patch || {};
          if (input.mode === "commit") {
            if (patch.effectTarget === "::before" || patch.effectTarget === "::after") {
              markTarget(element);
              const declaration = previewRule(patch.effectTarget);
              if (!declaration) return { ok: false };
              applyPatch(declaration, patch, "");
              return { ok: true };
            }
            applyPatch(element.style, patch, "");
            clearPreview();
            return { ok: true };
          }
          restoreTargets();
          markTarget(element);
          const declaration = previewRule(patch.effectTarget);
          if (!declaration) return { ok: false };
          applyPatch(declaration, patch, "important");
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error && typeof error.message === "string" ? error.message : String(error),
          };
        }
      },
    };
    return { ok: true, version };
  })()`;
}

export function browserStylePreviewInvokeExpression(input: {
  selector: string;
  patch: BrowserElementStylePatch;
  mode: BrowserStylePreviewMode;
}): string {
  return `(() => {
    const runtime = window[${JSON.stringify(BROWSER_STYLE_PREVIEW_RUNTIME_KEY)}];
    if (!runtime || runtime.version !== ${JSON.stringify(BROWSER_STYLE_PREVIEW_RUNTIME_VERSION)} || typeof runtime.apply !== "function") {
      return { ok: false, missingRuntime: true };
    }
    return runtime.apply(${JSON.stringify(input)});
  })()`;
}
