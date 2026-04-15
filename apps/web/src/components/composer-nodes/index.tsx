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

import {
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  type TerminalContextDraft,
} from "~/lib/terminalContext";
import { basenameOfPath, getVscodeIconUrlForEntry, inferEntryKindFromPath } from "~/vscode-icons";
import {
  COMPOSER_INLINE_CHIP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_SVG,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_SVG,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { ComposerPendingTerminalContextChip } from "../chat/ComposerPendingTerminalContexts";

// ── Serialized Types ──────────────────────────────────────────────────

export type SerializedComposerMentionNode = Spread<
  {
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
    task: string;
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

function renderMentionChipDom(container: HTMLElement, pathValue: string): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  const theme = resolvedThemeFromDocument();
  const icon = document.createElement("img");
  icon.alt = "";
  icon.ariaHidden = "true";
  icon.className = COMPOSER_INLINE_CHIP_ICON_CLASS_NAME;
  icon.loading = "lazy";
  icon.src = getVscodeIconUrlForEntry(pathValue, inferEntryKindFromPath(pathValue), theme);

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

function renderAgentMentionChipDom(container: HTMLElement, alias: string, task: string): void {
  container.textContent = "";
  container.style.setProperty("user-select", "none");
  container.style.setProperty("-webkit-user-select", "none");

  const icon = document.createElement("span");
  icon.ariaHidden = "true";
  icon.className = COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME;
  icon.innerHTML = COMPOSER_INLINE_AGENT_CHIP_ICON_SVG;

  const label = document.createElement("span");
  label.className = COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME;
  // Show @alias with truncated task preview
  const taskPreview = task.length > 20 ? `${task.slice(0, 20)}...` : task;
  label.textContent = `@${alias}(${taskPreview})`;

  container.append(icon, label);
}

// ── ComposerMentionNode ───────────────────────────────────────────────

export class ComposerMentionNode extends TextNode {
  __path: string;

  static override getType(): string {
    return "composer-mention";
  }

  static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.__path, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerMentionNode): ComposerMentionNode {
    return $createComposerMentionNode(serializedNode.path);
  }

  constructor(path: string, key?: NodeKey) {
    const normalizedPath = path.startsWith("@") ? path.slice(1) : path;
    super(`@${normalizedPath}`, key);
    this.__path = normalizedPath;
  }

  override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      path: this.__path,
      type: "composer-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderMentionChipDom(dom, this.__path);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__path !== this.__path) {
      renderMentionChipDom(dom, this.__path);
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

export function $createComposerMentionNode(path: string): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(path));
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
  __task: string;

  static override getType(): string {
    return "composer-agent-mention";
  }

  static override clone(node: ComposerAgentMentionNode): ComposerAgentMentionNode {
    return new ComposerAgentMentionNode(node.__alias, node.__task, node.__key);
  }

  static override importJSON(
    serializedNode: SerializedComposerAgentMentionNode,
  ): ComposerAgentMentionNode {
    return $createComposerAgentMentionNode(serializedNode.alias, serializedNode.task);
  }

  constructor(alias: string, task: string, key?: NodeKey) {
    // The text content is the full @alias(task) for proper serialization
    super(`@${alias}(${task})`, key);
    this.__alias = alias;
    this.__task = task;
  }

  override exportJSON(): SerializedComposerAgentMentionNode {
    return {
      ...super.exportJSON(),
      alias: this.__alias,
      task: this.__task,
      type: "composer-agent-mention",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME;
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderAgentMentionChipDom(dom, this.__alias, this.__task);
    return dom;
  }

  override updateDOM(
    prevNode: ComposerAgentMentionNode,
    dom: HTMLElement,
    _config: EditorConfig,
  ): boolean {
    dom.contentEditable = "false";
    if (prevNode.__alias !== this.__alias || prevNode.__task !== this.__task) {
      renderAgentMentionChipDom(dom, this.__alias, this.__task);
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
  task: string,
): ComposerAgentMentionNode {
  return $applyNodeReplacement(new ComposerAgentMentionNode(alias, task));
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
