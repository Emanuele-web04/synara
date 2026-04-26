/**
 * Composer Lexical Nodes
 *
 * Custom nodes for the composer editor:
 * - ComposerMentionNode: File/path mentions (@path)
 * - ComposerSkillNode: Skill mentions ($skill or /skill)
 * - ComposerAgentMentionNode: Agent mentions (@alias(task))
 * - ComposerTerminalContextNode: Terminal context blocks
 */

import {
  $applyNodeReplacement,
  DecoratorNode,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedLexicalNode,
  type SerializedTextNode,
  type Spread,
} from "lexical";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RiRobot3Line } from "react-icons/ri";

import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { basenameOfPath } from "~/file-icons";
import {
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_SVG,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { ComposerPendingTerminalContextChip } from "../chat/ComposerPendingTerminalContexts";
import { createMentionChipIconElement, type MentionChipKind } from "../chat/MentionChipIcon";

// ── Serialized Types ──────────────────────────────────────────────────

export type SerializedComposerMentionNode = Spread<
  {
    kind?: MentionChipKind;
    path: string;
    type: "composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerAgentMentionNode = Spread<
  {
    alias: string;
    color: string;
    type: "composer-agent-mention";
    version: 1;
  },
  SerializedTextNode
>;

export type SerializedComposerTerminalContextNode = Spread<
  {
    context: TerminalContextDraft;
    type: "composer-terminal-context";
    version: 1;
  },
  SerializedLexicalNode
>;

// ── Helper Functions ──────────────────────────────────────────────────

function resolvedThemeFromDocument(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function renderMentionChipDom(
  container: HTMLElement,
  pathValue: string,
  kind: MentionChipKind,
): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  const icon = createMentionChipIconElement(pathValue, resolvedThemeFromDocument(), kind);

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = basenameOfPath(pathValue);

  container.append(icon, label);
}

function renderSkillChipDom(container: HTMLElement, name: string): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  const icon = document.createElement("span");
  icon.ariaHidden = "true";
  icon.className = COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME;
  icon.innerHTML = COMPOSER_INLINE_SKILL_CHIP_ICON_SVG;

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = formatComposerSkillChipLabel(name);

  container.append(icon, label);
}

const AGENT_ROBOT_ICON_SVG = renderToStaticMarkup(
  <RiRobot3Line aria-hidden="true" className={COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME} />,
);

// Color mapping for agent aliases (Tailwind color classes)
const DEFAULT_AGENT_COLOR = { bg: "rgb(245 158 11 / 0.15)", text: "rgb(245 158 11)" };
const AGENT_COLOR_STYLES: Record<string, { bg: string; text: string }> = {
  violet: { bg: "rgb(139 92 246 / 0.15)", text: "rgb(139 92 246)" },
  fuchsia: { bg: "rgb(217 70 239 / 0.15)", text: "rgb(217 70 239)" },
  teal: { bg: "rgb(20 184 166 / 0.15)", text: "rgb(20 184 166)" },
  cyan: { bg: "rgb(6 182 212 / 0.15)", text: "rgb(6 182 212)" },
  amber: DEFAULT_AGENT_COLOR,
  orange: { bg: "rgb(249 115 22 / 0.15)", text: "rgb(249 115 22)" },
};

function renderAgentMentionChipDom(container: HTMLElement, alias: string, color: string): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  // Apply color-specific styles
  const colorStyles = AGENT_COLOR_STYLES[color] ?? DEFAULT_AGENT_COLOR;
  container.style.backgroundColor = colorStyles.bg;
  container.style.color = colorStyles.text;

  const icon = document.createElement("span");
  icon.ariaHidden = "true";
  icon.className = COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME;
  icon.innerHTML = AGENT_ROBOT_ICON_SVG;

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  label.textContent = `@${alias}`;

  container.append(icon, label);
}

// ── ComposerMentionNode ───────────────────────────────────────────────

export class ComposerMentionNode extends TextNode {
  __kind: MentionChipKind;
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__kind, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path, serializedNode.kind);
  }

  constructor(path: string, kind: MentionChipKind = "path", key?: NodeKey) {
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    super(`@${normalizedPath}`, key);
    this.__path = normalizedPath;
    this.__kind = kind;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      kind: this.__kind,
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderMentionChipDom(dom, this.__path, this.__kind);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (
      prevNode.__text !== this.__text ||
      prevNode.__path !== this.__path ||
      prevNode.__kind !== this.__kind
    ) {
      renderMentionChipDom(dom, this.__path, this.__kind);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerMentionNode(
  path: string,
  kind: MentionChipKind = "path",
): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path, kind));
}

