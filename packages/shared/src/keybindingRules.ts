// FILE: keybindingRules.ts
// Purpose: The keybinding rule grammar both the server and the web read and write: parsing
//   `key` and `when` strings, writing them back, rule identity, and the unassigned marker.
// Layer: Shared runtime utility
// Depends on: keybinding contracts only

import {
  MAX_WHEN_EXPRESSION_DEPTH,
  UNASSIGNED_KEYBINDING_KEY,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
} from "@synara/contracts";

type WhenToken =
  | { type: "identifier"; value: string }
  | { type: "not" }
  | { type: "and" }
  | { type: "or" }
  | { type: "lparen" }
  | { type: "rparen" };

function normalizeKeyToken(token: string): string {
  if (token === "space") return " ";
  if (token === "esc") return "escape";
  return token;
}

/** The shortcut a config key string such as `mod+shift+k` stands for, or null when it is not one. */
export function parseKeybindingShortcut(value: string): KeybindingShortcut | null {
  const rawTokens = value
    .toLowerCase()
    .split("+")
    .map((token) => token.trim());
  const tokens = [...rawTokens];
  let trailingEmptyCount = 0;
  while (tokens[tokens.length - 1] === "") {
    trailingEmptyCount += 1;
    tokens.pop();
  }
  if (trailingEmptyCount > 0) {
    tokens.push("+");
  }
  if (tokens.some((token) => token.length === 0)) {
    return null;
  }
  if (tokens.length === 0) return null;

  let key: string | null = null;
  let metaKey = false;
  let ctrlKey = false;
  let shiftKey = false;
  let altKey = false;
  let modKey = false;

  for (const token of tokens) {
    switch (token) {
      case "cmd":
      case "meta":
        metaKey = true;
        break;
      case "ctrl":
      case "control":
        ctrlKey = true;
        break;
      case "shift":
        shiftKey = true;
        break;
      case "alt":
      case "option":
        altKey = true;
        break;
      case "mod":
        modKey = true;
        break;
      default: {
        if (key !== null) return null;
        key = normalizeKeyToken(token);
      }
    }
  }

  if (key === null) return null;
  return {
    key,
    metaKey,
    ctrlKey,
    shiftKey,
    altKey,
    modKey,
  };
}

function tokenizeWhenExpression(expression: string): WhenToken[] | null {
  const tokens: WhenToken[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];
    if (!current) break;

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (expression.startsWith("&&", index)) {
      tokens.push({ type: "and" });
      index += 2;
      continue;
    }
    if (expression.startsWith("||", index)) {
      tokens.push({ type: "or" });
      index += 2;
      continue;
    }
    if (current === "!") {
      tokens.push({ type: "not" });
      index += 1;
      continue;
    }
    if (current === "(") {
      tokens.push({ type: "lparen" });
      index += 1;
      continue;
    }
    if (current === ")") {
      tokens.push({ type: "rparen" });
      index += 1;
      continue;
    }

    const identifier = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(expression.slice(index));
    if (!identifier) {
      return null;
    }
    tokens.push({ type: "identifier", value: identifier[0] });
    index += identifier[0].length;
  }

  return tokens;
}

/** The condition tree a `when` expression stands for, or null when it does not parse. */
export function parseKeybindingWhenExpression(expression: string): KeybindingWhenNode | null {
  const tokens = tokenizeWhenExpression(expression);
  if (!tokens || tokens.length === 0) return null;
  let index = 0;

  const parsePrimary = (depth: number): KeybindingWhenNode | null => {
    if (depth > MAX_WHEN_EXPRESSION_DEPTH) {
      return null;
    }
    const token = tokens[index];
    if (!token) return null;

    if (token.type === "identifier") {
      index += 1;
      return { type: "identifier", name: token.value };
    }

    if (token.type === "lparen") {
      index += 1;
      const expressionNode = parseOr(depth + 1);
      const closeToken = tokens[index];
      if (!expressionNode || !closeToken || closeToken.type !== "rparen") {
        return null;
      }
      index += 1;
      return expressionNode;
    }

    return null;
  };

  const parseUnary = (depth: number): KeybindingWhenNode | null => {
    let notCount = 0;
    while (tokens[index]?.type === "not") {
      index += 1;
      notCount += 1;
      if (notCount > MAX_WHEN_EXPRESSION_DEPTH) {
        return null;
      }
    }

    let node = parsePrimary(depth);
    if (!node) return null;

    while (notCount > 0) {
      node = { type: "not", node };
      notCount -= 1;
    }

    return node;
  };

  const parseAnd = (depth: number): KeybindingWhenNode | null => {
    let left = parseUnary(depth);
    if (!left) return null;

    while (tokens[index]?.type === "and") {
      index += 1;
      const right = parseUnary(depth);
      if (!right) return null;
      left = { type: "and", left, right };
    }

    return left;
  };

  const parseOr = (depth: number): KeybindingWhenNode | null => {
    let left = parseAnd(depth);
    if (!left) return null;

    while (tokens[index]?.type === "or") {
      index += 1;
      const right = parseAnd(depth);
      if (!right) return null;
      left = { type: "or", left, right };
    }

    return left;
  };

  const ast = parseOr(0);
  if (!ast || index !== tokens.length) return null;
  return ast;
}

