// FILE: composerSuggestions.ts
// Purpose: Derives empty-chat prompt suggestions from recent project conversation context.
// Layer: Web composer helper
// Depends on: shared web Thread/Project view models.

import type { Project, Thread } from "../types";

export interface ComposerSuggestion {
  id: string;
  label: string;
  description?: string | undefined;
  prompt: string;
  sourceThreadId?: Thread["id"] | undefined;
}

interface DeriveComposerSuggestionsInput {
  activeThreadId: Thread["id"] | null;
  project: Project | null | undefined;
  threads: readonly Thread[];
}

const MAX_SUGGESTIONS = 3;
const MIN_SUGGESTIONS = 3;
const MAX_PROMPT_LINES = 6;
const MAX_TOPIC_LENGTH = 72;

function normalizeInlineText(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value: string, maxLength: number): string {
  const normalized = normalizeInlineText(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function compactPromptLines(lines: readonly string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_PROMPT_LINES)
    .join("\n");
}

function projectLabel(project: Project | null | undefined): string {
  return (
    project?.localName?.trim() ||
    project?.name?.trim() ||
    project?.folderName?.trim() ||
    "this project"
  );
}

function latestUserPrompt(thread: Thread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (message?.role !== "user") {
      continue;
    }
    const text = normalizeInlineText(message.text);
    if (text.length > 0) {
      return text;
    }
  }
  return null;
}

function threadTopic(thread: Thread): string {
  const title = normalizeInlineText(thread.title);
  if (title.length > 0 && title.toLowerCase() !== "new chat") {
    return truncateText(title, MAX_TOPIC_LENGTH);
  }
  const prompt = latestUserPrompt(thread);
  return prompt ? truncateText(prompt, MAX_TOPIC_LENGTH) : "the recent chat";
}

function threadFreshnessTime(thread: Thread): number {
  const candidates = [thread.latestUserMessageAt, thread.updatedAt, thread.createdAt];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const time = Date.parse(candidate);
    if (!Number.isNaN(time)) {
      return time;
    }
  }
  return 0;
}

function recentProjectThreads(input: DeriveComposerSuggestionsInput): Thread[] {
  const projectId = input.project?.id ?? null;
  if (!projectId) {
    return [];
  }
  return input.threads
    .filter((thread) => {
      if (thread.id === input.activeThreadId) {
        return false;
      }
      if (thread.projectId !== projectId || thread.archivedAt) {
        return false;
      }
      return thread.messages.some((message) => message.role === "user" && message.text.trim());
    })
    .sort((left, right) => threadFreshnessTime(right) - threadFreshnessTime(left))
    .slice(0, 8);
}

function pushUniqueSuggestion(
  suggestions: ComposerSuggestion[],
  suggestion: ComposerSuggestion,
): void {
  const signature = suggestion.label.toLowerCase();
  if (suggestions.some((existing) => existing.label.toLowerCase() === signature)) {
    return;
  }
  suggestions.push(suggestion);
}

export function deriveComposerSuggestions(
  input: DeriveComposerSuggestionsInput,
): ComposerSuggestion[] {
  const suggestions: ComposerSuggestion[] = [];
  const recentThreads = recentProjectThreads(input);
  const label = projectLabel(input.project);
  const [latestThread, secondThread] = recentThreads;

  if (latestThread) {
    const topic = threadTopic(latestThread);
    pushUniqueSuggestion(suggestions, {
      id: `continue:${latestThread.id}`,
      label: `Continue ${topic}`,
      description: "Pick up from the latest related conversation",
      prompt: compactPromptLines([
        `Continue the recent work on ${topic}.`,
        "Use the existing project state and the latest chat context.",
        "Identify the next concrete step, then implement it cleanly.",
      ]),
      sourceThreadId: latestThread.id,
    });
  }

  if (secondThread) {
    const topic = threadTopic(secondThread);
    pushUniqueSuggestion(suggestions, {
      id: `review:${secondThread.id}`,
      label: `Review ${topic} for gaps`,
      description: "Check the previous thread for missing edges",
      prompt: compactPromptLines([
        `Review the recent ${topic} work in ${label}.`,
        "Look for regressions, missing edge cases, and tests that would catch them.",
        "Fix the highest-impact issue first.",
      ]),
      sourceThreadId: secondThread.id,
    });
  }

  if (latestThread && secondThread) {
    pushUniqueSuggestion(suggestions, {
      id: `connect:${latestThread.id}:${secondThread.id}`,
      label: `Connect the last two ${label} threads`,
      description: "Turn recent context into one next step",
      prompt: compactPromptLines([
        `Use the latest ${label} chats as context.`,
        `Connect "${threadTopic(latestThread)}" with "${threadTopic(secondThread)}".`,
        "Summarize the shared goal, then propose and start the next coherent step.",
      ]),
      sourceThreadId: latestThread.id,
    });
  }

  pushUniqueSuggestion(suggestions, {
    id: "project-next-step",
    label: `Find the next best ${label} task`,
    description: "Scan recent work and choose the highest-leverage move",
    prompt: compactPromptLines([
      `Look across the recent ${label} work and current repo state.`,
      "Pick the next high-leverage task, explain why it matters, and start with the safest small change.",
    ]),
  });

  pushUniqueSuggestion(suggestions, {
    id: "project-quality-pass",
    label: `Do a focused quality pass on ${label}`,
    description: "Tighten behavior, polish, and failure states",
    prompt: compactPromptLines([
      `Audit ${label} for the most likely rough edge from recent work.`,
      "Check UI behavior, data flow, and failure states before changing code.",
      "Then fix the smallest thing that improves reliability.",
    ]),
  });

  while (suggestions.length < MIN_SUGGESTIONS) {
    const index = suggestions.length + 1;
    pushUniqueSuggestion(suggestions, {
      id: `starter:${index}`,
      label:
        index === 1
          ? `Plan the next ${label} improvement`
          : index === 2
            ? `Inspect ${label} for a quick win`
            : `Prepare a clean ${label} handoff`,
      description:
        index === 1
          ? "Choose a clear next step"
          : index === 2
            ? "Find one small useful improvement"
            : "Capture context and risks",
      prompt:
        index === 1
          ? compactPromptLines([
              `Review the current ${label} state.`,
              "Suggest a concise next step and begin implementing it.",
            ])
          : index === 2
            ? compactPromptLines([
                `Find one small improvement in ${label}.`,
                "Prefer reliability, polish, or workflow speed.",
              ])
            : compactPromptLines([
                `Summarize what matters in ${label} right now.`,
                "Call out risks, open decisions, and the next implementation step.",
              ]),
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}
