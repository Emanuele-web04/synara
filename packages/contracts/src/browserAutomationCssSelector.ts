import { Schema } from "effect";

import { BoundedUtf8String } from "./browserAutomationBounds";

const MAX_SELECTOR_TOKENS = 512;
const MAX_SELECTOR_NESTING = 16;

const FORBIDDEN_PSEUDOS = new Set([
  "has-text",
  "text",
  "text-is",
  "text-matches",
  "nth-match",
  "right-of",
  "left-of",
  "above",
  "below",
  "near",
  "visible",
]);

const SIMPLE_PSEUDOS = new Set([
  "active",
  "any-link",
  "autofill",
  "blank",
  "checked",
  "default",
  "defined",
  "disabled",
  "empty",
  "enabled",
  "first-child",
  "first-of-type",
  "focus",
  "focus-visible",
  "focus-within",
  "fullscreen",
  "hover",
  "in-range",
  "indeterminate",
  "invalid",
  "last-child",
  "last-of-type",
  "link",
  "modal",
  "only-child",
  "only-of-type",
  "open",
  "optional",
  "out-of-range",
  "paused",
  "picture-in-picture",
  "placeholder-shown",
  "playing",
  "popover-open",
  "read-only",
  "read-write",
  "required",
  "root",
  "scope",
  "target",
  "target-within",
  "user-invalid",
  "user-valid",
  "valid",
  "visited",
  "after",
  "backdrop",
  "before",
  "cue",
  "cue-region",
  "file-selector-button",
  "first-letter",
  "first-line",
  "marker",
  "placeholder",
  "selection",
]);

const SELECTOR_FUNCTION_PSEUDOS = new Set(["has", "host", "host-context", "is", "not", "where"]);
const NTH_FUNCTION_PSEUDOS = new Set([
  "nth-child",
  "nth-last-child",
  "nth-last-of-type",
  "nth-of-type",
]);
const VALUE_FUNCTION_PSEUDOS = new Set(["dir", "lang", "state"]);

const decodeCssEscapes = (input: string): string | undefined => {
  let output = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (character !== "\\") {
      output += character;
      continue;
    }
    index += 1;
    if (index >= input.length) return undefined;
    const next = input[index]!;
    if (next === "\n" || next === "\r" || next === "\f") return undefined;
    if (/[0-9a-f]/iu.test(next)) {
      let hex = next;
      while (index + 1 < input.length && hex.length < 6 && /[0-9a-f]/iu.test(input[index + 1]!)) {
        index += 1;
        hex += input[index]!;
      }
      if (index + 1 < input.length && /\s/u.test(input[index + 1]!)) index += 1;
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return undefined;
      }
      output += String.fromCodePoint(codePoint);
      continue;
    }
    output += next;
  }
  return output;
};

const isIdentifierStart = (character: string | undefined) =>
  character !== undefined && /[A-Z_a-z\u0080-\uffff-]/u.test(character);
const isIdentifierPart = (character: string | undefined) =>
  character !== undefined && /[0-9A-Z_a-z\u0080-\uffff-]/u.test(character);

class CssSelectorParser {
  private index = 0;
  private tokens = 0;
  private nesting = 0;

  constructor(private readonly source: string) {}

  parse(): boolean {
    if (!this.parseSelectorList()) return false;
    this.skipWhitespace();
    return this.index === this.source.length && this.tokens <= MAX_SELECTOR_TOKENS;
  }

  private token(): boolean {
    this.tokens += 1;
    return this.tokens <= MAX_SELECTOR_TOKENS;
  }

  private skipWhitespace(): boolean {
    const start = this.index;
    while (/\s/u.test(this.source[this.index] ?? "")) this.index += 1;
    return this.index > start;
  }

  private parseSelectorList(stop = "", allowRelative = false): boolean {
    if (!this.parseComplexSelector(stop, allowRelative)) return false;
    while (true) {
      this.skipWhitespace();
      if (this.source[this.index] !== ",") return true;
      this.index += 1;
      if (!this.token()) return false;
      this.skipWhitespace();
      if (!this.parseComplexSelector(stop, allowRelative)) return false;
    }
  }

  private parseComplexSelector(stop: string, allowRelative = false): boolean {
    this.skipWhitespace();
    if (allowRelative && /^[>+~]$/u.test(this.source[this.index] ?? "")) {
      this.index += 1;
      if (!this.token()) return false;
      this.skipWhitespace();
    }
    if (!this.parseCompoundSelector()) return false;
    while (true) {
      const hadWhitespace = this.skipWhitespace();
      const character = this.source[this.index];
      if (character === undefined || character === stop || character === ",") return true;
      if (character === ">" || character === "+" || character === "~") {
        this.index += 1;
        if (!this.token()) return false;
        this.skipWhitespace();
      } else if (!hadWhitespace) {
        return false;
      }
      if (!this.parseCompoundSelector()) return false;
    }
  }

