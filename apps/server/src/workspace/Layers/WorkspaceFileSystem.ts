import nodeFs from "node:fs/promises";
import nodePath from "node:path";

import type { ProjectApplyStyleEditInput, ProjectApplyTextEditInput } from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspaceFileSystem,
  WorkspaceFileSystemError,
  type WorkspaceFileSystemShape,
} from "../Services/WorkspaceFileSystem";
import { WorkspaceEntries } from "../Services/WorkspaceEntries";
import { WorkspacePaths } from "../Services/WorkspacePaths";

const TEXT_EDIT_MAX_FILES = 2_500;
const TEXT_EDIT_MAX_FILE_BYTES = 1_000_000;
const TEXT_EDIT_SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".less",
  ".mdx",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
]);
const TEXT_EDIT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".synara",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

type ProjectStylePatch = ProjectApplyStyleEditInput["patch"];
type ProjectTextEditElement = NonNullable<ProjectApplyTextEditInput["element"]>;

const JSX_STYLE_EXTENSIONS = new Set([".js", ".jsx", ".mdx", ".ts", ".tsx"]);
const STYLE_EDIT_ATTRIBUTE_PRIORITY = ["id", "data-testid", "aria-label", "class", "className"];
const STYLE_PATCH_CSS_PROPERTIES: Partial<Record<keyof ProjectStylePatch, string>> = {
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

interface StyleEditCandidate {
  absolutePath: string;
  content: string;
  openEnd: number;
  openStart: number;
  relativePath: string;
  score: number;
}

interface TextEditSourceMatch {
  absolutePath: string;
  content: string;
  occurrences: number;
  relativePath: string;
}

function toRelativeWorkspacePath(cwd: string, absolutePath: string): string {
  return nodePath.relative(cwd, absolutePath).replaceAll(nodePath.sep, "/");
}

function countTextOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    if (count > 1) {
      return count;
    }
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedStylePatchEntries(
  patch: ProjectStylePatch,
): Array<[keyof ProjectStylePatch, string]> {
  const entries: Array<[keyof ProjectStylePatch, string]> = [];
  for (const [key, value] of Object.entries(patch) as Array<
    [keyof ProjectStylePatch, string | undefined]
  >) {
    if (key === "effectTarget") continue;
    const trimmed = value?.trim();
    if (trimmed) {
      entries.push([key, trimmed]);
    }
  }
  return entries;
}

function stylePatchCssDeclarations(patch: ProjectStylePatch): Array<[string, string]> {
  return normalizedStylePatchEntries(patch)
    .map(([key, value]) => {
      const cssProperty = STYLE_PATCH_CSS_PROPERTIES[key];
      return cssProperty ? ([cssProperty, value] as const) : null;
    })
    .filter((entry): entry is [string, string] => entry !== null);
}

function updateCssStyleValue(currentStyle: string, patch: ProjectStylePatch): string {
  const declarations = new Map<string, string>();
  for (const part of currentStyle.split(";")) {
    const colonIndex = part.indexOf(":");
    if (colonIndex === -1) continue;
    const property = part.slice(0, colonIndex).trim();
    const value = part.slice(colonIndex + 1).trim();
    if (property && value) declarations.set(property, value);
  }
  for (const [property, value] of stylePatchCssDeclarations(patch)) {
    declarations.set(property, value);
  }
  return Array.from(declarations, ([property, value]) => `${property}: ${value};`).join(" ");
}

function updateJsxStyleObject(currentStyle: string, patch: ProjectStylePatch): string {
  let body = currentStyle.trim().replace(/,\s*$/, "");
  for (const [key, value] of normalizedStylePatchEntries(patch)) {
    const nextEntry = `${key}: ${JSON.stringify(value)}`;
    const propertyPattern = new RegExp(
      `(^|[,\\s])(${escapeRegExp(String(key))}\\s*:\\s*)(?:"[^"]*"|'[^']*'|\`[^\`]*\`|[^,}]+)`,
      "m",
    );
    body = propertyPattern.test(body)
      ? body.replace(propertyPattern, (_match, prefix: string) => `${prefix}${nextEntry}`)
      : body.length
        ? `${body}, ${nextEntry}`
        : nextEntry;
  }
  return body;
}

function insertAttributeIntoOpeningTag(openingTag: string, attribute: string): string {
  const insertIndex = openingTag.endsWith("/>")
    ? openingTag.length - 2
    : openingTag.endsWith(">")
      ? openingTag.length - 1
      : openingTag.length;
  return `${openingTag.slice(0, insertIndex)} ${attribute}${openingTag.slice(insertIndex)}`;
}

function patchOpeningTagStyle(
  openingTag: string,
  patch: ProjectStylePatch,
  extension: string,
): string {
  const isJsx = JSX_STYLE_EXTENSIONS.has(extension);
  if (isJsx) {
    const jsxStyleMatch = openingTag.match(/\sstyle\s*=\s*\{\{([\s\S]*?)\}\}/);
    if (jsxStyleMatch?.[0] && jsxStyleMatch[1] !== undefined) {
      return openingTag.replace(
        jsxStyleMatch[0],
        ` style={{ ${updateJsxStyleObject(jsxStyleMatch[1], patch)} }}`,
      );
    }
    if (/\sstyle\s*=\s*\{/.test(openingTag)) {
      throw new Error(
        "Selected element uses a dynamic style expression that cannot be edited safely.",
      );
    }
    return insertAttributeIntoOpeningTag(
      openingTag,
      `style={{ ${updateJsxStyleObject("", patch)} }}`,
    );
  }

  const styleAttributeMatch = openingTag.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/);
  if (styleAttributeMatch?.[0] && styleAttributeMatch[2] !== undefined) {
    return openingTag.replace(
      styleAttributeMatch[0],
      ` style=${styleAttributeMatch[1]}${updateCssStyleValue(styleAttributeMatch[2], patch)}${styleAttributeMatch[1]}`,
    );
  }
  return insertAttributeIntoOpeningTag(openingTag, `style="${updateCssStyleValue("", patch)}"`);
}

function findOpeningTagBefore(content: string, tagName: string, beforeIndex: number) {
  const tagPattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  let best: { openEnd: number; openStart: number } | null = null;
  while ((match = tagPattern.exec(content)) && match.index < beforeIndex) {
    const openEnd = match.index + match[0].length;
    if (openEnd <= beforeIndex) best = { openStart: match.index, openEnd };
  }
  return best;
}

function attributeValuePattern(name: string, value: string): RegExp {
  return new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(["'])${escapeRegExp(value)}\\1`, "i");
}

function scoreOpeningTagByAttributes(
  openingTag: string,
  attributes: Record<string, string>,
): number {
  let score = 0;
  for (const name of STYLE_EDIT_ATTRIBUTE_PRIORITY) {
    const value = attributes[name]?.trim();
    if (!value) continue;
    if (name === "class" || name === "className") {
      const classValue = attributes.class?.trim() || attributes.className?.trim() || "";
      const sourceMatch =
        openingTag.match(/\sclassName\s*=\s*(["'])([\s\S]*?)\1/i) ??
        openingTag.match(/\sclass\s*=\s*(["'])([\s\S]*?)\1/i);
      const sourceClasses = new Set((sourceMatch?.[2] ?? "").split(/\s+/).filter(Boolean));
      const overlap = classValue.split(/\s+/).filter((className) => sourceClasses.has(className));
      score += Math.min(overlap.length, 4);
      continue;
    }
    if (attributeValuePattern(name, value).test(openingTag)) {
      score += name === "id" ? 8 : 4;
    }
  }
  return score;
}

function addStyleEditCandidate(
  candidates: Map<string, StyleEditCandidate>,
  candidate: StyleEditCandidate,
): void {
  const key = `${candidate.absolutePath}:${candidate.openStart}`;
  const existing = candidates.get(key);
  if (!existing || candidate.score > existing.score) {
    candidates.set(key, candidate);
  }
}

function findStyleEditCandidates(input: {
  absolutePath: string;
  attributes: Record<string, string>;
  content: string;
  relativePath: string;
  tagName: string;
  text: string;
}): StyleEditCandidate[] {
  const candidates = new Map<string, StyleEditCandidate>();
  const tagName = input.tagName.toLowerCase();
  if (input.text) {
    let textIndex = input.content.indexOf(input.text);
    while (textIndex !== -1) {
      const openingTag = findOpeningTagBefore(input.content, tagName, textIndex);
      if (openingTag) {
        addStyleEditCandidate(candidates, {
          absolutePath: input.absolutePath,
          content: input.content,
          openEnd: openingTag.openEnd,
          openStart: openingTag.openStart,
          relativePath: input.relativePath,
          score:
            10 +
            scoreOpeningTagByAttributes(
              input.content.slice(openingTag.openStart, openingTag.openEnd),
              input.attributes,
            ),
        });
      }
      textIndex = input.content.indexOf(input.text, textIndex + input.text.length);
    }
  }

  const tagPattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(input.content))) {
    const attributeScore = scoreOpeningTagByAttributes(match[0], input.attributes);
    if (attributeScore > 0) {
      addStyleEditCandidate(candidates, {
        absolutePath: input.absolutePath,
        content: input.content,
        openEnd: match.index + match[0].length,
        openStart: match.index,
        relativePath: input.relativePath,
        score: attributeScore,
      });
    }
  }
  return Array.from(candidates.values());
}

function encodeMarkupText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("{", "&#123;")
    .replaceAll("}", "&#125;");
}

function normalizeRenderedText(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&#123;", "{")
    .replaceAll("&#125;", "}")
    .replace(/\s+/g, " ")
    .trim();
}

function findClosingTagAfter(content: string, tagName: string, openEnd: number) {
  const tagPattern = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = openEnd;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(content))) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth -= 1;
    } else if (!/\/\s*>$/.test(tag)) {
      depth += 1;
    }
    if (depth === 0) {
      return { closeStart: match.index, closeEnd: match.index + tag.length };
    }
  }
  return null;
}

function replaceElementBodyText(input: {
  candidate: StyleEditCandidate;
  nextText: string;
  originalText: string;
  tagName: string;
}): string {
  const openingTag = input.candidate.content.slice(
    input.candidate.openStart,
    input.candidate.openEnd,
  );
  if (/\/\s*>$/.test(openingTag)) {
    throw new Error("Selected element is self-closing and has no source text to edit.");
  }

  const closingTag = findClosingTagAfter(
    input.candidate.content,
    input.tagName,
    input.candidate.openEnd,
  );
  if (!closingTag) {
    throw new Error("Could not find the selected element closing tag in source.");
  }

  const body = input.candidate.content.slice(input.candidate.openEnd, closingTag.closeStart);
  const occurrences = countTextOccurrences(body, input.originalText);
  let nextBody: string;
  if (occurrences === 1) {
    nextBody = body.replace(input.originalText, input.nextText);
  } else if (occurrences > 1) {
    throw new Error("Selected text appears multiple times inside the matched element.");
  } else {
    const hasNestedMarkupOrExpression = /<[A-Za-z/!]|[{}]/.test(body);
    if (
      hasNestedMarkupOrExpression ||
      normalizeRenderedText(body) !== normalizeRenderedText(input.originalText)
    ) {
      throw new Error("Could not map the edited text to a safe source text node.");
    }
    const leadingWhitespace = body.match(/^\s*/)?.[0] ?? "";
    const trailingWhitespace = body.match(/\s*$/)?.[0] ?? "";
    nextBody = `${leadingWhitespace}${encodeMarkupText(input.nextText)}${trailingWhitespace}`;
  }

  if (body === nextBody) {
    throw new Error("Text edit did not change the matched source element.");
  }

  return `${input.candidate.content.slice(0, input.candidate.openEnd)}${nextBody}${input.candidate.content.slice(closingTag.closeStart)}`;
}

function chooseBestElementCandidate(candidates: StyleEditCandidate[]): StyleEditCandidate {
  if (candidates.length === 0) {
    throw new Error("Could not confidently find the selected element in project source.");
  }
  candidates.sort((first, second) => second.score - first.score);
  const [best, second] = candidates;
  if (!best || (second && second.score === best.score)) {
    throw new Error("Selected element maps to multiple possible source locations.");
  }
  return best;
}

async function findTextEditMatches(
  root: string,
  originalText: string,
): Promise<TextEditSourceMatch[]> {
  const files = await collectTextEditSourceFiles(root);
  const matches: TextEditSourceMatch[] = [];

  for (const absolutePath of files) {
    const content = await nodeFs.readFile(absolutePath, "utf8");
    const occurrences = countTextOccurrences(content, originalText);
    if (occurrences > 0) {
      matches.push({
        absolutePath,
        content,
        occurrences,
        relativePath: toRelativeWorkspacePath(root, absolutePath),
      });
    }
  }

  return matches;
}

async function applyElementScopedTextEdit(input: {
  element: ProjectTextEditElement;
  nextText: string;
  originalText: string;
  root: string;
}): Promise<{ relativePath: string; replacements: 1 } | null> {
  const files = await collectTextEditSourceFiles(input.root);
  const candidates: StyleEditCandidate[] = [];
  const attributes = input.element.attributes ?? {};
  const tagName = input.element.tagName.toLowerCase();
  const text = input.originalText.trim() || input.element.text?.trim() || "";

  for (const absolutePath of files) {
    const content = await nodeFs.readFile(absolutePath, "utf8");
    candidates.push(
      ...findStyleEditCandidates({
        absolutePath,
        attributes,
        content,
        relativePath: toRelativeWorkspacePath(input.root, absolutePath),
        tagName,
        text,
      }),
    );
  }

  if (candidates.length === 0) {
    return null;
  }

  const best = chooseBestElementCandidate(candidates);
  const nextContent = replaceElementBodyText({
    candidate: best,
    nextText: input.nextText,
    originalText: input.originalText,
    tagName,
  });
  await nodeFs.writeFile(best.absolutePath, nextContent, "utf8");
  return { relativePath: best.relativePath, replacements: 1 };
}

async function collectTextEditSourceFiles(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const stack = [cwd];

  while (stack.length > 0 && files.length <= TEXT_EDIT_MAX_FILES) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }

    const entries = await nodeFs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!TEXT_EDIT_IGNORED_DIRECTORIES.has(entry.name)) {
          stack.push(nodePath.join(directory, entry.name));
        }
        continue;
      }
      if (!entry.isFile() || !TEXT_EDIT_SOURCE_EXTENSIONS.has(nodePath.extname(entry.name))) {
        continue;
      }
      const absolutePath = nodePath.join(directory, entry.name);
      const stat = await nodeFs.stat(absolutePath);
      if (stat.size <= TEXT_EDIT_MAX_FILE_BYTES) {
        files.push(absolutePath);
      }
    }
  }

  if (files.length > TEXT_EDIT_MAX_FILES) {
    throw new Error("Too many source files to safely apply this live text edit.");
  }

  return files;
}

