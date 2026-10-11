// Preserve state and current callbacks while streaming markdown updates.
import { render } from "vitest-browser-react";
import { describe, expect, it, vi } from "vitest";

import ChatMarkdown from "./ChatMarkdown";

const fenced = "```javascript\nconst answer = 42;\n```\n\nExplanation.";

describe("ChatMarkdown streaming identity", () => {
  it("keeps the code block and soft wrap while prose streams after it", async () => {
    const screen = await render(<ChatMarkdown text={fenced} cwd={undefined} isStreaming />);
    await screen.getByRole("button", { name: "Enable soft wrap" }).click();
    const block = document.querySelector(".chat-markdown-codeblock");
    expect(block?.getAttribute("data-wrap")).toBe("true");

    await screen.rerender(
      <ChatMarkdown text={fenced + " More detail."} cwd={undefined} isStreaming />,
    );
    expect(document.querySelector(".chat-markdown-codeblock")).toBe(block);
    expect(block?.getAttribute("data-wrap")).toBe("true");
    await screen.unmount();
  });

  it("shows the complete growing code when the stream finishes", async () => {
    const screen = await render(
      <ChatMarkdown text={"```text\npartial"} cwd={undefined} isStreaming />,
    );
    const finalCode = "partial\ncomplete final line";
    await screen.rerender(
      <ChatMarkdown
        text={`\`\`\`text\n${finalCode}\n\`\`\``}
        cwd={undefined}
        isStreaming={false}
      />,
    );
    await expect
      .poll(() => document.querySelector(".chat-markdown-codeblock pre")?.textContent)
      .toContain(finalCode);
    await screen.unmount();
  });

  it("emits per-word fade spans while streaming and keeps their identity", async () => {
    const screen = await render(<ChatMarkdown text="The quick" cwd={undefined} isStreaming />);
    // The fade latch flips in an effect after the first streamed render.
    await expect
      .poll(() => document.querySelectorAll("[data-chat-word-fade]").length)
      .toBeGreaterThan(0);

    const first = document.querySelector("[data-chat-word-fade]");
    expect(first?.textContent).toBe("The");

    await screen.rerender(
      <ChatMarkdown text="The quick brown fox jumps" cwd={undefined} isStreaming />,
    );
    await expect
      .poll(() => document.querySelectorAll("[data-chat-word-fade]").length)
      .toBeGreaterThanOrEqual(5);

    // A word already on screen is the same element after deltas arrive — its
    // offset key keeps identity stable, so it never re-fades.
    expect(document.querySelector("[data-chat-word-fade]")).toBe(first);

    await screen.unmount();
  });

  it("puts no word spans inside code blocks while streaming", async () => {
    const screen = await render(
      <ChatMarkdown
        text={"Intro.\n\n```text\nconst answer = 42;\n```\n"}
        cwd={undefined}
        isStreaming
      />,
    );
    await expect
      .poll(() => document.querySelectorAll("[data-chat-word-fade]").length)
      .toBeGreaterThan(0);
    expect(document.querySelector("pre [data-chat-word-fade]")).toBeNull();
    expect(document.querySelector("code [data-chat-word-fade]")).toBeNull();
    await screen.unmount();
  });

  it("keeps the word spans after the stream settles", async () => {
    const screen = await render(<ChatMarkdown text="The quick" cwd={undefined} isStreaming />);
    await expect
      .poll(() => document.querySelectorAll("[data-chat-word-fade]").length)
      .toBeGreaterThan(0);
    const spans = [...document.querySelectorAll("[data-chat-word-fade]")];

    await screen.rerender(<ChatMarkdown text="The quick" cwd={undefined} isStreaming={false} />);
    // The latch never resets: the settled render reuses the same spans so no
    // element swap replays the fade.
    expect(document.querySelectorAll("[data-chat-word-fade]").length).toBe(spans.length);
    for (const span of spans) {
      expect(document.contains(span)).toBe(true);
    }
    await screen.unmount();
  });

  it("marks already-arrived words instant on a mid-stream remount", async () => {
    // Remounting mid-stream (virtualization) must not re-fade the whole visible
    // message: every word present at mount is marked instant, only a genuinely
    // new trailing partial word may animate.
    const screen = await render(
      <ChatMarkdown text="The quick brown fox jumps" cwd={undefined} isStreaming />,
    );
    await expect
      .poll(() => document.querySelectorAll("[data-chat-word-fade]").length)
      .toBeGreaterThan(0);
    const instant = document.querySelectorAll('[data-chat-word-fade="instant"]');
    const all = document.querySelectorAll("[data-chat-word-fade]");
    // "jumps" — the trailing partial word — is the only animated span.
    expect(instant.length).toBe(all.length - 1);
    expect(all[all.length - 1]?.textContent).toBe("jumps");
    await screen.unmount();
  });

  it("uses the latest checkbox callback without changing markdown text", async () => {
    const previous = vi.fn();
    const current = vi.fn();
    const screen = await render(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={previous} />,
    );
    await screen.rerender(
      <ChatMarkdown text="- [ ] Task" cwd={undefined} onTaskToggle={current} />,
    );
    await screen.getByRole("checkbox").click();
    expect(previous).not.toHaveBeenCalled();
    expect(current).toHaveBeenCalledWith({ sourceLine: 1, checked: true });
    await screen.unmount();
  });
});
