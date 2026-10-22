import assert from "node:assert/strict";
import { test } from "vitest";
import { notionBlockDraftPatch } from "./notionDrafts";

const text = (content: string) => [
  { type: "text", text: { content }, annotations: { bold: true }, plain_text: content },
];

test("block patch sends only edited supported fields and preserves rich text", () => {
  const base = {
    rich_text: text("Original"),
    checked: false,
    color: "red",
    unknown: { retained: true },
  };
  const draft = { ...base, rich_text: text("Local change") };
  const patch = notionBlockDraftPatch("to_do", base, draft);
  assert.deepEqual(Object.keys(patch.changes), ["rich_text"]);
  assert.deepEqual(patch.base.rich_text, text("Original"));
  assert.deepEqual(patch.changes.rich_text, text("Local change"));
  assert.equal(base.unknown.retained, true);
  assert.equal(base.checked, false);
});

test("checkbox-only change does not overwrite text changed by another user", () => {
  const base = { rich_text: text("Original"), checked: false };
  assert.deepEqual(notionBlockDraftPatch("to_do", base, { ...base, checked: true }), {
    base: { checked: false },
    changes: { checked: true },
  });
});

test("saved block comparison does not depend on later mutations to its input", () => {
  const base = { rich_text: text("Original") };
  const draft = { rich_text: text("Local") };
  const patch = notionBlockDraftPatch("paragraph", base, draft);
  base.rich_text[0]!.text.content = "Refetched";
  draft.rich_text[0]!.text.content = "Changed again";
  assert.deepEqual(patch.base.rich_text, text("Original"));
  assert.deepEqual(patch.changes.rich_text, text("Local"));
});

test("no-op drafts do not issue writes", () => {
  const base = { rich_text: text("Original"), checked: false };
  assert.deepEqual(notionBlockDraftPatch("to_do", base, structuredClone(base)), {
    base: {},
    changes: {},
  });
});

test("unsupported or incomplete blocks cannot be rewritten", () => {
  assert.throws(
    () => notionBlockDraftPatch("synced_block", { rich_text: [] }, { rich_text: [] }),
    /read-only/,
  );
  assert.throws(() => notionBlockDraftPatch("paragraph", {}, { rich_text: [] }), /incomplete/);
  assert.throws(
    () => notionBlockDraftPatch("to_do", { rich_text: [] }, { rich_text: [], checked: true }),
    /incomplete/,
  );
});
