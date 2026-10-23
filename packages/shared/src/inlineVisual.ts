// FILE: inlineVisual.ts
// Purpose: Builds the sandboxed frame document for an inline visual and reads the
//          messages its bootstrap posts back to the host.
// Layer: Shared runtime (consumed by the web transcript; contracts own the payload schema)
// Exports: INLINE_VISUAL_CONTENT_SECURITY_POLICY, buildInlineVisualDocument,
//          readInlineVisualFrameMessage, inlineVisualThemeMessage, inlineVisualLinkResult,
//          clampInlineVisualHeight, INLINE_VISUAL_SERIES_COLORS, readInlineVisualEmbedIds

import {
  INLINE_VISUAL_EMBED_FENCE,
  INLINE_VISUAL_MAX_HEIGHT,
  INLINE_VISUAL_MIN_HEIGHT,
} from "@synara/contracts";

/**
 * The agent's HTML only ever runs inside an opaque-origin frame (`sandbox`
 * without `allow-same-origin`), loaded from `srcdoc` so no URL (and no auth
 * token in one) is visible to it. This policy is the first element of that
 * document, ahead of every agent byte, so it governs all of the page's own
 * scripts and styles. It allows inline code and data: media while blocking
 * remote resource fetches. A document can only add policies, never relax this one.
 *
 * Not covered by CSP, and therefore not claimed: a page navigating its own
 * frame (HTML is desktop-only, where subframe navigation is blocked before
 * loading). The trusted bootstrap removes WebRTC constructors before agent
 * scripts. HTML messages cannot open host URLs; native host links are separate.
 */
export const INLINE_VISUAL_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export type InlineVisualAppearance = "light" | "dark";

/** The app theme a host hands a visual, as CSS custom properties on `:root`. */
export interface InlineVisualTheme {
  readonly appearance: InlineVisualAppearance;
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * Categorical chart series 2 to 6, muted so several read as one palette.
 * Series 1 is the theme's accent (`--chart-accent`), set in the base styles.
 * The app's own `--chart-*` tokens are neutral grays meant for UI chrome.
 */
export const INLINE_VISUAL_SERIES_COLORS: Readonly<
  Record<InlineVisualAppearance, readonly string[]>
> = {
  light: ["#64748b", "#0f766e", "#b45309", "#be123c", "#6d28d9"],
  dark: ["#94a3b8", "#2dd4bf", "#fbbf24", "#fb7185", "#a78bfa"],
};

export function clampInlineVisualHeight(height: number): number {
  return Math.min(
    INLINE_VISUAL_MAX_HEIGHT,
    Math.max(INLINE_VISUAL_MIN_HEIGHT, Math.round(Number.isFinite(height) ? height : 0)),
  );
}

// The bridge reuses MCP Apps method names (JSON-RPC over postMessage) so the
// same host can later serve MCP App documents without a second protocol.
const SIZE_CHANGED_METHOD = "ui/notifications/size-changed";
const OPEN_LINK_METHOD = "ui/open-link";
const HOST_CONTEXT_CHANGED_METHOD = "ui/notifications/host-context-changed";
const SCROLL_INTENT_METHOD = "synara/notifications/scroll-intent";
const STOPPED_METHOD = "synara/notifications/visual-stopped";
const MAX_LINK_LENGTH = 2048;
const THEME_STYLE_ID = "synara-visual-theme";
const VARIABLE_NAME_PATTERN = /^--[a-z0-9-]+$/;

export type InlineVisualFrameMessage =
  | { readonly type: "size"; readonly height: number }
  | { readonly type: "open-link"; readonly id: string | number; readonly url: string }
  | { readonly type: "scroll-intent"; readonly upward: boolean }
  | { readonly type: "stopped" };

/**
 * Reads one message a visual's frame posted. The caller must already have
 * checked that it came from that frame's window; the page can post anything,
 * so every field is validated here and anything else is ignored.
 */
export function readInlineVisualFrameMessage(data: unknown): InlineVisualFrameMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { jsonrpc, id, method, params } = data as Record<string, unknown>;
  if (jsonrpc !== "2.0") return undefined;
  const fields =
    typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
  switch (method) {
    case SIZE_CHANGED_METHOD: {
      const height = fields.height;
      return typeof height === "number" && Number.isFinite(height) && height > 0
        ? { type: "size", height }
        : undefined;
    }
    case OPEN_LINK_METHOD: {
      const url = fields.url;
      if ((typeof id !== "string" && typeof id !== "number") || typeof url !== "string") {
        return undefined;
      }
      if (url.length > MAX_LINK_LENGTH) return undefined;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:"
          ? { type: "open-link", id, url: parsed.href }
          : undefined;
      } catch {
        return undefined;
      }
    }
    case STOPPED_METHOD:
      return { type: "stopped" };
    case SCROLL_INTENT_METHOD:
      return typeof fields.upward === "boolean"
        ? { type: "scroll-intent", upward: fields.upward }
        : undefined;
    default:
      return undefined;
  }
}

