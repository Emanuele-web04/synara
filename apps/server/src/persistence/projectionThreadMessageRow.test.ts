import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionThreadMessageDbRowSchema,
  orchestrationMessageFromProjectionRow,
  projectionThreadMessageFromRow,
} from "./projectionThreadMessageRow.ts";

const decodeRow = Schema.decodeUnknownSync(ProjectionThreadMessageDbRowSchema);

const baseRow = {
  messageId: "message-row-1",
  threadId: "thread-row-1",
  turnId: "turn-row-1",
  role: "user",
  text: "Use @github with $check-code",
  attachments: JSON.stringify([
    {
      type: "file",
      id: "attachment-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    },
  ]),
  skills: JSON.stringify([
    {
      name: "check-code",
      path: "/skills/check-code/SKILL.md",
    },
  ]),
  mentions: JSON.stringify([
    {
      name: "github",
      path: "plugin://github",
    },
  ]),
  dispatchMode: "steer",
  dispatchOrigin: "automation",
  isStreaming: 1,
  source: "native",
  sequence: 42,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:01.000Z",
};

describe("projection thread message row codec", () => {
  it("decodes JSON metadata and preserves repository-only dispatch and sequence fields", () => {
    const row = decodeRow(baseRow);
    const message = projectionThreadMessageFromRow(row);

    expect(message).toMatchObject({
      messageId: "message-row-1",
      threadId: "thread-row-1",
      turnId: "turn-row-1",
      role: "user",
      text: "Use @github with $check-code",
      attachments: [{ type: "file", id: "attachment-1", name: "notes.txt" }],
      skills: [{ name: "check-code", path: "/skills/check-code/SKILL.md" }],
      mentions: [{ name: "github", path: "plugin://github" }],
      dispatchMode: "steer",
      dispatchOrigin: "automation",
      isStreaming: true,
      source: "native",
      sequence: 42,
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-20T10:00:01.000Z",
    });
  });

  it("maps the same decoded row directly to orchestration shape and omits nullable optionals", () => {
    const projected = orchestrationMessageFromProjectionRow(decodeRow(baseRow));
    expect(projected).toMatchObject({
      id: "message-row-1",
      turnId: "turn-row-1",
      streaming: true,
      attachments: [{ id: "attachment-1" }],
      skills: [{ name: "check-code" }],
      mentions: [{ name: "github" }],
      dispatchMode: "steer",
      dispatchOrigin: "automation",
    });
    expect("sequence" in projected).toBe(false);

    const nullRow = decodeRow({
      ...baseRow,
      turnId: null,
      attachments: null,
      skills: null,
      mentions: null,
      dispatchMode: null,
      dispatchOrigin: null,
      isStreaming: 0,
      sequence: null,
    });
    const repositoryMessage = projectionThreadMessageFromRow(nullRow);
    const orchestrationMessage = orchestrationMessageFromProjectionRow(nullRow);

    expect(repositoryMessage).toMatchObject({
      turnId: null,
      isStreaming: false,
    });
    expect(orchestrationMessage).toMatchObject({
      turnId: null,
      streaming: false,
    });
    for (const optionalField of [
      "attachments",
      "skills",
      "mentions",
      "dispatchMode",
      "dispatchOrigin",
      "sequence",
    ]) {
      expect(optionalField in repositoryMessage).toBe(false);
      expect(optionalField in orchestrationMessage).toBe(false);
    }
  });

  it("rejects invalid persisted JSON before either converter runs", () => {
    for (const field of ["attachments", "skills", "mentions"] as const) {
      expect(() =>
        decodeRow({
          ...baseRow,
          [field]: "{not-json",
        }),
      ).toThrow();
    }
  });
});
