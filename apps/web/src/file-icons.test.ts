import { assert, describe, it } from "vitest";

import {
  getAttachmentIconName,
  getFileIconName,
  inferEntryKindFromPath,
  pathLooksLikeKnownFile,
} from "./file-icons";

// Object.prototype member names, which lookup keys can collide with because they are
// derived from untrusted text. Only `constructor` and `__proto__` survive the lowercased
// basename (`toString` becomes `tostring` and misses by luck), so pin them all.
const PROTOTYPE_MEMBER_TOKENS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "map.constructor",
  "obj.__proto__",
];

describe("getFileIconName", () => {
  it("uses exact filename matches from the Central mapping", () => {
    assert.equal(getFileIconName("package.json"), "npm");
    assert.equal(getFileIconName("bun.lock"), "bun");
    assert.equal(getFileIconName("tsconfig.json"), "typescript");
    assert.equal(getFileIconName(".gitignore"), "git");
    assert.equal(getFileIconName("Cargo.toml"), "rust");
  });

  it("prefers the longest compound extension", () => {
    assert.equal(getFileIconName("checkbox.tsx"), "react");
    assert.equal(getFileIconName("types.d.ts"), "typescript");
    assert.equal(getFileIconName("logic.ts"), "typescript");
  });

  it("resolves common language extensions", () => {
    assert.equal(getFileIconName("main.py"), "phyton");
    assert.equal(getFileIconName("lib.rs"), "rust");
    assert.equal(getFileIconName("index.php"), "php");
    assert.equal(getFileIconName("App.vue"), "vue");
    assert.equal(getFileIconName("Counter.svelte"), "svelte");
    assert.equal(getFileIconName("Main.java"), "java");
    assert.equal(getFileIconName("readme.md"), "markdown");
    assert.equal(getFileIconName("general.mdc"), "markdown");
    assert.equal(getFileIconName(".github/workflows/ci.yml"), "settings-gear-1");
  });

  it("resolves common attachment extensions", () => {
    assert.equal(getFileIconName("meeting.ics"), "calendar-days");
    assert.equal(getFileIconName("contacts.csv"), "file-chart");
    assert.equal(getFileIconName("report.docx"), "page-text");
    assert.equal(getFileIconName("budget.xlsx"), "file-chart");
    assert.equal(getFileIconName("deck.pptx"), "page-text");
  });

  it("falls back to the bracket glyph for unknown or icon-less types", () => {
    // Swift/Go/Ruby have no dedicated Central icon, so they use the bracket.
    assert.equal(getFileIconName("App.swift"), "code-brackets");
    assert.equal(getFileIconName("main.go"), "code-brackets");
    assert.equal(getFileIconName("server.rb"), "code-brackets");
    assert.equal(getFileIconName("foo.unknown-ext"), "code-brackets");
    assert.equal(getFileIconName("notes"), "code-brackets");
  });

  it("is case insensitive on basename lookup", () => {
    assert.equal(getFileIconName("PACKAGE.JSON"), "npm");
    assert.equal(getFileIconName("Main.PY"), "phyton");
  });

  it("treats known extensionless basenames as files", () => {
    assert.equal(inferEntryKindFromPath("LICENSE"), "file");
    assert.equal(inferEntryKindFromPath("C:\\repo\\.gitignore"), "file");
    assert.equal(inferEntryKindFromPath("scripts"), "directory");
  });

  it("never resolves an inherited Object.prototype member as an icon name", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.equal(getFileIconName(token), "code-brackets", token);
    }
  });
});

describe("pathLooksLikeKnownFile", () => {
  it("does not mistake an Object.prototype member for a known file", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.isFalse(pathLooksLikeKnownFile(token), `${token} must not look like a known file`);
    }
  });

  it("still recognizes real files", () => {
    assert.isTrue(pathLooksLikeKnownFile("src/index.ts"));
    assert.isTrue(pathLooksLikeKnownFile("package.json"));
  });
});

describe("getAttachmentIconName", () => {
  it("prefers a recognizable extension over the MIME type", () => {
    assert.equal(
      getAttachmentIconName({ name: "meeting.ics", mimeType: "application/octet-stream" }),
      "calendar-days",
    );
    assert.equal(
      getAttachmentIconName({ name: "invoice.pdf", mimeType: "text/plain" }),
      "file-pdf",
    );
  });

  it("falls back to the MIME type when the filename has no extension", () => {
    // A download named only by its Content-Type (e.g. a UUID with a calendar body).
    assert.equal(
      getAttachmentIconName({ name: "99247298-78c2-44ba-a1f6", mimeType: "text/calendar" }),
      "calendar-days",
    );
    assert.equal(getAttachmentIconName({ name: "blob", mimeType: "application/pdf" }), "file-pdf");
  });

  it("uses the top-level MIME family for unmapped subtypes", () => {
    assert.equal(getAttachmentIconName({ name: "clip", mimeType: "audio/x-wav" }), "audio");
    assert.equal(getAttachmentIconName({ name: "movie", mimeType: "video/quicktime" }), "video");
    assert.equal(getAttachmentIconName({ name: "notes", mimeType: "text/plain" }), "file-text");
  });

  it("never resolves an inherited Object.prototype member as an icon name", () => {
    for (const token of PROTOTYPE_MEMBER_TOKENS) {
      assert.equal(getAttachmentIconName({ name: token, mimeType: "" }), "file-text", token);
    }
  });

  it("defaults to a document glyph rather than the source-code bracket", () => {
    assert.equal(
      getAttachmentIconName({ name: "download", mimeType: "application/octet-stream" }),
      "file-text",
    );
    assert.equal(getAttachmentIconName({ name: "download", mimeType: "" }), "file-text");
    assert.notEqual(
      getAttachmentIconName({ name: "download", mimeType: "application/octet-stream" }),
      "code-brackets",
    );
  });
});
