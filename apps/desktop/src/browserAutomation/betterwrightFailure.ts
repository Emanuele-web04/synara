import { homedir } from "node:os";
import {
  BROWSER_AUTOMATION_ERROR_CAUSE_MESSAGE_MAX_BYTES,
  type BrowserAutomationErrorCause,
} from "@synara/contracts";
import { redactDiagnosticText } from "@synara/shared/diagnosticsRedaction";

// Globals agents reach for that the browser_run realm does not define, with the
// replacement to use. The sandbox is a bare VM context: only ECMAScript
// built-ins plus Betterwright's helpers (page, human, snapshot, ...) exist.
const TIMER_GLOBALS = [
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "requestAnimationFrame",
  "queueMicrotask",
];
const PAGE_GLOBALS = [
  "document",
  "window",
  "location",
  "navigator",
  "history",
  "self",
  "localStorage",
  "sessionStorage",
  "getComputedStyle",
  "fetch",
  "XMLHttpRequest",
];
const LOCATOR_GLOBALS = [
  "getByRole",
  "getByLabel",
  "getByText",
  "getByPlaceholder",
  "getByTestId",
  "getByAltText",
  "getByTitle",
  "locator",
];
const NODE_GLOBALS = [
  "require",
  "process",
  "Buffer",
  "module",
  "exports",
  "__dirname",
  "__filename",
];
const UNAVAILABLE_GLOBAL_HINTS: ReadonlyMap<string, string> = new Map([
  ...TIMER_GLOBALS.map(
    (name) =>
      [
        name,
        `${name} is unavailable in browser_run; wait with locator.waitFor(), page.waitForURL(), page.waitForFunction() or page.waitForTimeout(ms).`,
      ] as const,
  ),
  ...PAGE_GLOBALS.map(
    (name) =>
      [
        name,
        `${name} is a page global and is unavailable in browser_run; read it inside page.evaluate(() => ...).`,
      ] as const,
  ),
  ...LOCATOR_GLOBALS.map(
    (name) => [name, `${name} is not a browser_run global; call page.${name}(...).`] as const,
  ),
  [
    "waitForTimeout",
    "waitForTimeout is not a browser_run global; use page.waitForTimeout(ms) or locator.waitFor().",
  ],
  ...NODE_GLOBALS.map(
    (name) =>
      [
        name,
        `${name} is unavailable in browser_run; scripts run in a browser sandbox without Node.js APIs.`,
      ] as const,
  ),
]);

const PLAYWRIGHT_OBJECTS = new Set([
  "page",
  "frame",
  "frameLocator",
  "locator",
  "elementHandle",
  "jsHandle",
  "keyboard",
  "mouse",
  "touchscreen",
  "browserContext",
  "request",
  "response",
  "download",
  "fileChooser",
  "dialog",
]);
// Errors from these APIs are thrown by code running in the page, so the page
// controls their text.
const PAGE_EVALUATION_METHODS = new Set([
  "evaluate",
  "evaluateAll",
  "evaluateHandle",
  "$eval",
  "$$eval",
  "waitForFunction",
]);
const PLAYWRIGHT_METHODS = new Set([
  ...PAGE_EVALUATION_METHODS,
  "check",
  "click",
  "dblclick",
  "dragTo",
  "fill",
  "goto",
  "hover",
  "insertText",
  "press",
  "selectOption",
  "uncheck",
  "waitFor",
  "waitForLoadState",
  "waitForURL",
]);
const NAVIGATION_ERRORS = new Set([
  "ERR_ABORTED",
  "ERR_CERT_AUTHORITY_INVALID",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_TIMED_OUT",
]);
type ScriptErrorName = NonNullable<BrowserAutomationErrorCause["name"]>;
const ERROR_NAMES: ReadonlySet<string> = new Set<ScriptErrorName>([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
]);

