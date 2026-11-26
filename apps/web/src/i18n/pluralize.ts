import { pluralize as sourcePluralize } from "@synara/shared/text";

import { t } from ".";

// Only authored UI noun tokens are translated. Unknown data stays source text.
// Prefer complete count messages for new UI sentences so every locale owns word order.
const UI_COUNT_UNIT_KEYS: Readonly<Record<string, string>> = {
  task: "common:countUnitTask",
  agent: "common:countUnitAgent",
  subagent: "common:countUnitSubagent",
  thread: "common:countUnitThread",
  conversation: "common:countUnitConversation",
  update: "common:countUnitUpdate",
  terminal: "common:countUnitTerminal",
  file: "common:countUnitFile",
  prompt: "common:countUnitPrompt",
  "pull request": "common:countUnitPullRequest",
  "automation run": "common:countUnitAutomationRun",
  selection: "common:countUnitSelection",
  call: "common:countUnitCall",
  action: "common:countUnitAction",
  command: "common:countUnitCommand",
  page: "common:countUnitPage",
  tool: "common:countUnitTool",
  "tool call": "common:countUnitToolCall",
  comment: "common:countUnitComment",
  other: "common:countUnitOther",
  annotation: "common:countUnitAnnotation",
  "task needs": "common:countUnitTaskNeeds",
  "thread needs": "common:countUnitThreadNeeds",
  "thread was": "common:countUnitThreadWas",
  "conversation is": "common:countUnitConversationIs",
  has: "common:countUnitHas",
  it: "common:countUnitIt",
};

/** UI-only nouns. Protocols and agent context keep using the shared source utility. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  const key = Object.hasOwn(UI_COUNT_UNIT_KEYS, singular)
    ? UI_COUNT_UNIT_KEYS[singular]
    : undefined;
  return key ? t(key, { count }) : sourcePluralize(count, singular, plural);
}
