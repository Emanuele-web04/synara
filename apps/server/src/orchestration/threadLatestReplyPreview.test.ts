import { THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  formatThreadLatestReplyPreview,
  THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH,
} from "./threadLatestReplyPreview.ts";

const stored = (
  text: string,
  overrides: { textTruncated?: boolean; encodedText?: string; encodedTextTruncated?: boolean } = {},
) =>
  formatThreadLatestReplyPreview({
    text,
    textTruncated: overrides.textTruncated ?? false,
    encodedText: overrides.encodedText ?? null,
    encodedTextTruncated: overrides.encodedTextTruncated ?? false,
  });

describe("formatThreadLatestReplyPreview", () => {
  it("reduces a Markdown reply to one plain line", () => {
    expect(
      stored(
        "I'd like to run `gh workflow run release.yml`\n\nto **time** the [cached build](https://ci.example/run/1).\n```sh\nbun run build\n```",
      ),
    ).toBe("I'd like to run gh workflow run release.yml to time the cached build. bun run build");
  });

  it("is absent when nothing readable is left", () => {
    expect(stored("")).toBeUndefined();
    expect(stored(" \n\n ")).toBeUndefined();
    expect(stored("![diagram](./diagram.png)")).toBeUndefined();
  });

  it("caps a long reply at the contract length on a grapheme boundary", () => {
    const preview = stored(`${"a".repeat(THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH - 2)}🇮🇹 tail`);
    expect(preview).toBe(`${"a".repeat(THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH - 2)}…`);
  });

  it("ends in an ellipsis when the stored reply runs past what was read", () => {
    expect(
      stored("Short head of a [much](https://example.com) longer", { textTruncated: true }),
    ).toBe("Short head of a much longer…");
  });

  it("reads the JSON fallback column, and ignores it when it is malformed", () => {
    expect(stored("lossy", { encodedText: JSON.stringify("Kept\u0000 **intact**") })).toBe(
      "Kept\u0000 intact",
    );
    expect(stored("Plain column", { encodedText: "{not json" })).toBe("Plain column");
    const long = `${"word ".repeat(THREAD_LATEST_REPLY_PREVIEW_SOURCE_LENGTH)}end`;
    expect(stored("lossy", { encodedText: JSON.stringify(long) })).toHaveLength(
      THREAD_LATEST_REPLY_PREVIEW_MAX_LENGTH,
    );
  });

  it("decodes a bounded JSON prefix ending inside a Unicode escape", () => {
    const encodedPrefix = JSON.stringify('Kept "intact"').slice(0, -1) + "\\u00";
    expect(stored("lossy", { encodedText: encodedPrefix, encodedTextTruncated: true })).toBe(
      'Kept "intact"…',
    );
  });
});