/** The empty JSON-RPC result a host sends back for a frame's request. */
export function inlineVisualLinkResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}

/** Posted into a mounted visual when the app theme or font size changes. */
export function inlineVisualThemeMessage(theme: InlineVisualTheme) {
  return {
    jsonrpc: "2.0",
    method: HOST_CONTEXT_CHANGED_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

// The page sits on the transcript's own background, inherits the reader's
// font and chat size, and honors reduced motion even when its own CSS forgets.
// Plain elements (headings, tables, buttons, inputs) look like the app, so a
// page reads as part of the reply without its own design system. Everything
// sits in :where() (no specificity), so the page's own rules always win.
const BASE_CSS =
  // Derived from the theme variables, so they follow theme changes live.
  ":root{--chart-accent:var(--info);--series-1:var(--chart-accent);--chart-muted:color-mix(in srgb,var(--foreground) 18%,var(--background));--chart-grid:color-mix(in srgb,var(--foreground) 8%,transparent);--rule:color-mix(in srgb,var(--foreground) 11%,transparent);--surface:color-mix(in srgb,var(--foreground) 3%,var(--background));--control-height:2.15em}" +
  "html{color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size);line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":where(h1,h2,h3,h4){margin:0 0 .5em;font-weight:600;line-height:1.3}:where(h1){font-size:1.3em}:where(h2){font-size:1.15em}:where(h3){font-size:1em}:where(h4){font-size:.85em;font-weight:500;color:var(--muted-foreground)}" +
  ":where(p){margin:0 0 .75em}:where(p:last-child){margin-bottom:0}:where(small){font-size:.85em}:where(small,.muted){color:var(--muted-foreground)}:where(hr){border:0;border-top:1px solid var(--rule);margin:1em 0}" +
  ":where(table){border-collapse:collapse;font-variant-numeric:tabular-nums}:where(th){font-size:.85em;font-weight:500;color:var(--muted-foreground);text-align:left}:where(th,td){padding:.45em 1.25em .45em 0;border-bottom:1px solid var(--rule)}:where(th:last-child,td:last-child){padding-right:0}:where(tbody tr:last-child>td){border-bottom:0}" +
  // After the table rules, so a numeric header cell lines up with its column.
  ":where(.num){text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}" +
  ":where(button,input,select,textarea){font:inherit;color:inherit}" +
  ":where(button,select,input:not([type=checkbox],[type=radio],[type=range],[type=color])){box-sizing:border-box;min-height:var(--control-height);padding:0 .75em;border:1px solid var(--rule);border-radius:calc(var(--radius) - 2px);background:transparent}" +
  ":where(button){display:inline-flex;align-items:center;justify-content:center;gap:.4em;font-weight:500;white-space:nowrap;cursor:pointer;transition:background-color .15s,border-color .15s}:where(button:hover){background:var(--secondary)}" +
  ":where(button[aria-pressed=true]){background:var(--secondary);border-color:color-mix(in srgb,var(--foreground) 24%,transparent)}:where(button.primary){background:var(--primary);color:var(--primary-foreground);border-color:transparent}" +
  ":where(button,input,select,textarea):where(:disabled){opacity:.5;cursor:default}:where(input[type=checkbox],input[type=radio],input[type=range],progress){accent-color:var(--chart-accent)}:where(label){display:inline-flex;align-items:center;gap:.5em}" +
  // A segmented control: buttons with aria-pressed inside .segmented.
  ":where(.segmented){display:inline-flex;gap:2px;padding:2px;border-radius:calc(var(--radius) - 1px);background:var(--secondary)}:where(.segmented>button){min-height:calc(var(--control-height) - 4px);border-color:transparent;background:transparent;color:var(--muted-foreground)}:where(.segmented>button[aria-pressed=true]){background:var(--background);color:var(--foreground);border-color:var(--rule);box-shadow:0 1px 2px rgb(0 0 0/.06)}" +
  // A status tag: .tag with data-tone accent, success, warning, or danger.
  ":where(.tag){display:inline-flex;align-items:center;gap:.3em;padding:.05em .55em;border-radius:999px;font-size:.85em;font-weight:500;white-space:nowrap;background:var(--secondary);color:var(--muted-foreground)}:where(.tag[data-tone=accent]){background:color-mix(in srgb,var(--chart-accent) 14%,transparent);color:color-mix(in srgb,var(--chart-accent) 80%,var(--foreground))}:where(.tag[data-tone=success]){background:color-mix(in srgb,var(--success) 14%,transparent);color:color-mix(in srgb,var(--success) 70%,var(--foreground))}:where(.tag[data-tone=warning]){background:color-mix(in srgb,var(--warning) 16%,transparent);color:color-mix(in srgb,var(--warning) 60%,var(--foreground))}:where(.tag[data-tone=danger]){background:color-mix(in srgb,var(--destructive) 14%,transparent);color:color-mix(in srgb,var(--destructive) 75%,var(--foreground))}" +
  ":where(:focus-visible){outline:2px solid var(--ring);outline-offset:1px}" +
  "@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}";

function themeCss(theme: InlineVisualTheme): string {
  let declarations = `color-scheme:${theme.appearance === "light" ? "light" : "dark"};`;
  for (const [name, value] of Object.entries(theme.variables)) {
    if (!VARIABLE_NAME_PATTERN.test(name)) continue;
    declarations += `${name}:${String(value).replace(/[;{}<>]/g, "")};`;
  }
  return `:root{${declarations}}${BASE_CSS}`;
}

// Runs before any agent markup. It (1) applies theme updates the host posts,
// (2) reports the content height so the host can fit the frame, (3) turns
// link clicks into host requests instead of frame navigations (a srcdoc
// document resolves relative and #fragment links against the *app's* URL),
// (4) forwards scroll gestures, which never reach the host document from inside
// a frame, so a reader scrolling over a visual still detaches transcript
// follow, and (5) replaces storage that the opaque origin refuses with an
// in-memory stand-in so ordinary page code keeps working.
const BOOTSTRAP_SCRIPT = `(function(){
var style=document.getElementById(${JSON.stringify(THEME_STYLE_ID)}),base=${JSON.stringify(BASE_CSS)},parentWindow=window.parent,linkId=0;
function post(message){if(parentWindow&&parentWindow!==window)parentWindow.postMessage(message,"*");}
// WebRTC ICE bypasses connect-src. Remove capabilities before agent markup; stop parsing if a runtime cannot enforce that boundary.
try{["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection","RTCIceGatherer","RTCIceTransport","RTCDtlsTransport","RTCRtpSender","RTCRtpReceiver","RTCSctpTransport","RTCQuicTransport"].forEach(function(name){Object.defineProperty(window,name,{value:undefined,writable:false,configurable:false});});}catch(error){window.stop();document.documentElement.replaceChildren();post({jsonrpc:"2.0",method:${JSON.stringify(STOPPED_METHOD)}});return;}
function applyTheme(appearance,variables){if(!style||!variables||typeof variables!=="object")return;var css=":root{color-scheme:"+(appearance==="light"?"light":"dark")+";";for(var name in variables){if(${VARIABLE_NAME_PATTERN.toString()}.test(name))css+=name+":"+String(variables[name]).replace(/[;{}<>]/g,"")+";";}style.textContent=css+"}"+base;}
window.addEventListener("message",function(event){if(event.source!==parentWindow)return;var data=event.data,params=data&&data.params;if(data&&data.jsonrpc==="2.0"&&data.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&params&&params.styles)applyTheme(params.theme,params.styles.variables);});
function memoryStorage(){var items=new Map();return{get length(){return items.size;},key:function(index){var keys=Array.from(items.keys());return index>=0&&index<keys.length?keys[index]:null;},getItem:function(key){key=String(key);return items.has(key)?items.get(key):null;},setItem:function(key,value){items.set(String(key),String(value));},removeItem:function(key){items.delete(String(key));},clear:function(){items.clear();}};}
["localStorage","sessionStorage"].forEach(function(name){try{window[name].getItem("");}catch(error){try{Object.defineProperty(window,name,{value:memoryStorage(),configurable:true});}catch(ignored){}}});
document.addEventListener("click",function(event){if(!event.isTrusted||event.defaultPrevented)return;var path=event.composedPath(),anchor=null;for(var i=0;i<path.length;i++){var node=path[i];if(node&&node.matches&&node.matches("a[href]")){anchor=node;break;}}if(!anchor)return;var href=anchor.getAttribute("href")||"";event.preventDefault();if(href.charAt(0)==="#"){var target=href.length>1?document.getElementById(decodeURIComponent(href.slice(1))):null;if(target)target.scrollIntoView();return;}var url;try{url=new URL(href);}catch(error){return;}if(url.protocol==="http:"||url.protocol==="https:")post({jsonrpc:"2.0",id:"link-"+(++linkId),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:url.href}});},true);
var lastHeight=-1;function reportSize(){var root=document.documentElement,height=Math.ceil(root.scrollHeight>root.clientHeight?root.scrollHeight:root.getBoundingClientRect().height);if(height===lastHeight)return;lastHeight=height;post({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:height}});}
if(window.ResizeObserver){var observer=new ResizeObserver(reportSize);observer.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)observer.observe(document.body);});}
document.addEventListener("DOMContentLoaded",reportSize);window.addEventListener("load",reportSize);
var intentQueued=false,intentUpward=false;function scrollIntent(upward){if(upward)intentUpward=true;if(intentQueued)return;intentQueued=true;requestAnimationFrame(function(){var up=intentUpward;intentQueued=false;intentUpward=false;post({jsonrpc:"2.0",method:${JSON.stringify(SCROLL_INTENT_METHOD)},params:{upward:up}});});}
window.addEventListener("wheel",function(event){if(event.ctrlKey||event.deltaY===0)return;scrollIntent(event.deltaY<0);},{passive:true,capture:true});
var touchY=null;window.addEventListener("touchstart",function(event){touchY=event.touches.length===1?event.touches[0].clientY:null;},{passive:true,capture:true});
window.addEventListener("touchmove",function(event){if(touchY===null||event.touches.length!==1)return;var y=event.touches[0].clientY;if(y!==touchY){scrollIntent(y>touchY);touchY=y;}},{passive:true,capture:true});
window.addEventListener("keydown",function(event){if(event.defaultPrevented||event.ctrlKey||event.metaKey||event.altKey)return;var target=event.target;if(target&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName||"")))return;var key=event.key;if(key==="ArrowUp"||key==="PageUp"||key==="Home"||(key===" "&&event.shiftKey))scrollIntent(true);else if(key==="ArrowDown"||key==="PageDown"||key==="End"||key===" ")scrollIntent(false);},true);
})();`;

const LEADING_DOCTYPE = /^﻿?\s*<!doctype[^>]*>/i;

/**
 * The `srcdoc` for a visual. Policy, theme, and bootstrap come before every
 * byte of the agent's document: the parser hoists them into the head the
 * page's own markup then continues, so even a page that opens with a script
 * runs under the policy.
 */
export function buildInlineVisualDocument(html: string, theme: InlineVisualTheme): string {
  return [
    "<!doctype html>",
    `<meta http-equiv="Content-Security-Policy" content="${INLINE_VISUAL_CONTENT_SECURITY_POLICY}">`,
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style id="${THEME_STYLE_ID}">${themeCss(theme)}</style>`,
    `<script>${BOOTSTRAP_SCRIPT}</script>`,
    html.replace(LEADING_DOCTYPE, ""),
  ].join("");
}

/** The same exact-body rule is used by placement discovery and markdown rendering. */
export function readInlineVisualEmbedId(body: string): string | null {
  const id = body.trim();
  return /^vis_[0-9a-f]{32}$/.test(id) ? id : null;
}

const EMBED_PATTERN = new RegExp(
  "^ {0,3}(`{3,}|~{3,})[ \\t]*" +
    INLINE_VISUAL_EMBED_FENCE +
    "[ \\t]*\\r?\\n([\\s\\S]*?)^ {0,3}(`{3,}|~{3,})[ \\t]*$",
  "gm",
);

/** Complete, exact visual fences; malformed fences remain ordinary code. */
export function readInlineVisualEmbedIds(text: string): string[] {
  if (!text.includes(INLINE_VISUAL_EMBED_FENCE)) return [];
  return Array.from(text.matchAll(EMBED_PATTERN)).flatMap((match) => {
    if (!match[3]!.startsWith(match[1]!)) return [];
    const id = readInlineVisualEmbedId(match[2]!);
    return id === null ? [] : [id];
  });
}
