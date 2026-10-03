import type { KeybindingWhenNode } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  compileKeybindingRule,
  encodeKeybindingRule,
  encodeKeybindingWhen,
  isUnassignedKeybindingRule,
  keybindingRuleIdentity,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
} from "./keybindingRules";

const id = (name: string): KeybindingWhenNode => ({ type: "identifier", name });
const not = (node: KeybindingWhenNode): KeybindingWhenNode => ({ type: "not", node });
const and = (left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode => ({
  type: "and",
  left,
  right,
});
const or = (left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode => ({
  type: "or",
  left,
  right,
});

// Every tree up to depth 3 over two names: enough to cover each operator as the left
// and right operand of every other one, which is where parentheses can go missing.
function treesUpTo(depth: number): KeybindingWhenNode[] {
  if (depth === 0) return [id("a"), id("b")];
  const smaller = treesUpTo(depth - 1);
  const trees = [...smaller, ...smaller.map(not)];
  for (const left of smaller) {
    for (const right of smaller) trees.push(and(left, right), or(left, right));
  }
  return trees;
}

describe("encodeKeybindingWhen", () => {
  it("writes only the parentheses a condition needs", () => {
    expect(encodeKeybindingWhen(or(not(id("terminalFocus")), id("isMac")))).toBe(
      "!terminalFocus || isMac",
    );
    expect(encodeKeybindingWhen(and(id("a"), or(id("b"), id("c"))))).toBe("a && (b || c)");
    expect(encodeKeybindingWhen(not(or(id("a"), id("b"))))).toBe("!(a || b)");
    expect(encodeKeybindingWhen(and(id("a"), and(id("b"), id("c"))))).toBe("a && (b && c)");
  });

  it("parses back to the same tree for every shape", () => {
    for (const tree of treesUpTo(2)) {
      expect(parseKeybindingWhenExpression(encodeKeybindingWhen(tree))).toEqual(tree);
    }
  });
});

describe("keybindingRuleIdentity", () => {
  it("is the same however the config spells a rule", () => {
    const written = { command: "terminal.toggle" as const, key: "Mod+J", when: "(!terminalFocus)" };
    const canonical = { command: "terminal.toggle" as const, key: "mod+j", when: "!terminalFocus" };
    expect(keybindingRuleIdentity(written)).toBe(keybindingRuleIdentity(canonical));
    expect(keybindingRuleIdentity({ command: "chat.new", key: "esc" })).toBe(
      keybindingRuleIdentity({ command: "chat.new", key: "escape" }),
    );
  });

  it("tells apart rules that differ in command, keys, or condition", () => {
    const base = { command: "terminal.toggle" as const, key: "mod+j" };
    expect(keybindingRuleIdentity(base)).not.toBe(
      keybindingRuleIdentity({ ...base, key: "mod+shift+j" }),
    );
    expect(keybindingRuleIdentity(base)).not.toBe(
      keybindingRuleIdentity({ ...base, when: "terminalFocus" }),
    );
    expect(keybindingRuleIdentity(base)).not.toBe(
      keybindingRuleIdentity({ ...base, command: "terminal.split" }),
    );
  });

  it("treats every spelling of the unassigned marker as one rule", () => {
    expect(keybindingRuleIdentity({ command: "terminal.toggle", key: "shift+unassigned" })).toBe(
      keybindingRuleIdentity({ command: "terminal.toggle", key: "unassigned" }),
    );
  });

  it("is null for a rule that does not compile", () => {
    expect(keybindingRuleIdentity({ command: "chat.new", key: "mod+a+b" })).toBeNull();
    expect(keybindingRuleIdentity({ command: "chat.new", key: "mod+n", when: "a &&" })).toBeNull();
  });
});

describe("encodeKeybindingRule", () => {
  it("round-trips through compileKeybindingRule", () => {
    for (const rule of [
      { command: "chat.new" as const, key: "mod+shift+o", when: "!terminalFocus || isMac" },
      { command: "chat.new" as const, key: "ctrl+alt+space" },
      { command: "chat.new" as const, key: "mod++" },
    ]) {
      const compiled = compileKeybindingRule(rule);
      expect(compiled).not.toBeNull();
      expect(compileKeybindingRule(encodeKeybindingRule(compiled!)!)).toEqual(compiled);
    }
  });

  it("keeps the unassigned marker as written", () => {
    const marker = compileKeybindingRule({ command: "terminal.toggle", key: "unassigned" });
    expect(encodeKeybindingRule(marker!)).toEqual({
      command: "terminal.toggle",
      key: "unassigned",
    });
  });
});

describe("isUnassignedKeybindingRule", () => {
  it("recognizes the marker however it is written", () => {
    expect(isUnassignedKeybindingRule({ key: "unassigned" })).toBe(true);
    expect(isUnassignedKeybindingRule({ key: "Unassigned" })).toBe(true);
    expect(isUnassignedKeybindingRule({ key: "shift+unassigned" })).toBe(true);
    expect(isUnassignedKeybindingRule({ key: "mod+u" })).toBe(false);
  });

  it("parses the plus key alone and after modifiers", () => {
    expect(parseKeybindingShortcut("mod++")?.key).toBe("+");
    expect(parseKeybindingShortcut("+")?.key).toBe("+");
  });
});