export const makeWorkspaceFileSystem = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries;

  const writeFile: WorkspaceFileSystemShape["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.makeDirectory",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            relativePath: input.relativePath,
            operation: "workspaceFileSystem.writeFile",
            detail: cause.message,
            cause,
          }),
      ),
    );
    yield* workspaceEntries.invalidate(input.cwd);
    return { relativePath: target.relativePath };
  });

  const applyTextEdit: WorkspaceFileSystemShape["applyTextEdit"] = Effect.fn(
    "WorkspaceFileSystem.applyTextEdit",
  )(function* (input) {
    const normalizedRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            operation: "workspaceFileSystem.applyTextEdit",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const result = yield* Effect.tryPromise({
      try: async () => {
        if (input.element) {
          const scopedResult = await applyElementScopedTextEdit({
            element: input.element,
            nextText: input.nextText,
            originalText: input.originalText,
            root: normalizedRoot,
          });
          if (scopedResult) {
            return scopedResult;
          }
        }

        const matches = await findTextEditMatches(normalizedRoot, input.originalText);
        const totalOccurrences = matches.reduce((total, match) => total + match.occurrences, 0);
        if (totalOccurrences === 0) {
          throw new Error("Could not find the selected text in project source files.");
        }
        if (totalOccurrences > 1 || matches.length !== 1) {
          throw new Error("Selected text appears in multiple source locations.");
        }

        const match = matches[0];
        if (!match) {
          throw new Error("Could not find the selected text in project source files.");
        }
        await nodeFs.writeFile(
          match.absolutePath,
          match.content.replace(input.originalText, input.nextText),
          "utf8",
        );
        return { relativePath: match.relativePath, replacements: 1 };
      },
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          operation: "workspaceFileSystem.applyTextEdit",
          detail: cause instanceof Error ? cause.message : "Could not apply text edit.",
          cause,
        }),
    });

    yield* workspaceEntries.invalidate(input.cwd);
    return result;
  });

  const applyStyleEdit: WorkspaceFileSystemShape["applyStyleEdit"] = Effect.fn(
    "WorkspaceFileSystem.applyStyleEdit",
  )(function* (input) {
    const normalizedRoot = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemError({
            cwd: input.cwd,
            operation: "workspaceFileSystem.applyStyleEdit",
            detail: cause.message,
            cause,
          }),
      ),
    );

    const result = yield* Effect.tryPromise({
      try: async () => {
        if (input.patch.effectTarget && input.patch.effectTarget !== "element") {
          throw new Error("Source edits for pseudo-element effects are not supported yet.");
        }
        if (normalizedStylePatchEntries(input.patch).length === 0) {
          throw new Error("No style changes to apply.");
        }

        const files = await collectTextEditSourceFiles(normalizedRoot);
        const candidates: StyleEditCandidate[] = [];
        const attributes = input.element.attributes ?? {};
        const tagName = input.element.tagName.toLowerCase();
        const text = input.element.text?.trim() ?? "";

        for (const absolutePath of files) {
          const content = await nodeFs.readFile(absolutePath, "utf8");
          candidates.push(
            ...findStyleEditCandidates({
              absolutePath,
              attributes,
              content,
              relativePath: toRelativeWorkspacePath(normalizedRoot, absolutePath),
              tagName,
              text,
            }),
          );
        }

        if (candidates.length === 0) {
          throw new Error("Could not confidently find the selected element in project source.");
        }

        candidates.sort((first, second) => second.score - first.score);
        const [best, second] = candidates;
        if (!best || (second && second.score === best.score)) {
          throw new Error("Selected element maps to multiple possible source locations.");
        }

        const openingTag = best.content.slice(best.openStart, best.openEnd);
        const nextOpeningTag = patchOpeningTagStyle(
          openingTag,
          input.patch,
          nodePath.extname(best.absolutePath),
        );
        if (openingTag === nextOpeningTag) {
          throw new Error("Style edit did not change the matched source element.");
        }

        await nodeFs.writeFile(
          best.absolutePath,
          `${best.content.slice(0, best.openStart)}${nextOpeningTag}${best.content.slice(best.openEnd)}`,
          "utf8",
        );
        return { relativePath: best.relativePath, replacements: 1 };
      },
      catch: (cause) =>
        new WorkspaceFileSystemError({
          cwd: input.cwd,
          operation: "workspaceFileSystem.applyStyleEdit",
          detail: cause instanceof Error ? cause.message : "Could not apply style edit.",
          cause,
        }),
    });

    yield* workspaceEntries.invalidate(input.cwd);
    return result;
  });

  return { writeFile, applyTextEdit, applyStyleEdit } satisfies WorkspaceFileSystemShape;
});

export const WorkspaceFileSystemLive = Layer.effect(WorkspaceFileSystem, makeWorkspaceFileSystem);