  private parseCompoundSelector(): boolean {
    let consumed = false;
    if (this.source[this.index] === "*") {
      this.index += 1;
      consumed = this.token();
    } else if (isIdentifierStart(this.source[this.index])) {
      consumed = this.parseIdentifier() !== undefined;
    }
    while (true) {
      const character = this.source[this.index];
      if (character === "#" || character === ".") {
        this.index += 1;
        if (!this.token() || this.parseIdentifier() === undefined) return false;
        consumed = true;
      } else if (character === "[") {
        if (!this.parseAttribute()) return false;
        consumed = true;
      } else if (character === ":") {
        if (!this.parsePseudo()) return false;
        consumed = true;
      } else {
        return consumed;
      }
    }
  }

  private parseIdentifier(): string | undefined {
    if (!isIdentifierStart(this.source[this.index])) return undefined;
    const start = this.index;
    this.index += 1;
    while (isIdentifierPart(this.source[this.index])) this.index += 1;
    if (!this.token()) return undefined;
    return this.source.slice(start, this.index).toLowerCase();
  }

  private parseAttribute(): boolean {
    this.index += 1;
    if (!this.enter()) return false;
    this.skipWhitespace();
    if (this.parseIdentifier() === undefined) return false;
    this.skipWhitespace();
    if (this.source[this.index] === "]") return this.leave();
    const operator = ["~=", "|=", "^=", "$=", "*=", "="].find((item) =>
      this.source.startsWith(item, this.index),
    );
    if (operator === undefined) return false;
    this.index += operator.length;
    if (!this.token()) return false;
    this.skipWhitespace();
    if (!this.parseAttributeValue()) return false;
    this.skipWhitespace();
    if (/^[is]$/iu.test(this.source[this.index] ?? "")) {
      this.index += 1;
      if (!this.token()) return false;
      this.skipWhitespace();
    }
    return this.source[this.index] === "]" && this.leave();
  }

  private parseAttributeValue(): boolean {
    const quote = this.source[this.index];
    if (quote === "'" || quote === '"') {
      this.index += 1;
      while (this.index < this.source.length && this.source[this.index] !== quote) {
        if (/[\u0000-\u001f\u007f]/u.test(this.source[this.index]!)) return false;
        this.index += 1;
      }
      if (this.source[this.index] !== quote) return false;
      this.index += 1;
      return this.token();
    }
    return this.parseIdentifier() !== undefined || this.parseNumber();
  }

  private parseNumber(): boolean {
    const match = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)/u.exec(this.source.slice(this.index));
    if (match === null) return false;
    this.index += match[0].length;
    return this.token();
  }

  private parsePseudo(): boolean {
    this.index += 1;
    if (this.source[this.index] === ":") this.index += 1;
    const name = this.parseIdentifier();
    if (name === undefined || FORBIDDEN_PSEUDOS.has(name)) return false;
    if (this.source[this.index] !== "(") return SIMPLE_PSEUDOS.has(name);
    if (
      !SELECTOR_FUNCTION_PSEUDOS.has(name) &&
      !NTH_FUNCTION_PSEUDOS.has(name) &&
      !VALUE_FUNCTION_PSEUDOS.has(name)
    ) {
      return false;
    }
    this.index += 1;
    if (!this.enter()) return false;
    this.skipWhitespace();
    let valid = false;
    if (SELECTOR_FUNCTION_PSEUDOS.has(name)) {
      valid = this.parseSelectorList(")", name === "has");
    } else if (NTH_FUNCTION_PSEUDOS.has(name)) {
      valid = this.parseNthExpression();
    } else {
      valid = this.parseIdentifier() !== undefined;
    }
    this.skipWhitespace();
    return valid && this.source[this.index] === ")" && this.leave();
  }

  private parseNthExpression(): boolean {
    const remaining = this.source.slice(this.index);
    const match = /^(?:even|odd|[+-]?(?:\d*n(?:\s*[+-]\s*\d+)?|\d+))/iu.exec(remaining);
    if (match === null) return false;
    this.index += match[0].length;
    if (!this.token()) return false;
    const saved = this.index;
    this.skipWhitespace();
    if (!/^of\b/iu.test(this.source.slice(this.index))) {
      this.index = saved;
      return true;
    }
    this.index += 2;
    this.skipWhitespace();
    return this.parseSelectorList(")");
  }

  private enter(): boolean {
    this.nesting += 1;
    return this.token() && this.nesting <= MAX_SELECTOR_NESTING;
  }

  private leave(): boolean {
    this.index += 1;
    this.nesting -= 1;
    return this.token();
  }
}

export const isBrowserCssSelector = (value: string): boolean => {
  if (/\/\*|\*\/|[\u0000-\u001f\u007f]/u.test(value)) return false;
  const decoded = decodeCssEscapes(value);
  if (
    decoded === undefined ||
    /\/\*|\*\/|[\u0000-\u001f\u007f]/u.test(decoded) ||
    /^(?:css|text|xpath)\s*=/iu.test(decoded.trim()) ||
    decoded.includes(">>") ||
    /^\/(?:[^/\\]|\\.)+\/[dgimsuvy]*$/u.test(decoded.trim())
  ) {
    return false;
  }
  return new CssSelectorParser(decoded).parse();
};

export const BrowserCssSelector = BoundedUtf8String(4_096, 1)
  .check(Schema.makeFilter(isBrowserCssSelector))
  .pipe(Schema.brand("BrowserCssSelector"));

export type BrowserCssSelector = typeof BrowserCssSelector.Type;
