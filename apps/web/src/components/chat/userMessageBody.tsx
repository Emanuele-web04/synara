// FILE: userMessageBody.tsx
// Purpose: Renders read-only user message text with inline composer-style chips (skills, mentions, agents, terminal context).
// Layer: Web chat presentation component
// Exports: UserMessageBody, renderUserMessageInlineText, hasOnlyInlineSkillChips

import { memo, type CSSProperties, type ReactNode } from "react";
import { MentionChipIcon } from "./MentionChipIcon";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import { type ParsedTerminalContextEntry } from "~/lib/terminalContext";
import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { splitPromptIntoDisplaySegments } from "~/composer-editor-mentions";
import {
  COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME,
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME,
  COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME,
  COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME,
  COMPOSER_INLINE_SKILL_CHIP_ICON_NAME,
  formatComposerSkillChipLabel,
} from "../composerInlineChip";
import { basenameOfPath } from "../../file-icons";
import { CentralIcon } from "../../lib/central-icons";
import { RiRobot3Line } from "react-icons/ri";

const DEFAULT_AGENT_COLOR = { bg: "rgb(245 158 11 / 0.15)", text: "rgb(245 158 11)" };
const AGENT_COLOR_STYLES: Record<string, { bg: string; text: string }> = {
  violet: { bg: "rgb(139 92 246 / 0.15)", text: "rgb(139 92 246)" },
  fuchsia: { bg: "rgb(217 70 239 / 0.15)", text: "rgb(217 70 239)" },
  teal: { bg: "rgb(20 184 166 / 0.15)", text: "rgb(20 184 166)" },
  cyan: { bg: "rgb(6 182 212 / 0.15)", text: "rgb(6 182 212)" },
  amber: DEFAULT_AGENT_COLOR,
  orange: { bg: "rgb(249 115 22 / 0.15)", text: "rgb(249 115 22)" },
};

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageInlineSkillChip = memo(function UserMessageInlineSkillChip(props: {
  skillName: string;
}) {
  return (
    <span className={COMPOSER_INLINE_SKILL_CHIP_CLASS_NAME}>
      <CentralIcon
        name={COMPOSER_INLINE_SKILL_CHIP_ICON_NAME}
        className={COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME}
      />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>
        {formatComposerSkillChipLabel(props.skillName)}
      </span>
    </span>
  );
});

// Renders read-only user text with the same inline skill pill treatment as the composer.
export function renderUserMessageInlineText(
  text: string,
  keyPrefix: string,
  resolvedTheme: "light" | "dark",
): ReactNode[] {
  return splitPromptIntoDisplaySegments(text).flatMap((segment, index) => {
    const key = `${keyPrefix}:${index}`;
    if (segment.type === "text") {
      return segment.text.length > 0 ? [<span key={`${key}:text`}>{segment.text}</span>] : [];
    }
    if (segment.type === "skill") {
      return [<UserMessageInlineSkillChip key={`${key}:skill`} skillName={segment.name} />];
    }
    if (segment.type === "mention") {
      return [
        <UserMessageInlineMentionChip
          key={`${key}:mention`}
          path={segment.path}
          resolvedTheme={resolvedTheme}
        />,
      ];
    }
    if (segment.type === "agent-mention") {
      return [
        <UserMessageInlineAgentChip
          key={`${key}:agent`}
          alias={segment.alias}
          color={segment.color}
        />,
      ];
    }
    return [];
  });
}

const UserMessageInlineMentionChip = memo(function UserMessageInlineMentionChip(props: {
  path: string;
  resolvedTheme: "light" | "dark";
}) {
  const label = basenameOfPath(props.path);
  return (
    <span className={COMPOSER_INLINE_MENTION_CHIP_CLASS_NAME} title={props.path}>
      <MentionChipIcon path={props.path} theme={props.resolvedTheme} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{label}</span>
    </span>
  );
});

export function hasOnlyInlineSkillChips(text: string): boolean {
  const segments = splitPromptIntoDisplaySegments(text);
  let skillCount = 0;

  for (const segment of segments) {
    if (segment.type === "skill") {
      skillCount += 1;
      continue;
    }
    if (segment.type === "text" && segment.text.trim().length === 0) {
      continue;
    }
    return false;
  }

  return skillCount > 0;
}

export const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
  chatTypographyStyle: CSSProperties;
  resolvedTheme: "light" | "dark";
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor, matchIndex),
              `user-terminal-context-inline-before:${context.header}:${cursor}`,
              props.resolvedTheme,
            ),
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            ...renderUserMessageInlineText(
              props.text.slice(cursor),
              `user-message-terminal-context-inline-rest:${cursor}`,
              props.resolvedTheme,
            ),
          );
        }

        return (
          <div
            className="block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
            style={props.chatTypographyStyle}
          >
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(
        ...renderUserMessageInlineText(
          props.text,
          "user-message-terminal-context-inline-text",
          props.resolvedTheme,
        ),
      );
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div
        className="block max-w-full min-w-0 wrap-break-word whitespace-pre-wrap font-system-ui text-foreground"
        style={props.chatTypographyStyle}
      >
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  if (props.terminalContexts.length === 0 && hasOnlyInlineSkillChips(props.text)) {
    return (
      <div
        className="flex max-w-full min-w-0 items-center leading-none text-foreground [&>span]:translate-y-0"
        style={props.chatTypographyStyle}
      >
        {renderUserMessageInlineText(
          props.text,
          "user-message-inline-chip-only",
          props.resolvedTheme,
        )}
      </div>
    );
  }

  return (
    <div
      className="block max-w-full min-w-0 whitespace-pre-wrap break-words font-system-ui text-foreground"
      style={props.chatTypographyStyle}
    >
      {renderUserMessageInlineText(props.text, "user-message-inline", props.resolvedTheme)}
    </div>
  );
});

const UserMessageInlineAgentChip = memo(function UserMessageInlineAgentChip(props: {
  alias: string;
  color: string;
}) {
  const colors = AGENT_COLOR_STYLES[props.color] ?? DEFAULT_AGENT_COLOR;

  return (
    <span
      className={COMPOSER_INLINE_AGENT_CHIP_CLASS_NAME}
      style={{
        backgroundColor: colors.bg,
        color: colors.text,
      }}
    >
      <RiRobot3Line className={COMPOSER_INLINE_AGENT_CHIP_ICON_CLASS_NAME} />
      <span className={COMPOSER_INLINE_CHIP_LABEL_CLASS_NAME}>{`@${props.alias}`}</span>
    </span>
  );
});