// ── ComposerSkillNode ─────────────────────────────────────────────────

export class ComposerSkillNode extends TextNode {
  __skillName: string;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(node.__skillName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(serializedNode.skillName);
  }

  constructor(name: string, key?: NodeKey) {
    const normalizedName = name.startsWith("$") || name.startsWith("/") ? name.slice(1) : name;
    const prefix = name.startsWith("/") ? "/" : "$";
    super(`${prefix}${normalizedName}`, key);
    this.__skillName = normalizedName;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderSkillChipDom(dom, this.__skillName);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerSkillNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__skillName !== this.__skillName) {
      renderSkillChipDom(dom, this.__skillName);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerSkillNode(name: string): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(name));
}

// ── ComposerAgentMentionNode ──────────────────────────────────────────

export class ComposerAgentMentionNode extends TextNode {
  __alias: string;
  __color: string;

  static override getType(): string {
    return "composer-agent-mention";
  }

  static override clone(node: ComposerAgentMentionNode): ComposerAgentMentionNode {
    return new ComposerAgentMentionNode(node.__alias, node.__color, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerAgentMentionNode,
  ): ComposerAgentMentionNode {
    return $createComposerAgentMentionNode(serializedNode.alias, serializedNode.color);
  }

  constructor(alias: string, color: string, key?: NodeKey) {
    // The text content is just @alias - parentheses are regular text
    super(`@${alias}`, key);
    this.__alias = alias;
    this.__color = color;
  }

  override exportJSON(): SerializedComposerAgentMentionNode {
    return {
      ...super.exportJSON(),
      alias: this.__alias,
      color: this.__color,
      type: "composer-agent-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderAgentMentionChipDom(dom, this.__alias, this.__color);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerAgentMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__alias !== this.__alias || prevNode.__color !== this.__color) {
      renderAgentMentionChipDom(dom, this.__alias, this.__color);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): false {
    return false;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerAgentMentionNode(
  alias: string,
  color: string,
): ComposerAgentMentionNode {
  return $applyNodeReplacement(new ComposerAgentMentionNode(alias, color));
}

// ── ComposerTerminalContextNode ───────────────────────────────────────

function ComposerTerminalContextDecorator(props: { context: TerminalContextDraft }) {
  return <ComposerPendingTerminalContextChip context={props.context} />;
}

export class ComposerTerminalContextNode extends DecoratorNode<ReactElement> {
  __context: TerminalContextDraft;

  static override getType(): string {
    return "composer-terminal-context";
  }

  static override clone(node: ComposerTerminalContextNode): ComposerTerminalContextNode {
    return new ComposerTerminalContextNode(node.__context, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerTerminalContextNode,
  ): ComposerTerminalContextNode {
    return $createComposerTerminalContextNode(serializedNode.context);
  }

  constructor(context: TerminalContextDraft, key?: NodeKey) {
    super(key);
    this.__context = context;
  }

  override exportJSON(): SerializedComposerTerminalContextNode {
    return {
      ...super.exportJSON(),
      context: this.__context,
      type: "composer-terminal-context",
      version: 1,
    };
  }

  override createDOM(): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "inline-flex align-middle leading-none";
    return dom;
  }

  override updateDOM(): false {
    return false;
  }

  override getTextContent(): string {
    return INLINE_TERMINAL_CONTEXT_PLACEHOLDER;
  }

  override isInline(): true {
    return true;
  }

  override decorate(): ReactElement {
    return <ComposerTerminalContextDecorator context={this.__context} />;
  }
}

export function $createComposerTerminalContextNode(
  context: TerminalContextDraft,
): ComposerTerminalContextNode {
  return $applyNodeReplacement(new ComposerTerminalContextNode(context));
}

// ── Type Guards & Utilities ───────────────────────────────────────────

export type ComposerInlineTokenNode =
  | ComposerMentionNode
  | ComposerSkillNode
  | ComposerTerminalContextNode
  | ComposerAgentMentionNode;

export function isComposerInlineTokenNode(
  candidate: unknown,
): candidate is ComposerInlineTokenNode {
  return (
    candidate instanceof ComposerMentionNode ||
    candidate instanceof ComposerSkillNode ||
    candidate instanceof ComposerTerminalContextNode ||
    candidate instanceof ComposerAgentMentionNode
  );
}

/** All node classes for Lexical registration */
export const COMPOSER_NODE_CLASSES = [
  ComposerMentionNode,
  ComposerSkillNode,
  ComposerTerminalContextNode,
  ComposerAgentMentionNode,
] as const;
