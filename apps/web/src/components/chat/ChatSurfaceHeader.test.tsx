import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatSurfaceHeader } from "./ChatSurfaceHeader";

describe("ChatSurfaceHeader", () => {
  it("renders no header chrome when hidden", () => {
    const markup = renderToStaticMarkup(
      <ChatSurfaceHeader hidden>
        <span>Sidechat: Investigate cache</span>
        <button type="button">Close side chat</button>
      </ChatSurfaceHeader>,
    );

    expect(markup).toBe("");
  });
});