// V8 messages whose only variable part is an identifier or property name from
// the evaluated code, never a runtime value.
const ENGINE_MESSAGE_SHAPES: ReadonlyArray<readonly [RegExp, ScriptErrorName]> = [
  [
    /^Cannot (?:read|set) properties of (?:null|undefined) \((?:reading|setting) '[\w$-]{0,64}'\)$/,
    "TypeError",
  ],
  [/^[\w$.]{1,100} is not (?:a function|iterable|a constructor)$/, "TypeError"],
  [/^Assignment to constant variable\.$/, "TypeError"],
  [/^[A-Za-z_$][\w$]{0,63} is not defined$/, "ReferenceError"],
  [/^Cannot access '[\w$]{1,64}' before initialization$/, "ReferenceError"],
  [/^Maximum call stack size exceeded$/, "RangeError"],
  [
    /^(?:Unexpected (?:token|identifier|end of input|string|number|template string|strict mode reserved word)(?: '[^'\n]{0,40}')?|Invalid or unexpected token|missing \) after argument list|Unterminated (?:string constant|template literal|regular expression)|Illegal return statement|Identifier '[\w$]{1,64}' has already been declared|await is only valid in async functions and the top level bodies of modules)$/,
    "SyntaxError",
  ],
];
// Fixed Betterwright and Synara host messages that carry no page data.
const FIXED_RUNTIME_MESSAGES: ReadonlyArray<RegExp> = [
  /^human\.type did not change the field\. The target may ignore synthetic key events \(common in Draft\.js and other rich-text editors\)\.$/,
  /^human\.type needs about \d{1,9} ms to type \d{1,9} characters at human pace, but about \d{1,9} ms remain in this call\. Nothing was typed\. Use locator\.fill\(text\) or page\.keyboard\.insertText\(text\) for long text, or raise timeoutMs\.$/,
  /^getByRole name must be a string or RegExp, received (?:null|array|undefined|object|boolean|number|bigint|symbol|function)\.$/,
  /^No active page; call openPage\(url\)\.$/,
  /^(?:Open another|Close this) tab through the host\.$/,
  /^Host-owned tabs must be opened or closed by the host\.$/,
  /^Native keyboard command denied\.$/,
  /^Browser (?:control was interrupted|target is unavailable|target lease ended)\.$/,
];
const WITHHELD_ERROR = {
  script:
    "The script threw an error whose text was withheld because it may contain page content. Wrap the failing step in try/catch and return a short summary of the error to inspect it.",
  runtime:
    "The browser runtime failed outside the script before confirming a result; its error text was withheld. Inspect the page before retrying.",
} as const;
// Leaves room for multi-byte characters within the contract's byte bound.
const CAUSE_MESSAGE_MAX_CHARS =
  Math.floor(BROWSER_AUTOMATION_ERROR_CAUSE_MESSAGE_MAX_BYTES / 4) * 4;

const makeCause = (
  message: string,
  name?: ScriptErrorName,
  api?: string,
): BrowserAutomationErrorCause => {
  let text = redactDiagnosticText(message, {
    homeDir: homedir(),
    maxLength: CAUSE_MESSAGE_MAX_CHARS,
  }).trim();
  while (Buffer.byteLength(text, "utf8") > BROWSER_AUTOMATION_ERROR_CAUSE_MESSAGE_MAX_BYTES) {
    text = `${text.slice(0, -2)}…`;
  }
  return {
    ...(name ? { name } : {}),
    ...(api ? { api } : {}),
    message: text || "Error",
  };
};

const engineMessageName = (message: string): ScriptErrorName | undefined =>
  ENGINE_MESSAGE_SHAPES.find(([shape]) => shape.test(message))?.[1];

// A property read through a computed key names that key, which can be page data
// (`null[secret]` reads "(reading 'secret')"). Keep the error's shape only.
const withoutPropertyName = (message: string): string =>
  message.replace(/\((reading|setting) '[^'\n]*'\)$/, "($1 a property)");

// The script can use page-derived values, so keep only the engine error shape.
const withoutVariableErrorText = (message: string): string =>
  withoutPropertyName(message)
    .replace(/'[^'\n]*'/g, "'…'")
    .replace(/^[\w$.]{1,100}(?= is not (?:a function|iterable|a constructor)$)/, "a value")
    .replace(/^[A-Za-z_$][\w$]{0,63}(?= is not defined$)/, "a name");

function playwrightApiCause(
  api: string,
  method: string,
  detail: string,
): BrowserAutomationErrorCause {
  const timeout = /^Timeout (\d{1,9})ms exceeded\.?$/.exec(detail);
  if (timeout) return makeCause(`${api}: Timeout ${timeout[1]}ms exceeded.`, "TimeoutError", api);
  const thrown = /^([A-Za-z]{1,32}): (.*)$/.exec(detail);
  const name = thrown && ERROR_NAMES.has(thrown[1]!) ? (thrown[1] as ScriptErrorName) : undefined;
  const body = name ? thrown![2]! : detail;
  if (PAGE_EVALUATION_METHODS.has(method)) {
    const engineName = engineMessageName(body);
    if (engineName) {
      return makeCause(`${api}: ${withoutVariableErrorText(body)}`, name ?? engineName, api);
    }
    return makeCause(
      `${api}: ${name ?? "An error"} was thrown in the page; its message was withheld because page code controls it.`,
      name,
      api,
    );
  }
  const strict = /^strict mode violation: .* resolved to (\d{1,6}) elements:?$/.exec(body);
  if (strict) {
    return makeCause(
      `${api}: strict mode violation: the locator resolved to ${strict[1]} elements. Use a more specific locator, .first() or .nth(i).`,
      name,
      api,
    );
  }
  const navigationError =
    method === "goto" ? /^net::(ERR_[A-Z_]+)(?: at |$)/.exec(body)?.[1] : undefined;
  if (navigationError && NAVIGATION_ERRORS.has(navigationError)) {
    return makeCause(`${api}: net::${navigationError}`, name, api);
  }
  return makeCause(`${api}: The operation failed. Its error text was withheld.`, name, api);
}

export interface BetterwrightFailure {
  readonly code: "BrowserEvaluationFailed" | "BrowserScriptApiUnavailable";
  readonly cause: BrowserAutomationErrorCause;
}

const failed = (cause: BrowserAutomationErrorCause): BetterwrightFailure => ({
  code: "BrowserEvaluationFailed",
  cause,
});

/**
 * Classify a failed browser_run script into a sanitized, bounded cause. Only
 * the first line is read, because Playwright call logs and stacks list page
 * elements. Page-controlled and unrecognized text is withheld, not redacted.
 */
export function describeBetterwrightFailure(
  error: unknown,
  source: keyof typeof WITHHELD_ERROR = "script",
): BetterwrightFailure {
  const raw = error instanceof Error ? error.message : error;
  const line = typeof raw === "string" ? (raw.slice(0, 2_000).split("\n", 1)[0] ?? "").trim() : "";
  const missingGlobal = /^([A-Za-z_$][\w$]{0,63}) is not defined$/.exec(line)?.[1];
  const hint = missingGlobal ? UNAVAILABLE_GLOBAL_HINTS.get(missingGlobal) : undefined;
  if (hint)
    return { code: "BrowserScriptApiUnavailable", cause: makeCause(hint, "ReferenceError") };
  if (line === "page.snapshot is not a function") {
    return {
      code: "BrowserScriptApiUnavailable",
      cause: makeCause(
        "page.snapshot is unavailable; call the global snapshot() helper.",
        "TypeError",
      ),
    };
  }
  const scriptTimeout = /^Playwright code timed out after (\d{1,9})ms$/.exec(line);
  if (scriptTimeout) {
    return failed(
      makeCause(
        `The browser_run script exceeded its ${scriptTimeout[1]} ms budget. Split the work into smaller calls or raise timeoutMs (max 30000).`,
        "TimeoutError",
      ),
    );
  }
  const api = /^([a-z][A-Za-z]{0,31})\.([$A-Za-z][\w$]{0,40}): (.+)$/.exec(line);
  if (api && PLAYWRIGHT_OBJECTS.has(api[1]!) && PLAYWRIGHT_METHODS.has(api[2]!)) {
    return failed(playwrightApiCause(`${api[1]}.${api[2]}`, api[2]!, api[3]!));
  }
  const engineName = engineMessageName(line);
  if (engineName) return failed(makeCause(withoutVariableErrorText(line), engineName));
  if (FIXED_RUNTIME_MESSAGES.some((message) => message.test(line))) return failed(makeCause(line));
  return failed(makeCause(WITHHELD_ERROR[source]));
}
