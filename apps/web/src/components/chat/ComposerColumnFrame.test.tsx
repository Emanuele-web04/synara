// FILE: ComposerColumnFrame.test.ts
// Purpose: Pins the composer column + stacked-header rail layout contract.
// Layer: Chat composer regression test
// Depends on: ComposerColumnFrame, ComposerStackedHeaderFrame.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_COLUMN_FRAME_CLASS_NAME,
  COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME,
} from "./composerPickerStyles";
import { ComposerColumnFrame, ComposerStackedHeaderFrame } from "./ComposerColumnFrame";

describe("ComposerColumnFrame", () => {
  it("applies the shared composer column frame", () => {
    const markup = renderToStaticMarkup(
      <ComposerColumnFrame>
        <div data-testid="child" />
      </ComposerColumnFrame>,
    );

    for (const className of COMPOSER_COLUMN_FRAME_CLASS_NAME.split(/\s+/)) {
      expect(markup).toContain(className);
    }
  });
});

describe("ComposerStackedHeaderFrame", () => {
  it("keeps stacked composer activity on the queued-row rail", () => {
    const markup = renderToStaticMarkup(
      <ComposerColumnFrame>
        <ComposerStackedHeaderFrame data-testid="stacked-frame">
          <div />
        </ComposerStackedHeaderFrame>
      </ComposerColumnFrame>,
    );

    for (const className of COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME.split(/\s+/)) {
      expect(markup).toContain(className);
    }
    expect(markup).toContain('data-testid="stacked-frame"');
  });

  it("uses a passthrough wrapper when side margins should not block clicks", () => {
    const markup = renderToStaticMarkup(
      <ComposerColumnFrame>
        <ComposerStackedHeaderFrame passthroughSideMargins>
          <div data-testid="content" />
        </ComposerStackedHeaderFrame>
      </ComposerColumnFrame>,
    );

    expect(markup).toContain('class="pointer-events-none w-full"');
    expect(markup).toContain(
      `class="pointer-events-auto ${COMPOSER_STACKED_HEADER_FRAME_CLASS_NAME}"`,
    );
    expect(markup).toContain('data-testid="content"');
  });
});