/** A config rule compiled to the shortcut and condition tree it stands for. */
export function compileKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  const shortcut = parseKeybindingShortcut(rule.key);
  if (!shortcut) return null;
  if (rule.when === undefined) return { command: rule.command, shortcut };
  const whenAst = parseKeybindingWhenExpression(rule.when);
  if (!whenAst) return null;
  return { command: rule.command, shortcut, whenAst };
}

/** The config key string for `shortcut`, or null for a key the grammar cannot spell. */
export function encodeKeybindingShortcut(shortcut: KeybindingShortcut): string | null {
  const modifiers: string[] = [];
  if (shortcut.modKey) modifiers.push("mod");
  if (shortcut.metaKey) modifiers.push("meta");
  if (shortcut.ctrlKey) modifiers.push("ctrl");
  if (shortcut.altKey) modifiers.push("alt");
  if (shortcut.shiftKey) modifiers.push("shift");
  if (!shortcut.key) return null;
  if (shortcut.key !== "+" && shortcut.key.includes("+")) return null;
  const key = shortcut.key === " " ? "space" : shortcut.key;
  return [...modifiers, key].join("+");
}

const WHEN_PRECEDENCE: Record<KeybindingWhenNode["type"], number> = {
  or: 1,
  and: 2,
  not: 3,
  identifier: 4,
};

/**
 * Writes a condition tree back as a `when` expression with only the parentheses it
 * needs (`!terminalFocus || isMac`), and parses back to the same tree: `&&` and `||`
 * group to the left, so a right operand of the same operator keeps its parentheses.
 */
export function encodeKeybindingWhen(node: KeybindingWhenNode): string {
  const operand = (child: KeybindingWhenNode, needsParens: boolean) =>
    needsParens ? `(${encodeKeybindingWhen(child)})` : encodeKeybindingWhen(child);
  const precedence = WHEN_PRECEDENCE[node.type];
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${operand(node.node, WHEN_PRECEDENCE[node.node.type] < precedence)}`;
    case "and":
    case "or":
      return [
        operand(node.left, WHEN_PRECEDENCE[node.left.type] < precedence),
        node.type === "and" ? "&&" : "||",
        operand(node.right, WHEN_PRECEDENCE[node.right.type] <= precedence),
      ].join(" ");
  }
}

/** The config rule for a compiled one, or null when its shortcut cannot be spelled. */
export function encodeKeybindingRule(rule: ResolvedKeybindingRule): KeybindingRule | null {
  const key = isUnassignedKeybindingShortcut(rule.shortcut)
    ? UNASSIGNED_KEYBINDING_KEY
    : encodeKeybindingShortcut(rule.shortcut);
  if (!key) return null;
  return {
    command: rule.command,
    key,
    ...(rule.whenAst ? { when: encodeKeybindingWhen(rule.whenAst) } : {}),
  };
}

/**
 * One string per distinct rule: the same command, shortcut, and condition tree, however
 * the config spelled them (`cmd` or `meta`, `esc` or `escape`, extra parentheses).
 */
export function resolvedKeybindingRuleIdentity(rule: ResolvedKeybindingRule): string {
  // Every spelling of the marker is the same rule, as encodeKeybindingRule writes it.
  const key = isUnassignedKeybindingShortcut(rule.shortcut)
    ? UNASSIGNED_KEYBINDING_KEY
    : (encodeKeybindingShortcut(rule.shortcut) ?? rule.shortcut.key);
  const when = rule.whenAst ? encodeKeybindingWhen(rule.whenAst) : "";
  return `${rule.command}\u0000${key}\u0000${when}`;
}

/** {@link resolvedKeybindingRuleIdentity} for a config rule, or null when it does not compile. */
export function keybindingRuleIdentity(rule: KeybindingRule): string | null {
  const resolved = compileKeybindingRule(rule);
  return resolved ? resolvedKeybindingRuleIdentity(resolved) : null;
}

/**
 * The marker a command's rules hold when the user left it without a shortcut. It keeps
 * the command configured, so no default comes back, and never matches a key press.
 * Any rule whose key is `unassigned` counts, with or without modifiers.
 */
export function isUnassignedKeybindingShortcut(shortcut: Pick<KeybindingShortcut, "key">): boolean {
  return shortcut.key === UNASSIGNED_KEYBINDING_KEY;
}

/** {@link isUnassignedKeybindingShortcut} for a config rule. */
export function isUnassignedKeybindingRule(rule: Pick<KeybindingRule, "key">): boolean {
  const shortcut = parseKeybindingShortcut(rule.key);
  return shortcut !== null && isUnassignedKeybindingShortcut(shortcut);
}
