import "../index.css";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";
import ChatMarkdown from "./ChatMarkdown";

const diagram = "flowchart LR\naccTitle: Review flow\nA[Ready] --> B[Review]";
const fence = (code: string) => `\`\`\`mermaid\n${code}\n\`\`\``;

async function renderedSvg(title: string): Promise<string> {
  let image: HTMLImageElement | null = null;
  await expect
    .poll(() => {
      image = document.querySelector<HTMLImageElement>(`img[alt="${title}"]`);
      return image?.complete && image.naturalWidth > 0;
    })
    .toBe(true);
  return fetch(image!.src).then((response) => response.text());
}

it("renders a settled fence and preserves source copying and in-thread find", async () => {
  const text = fence(diagram);
  const screen = await render(<ChatMarkdown text={text} cwd={undefined} isStreaming />);
  try {
    expect(document.querySelector(".chat-markdown img")).toBeNull();
    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} />);
    const svg = await renderedSvg("Review flow");
    expect(svg).toContain("Ready");
    expect(svg).toContain("Review");
    await expect.element(screen.getByRole("button", { name: "Copy code" })).toBeVisible();
    expect(document.querySelector(".chat-markdown-codeblock__body svg")).toBeNull();

    await screen.rerender(<ChatMarkdown text={text} cwd={undefined} findQuery="Ready" />);
    await expect.poll(() => document.querySelector(".chat-markdown img")).toBeNull();
    await expect
      .poll(() => document.querySelector("[data-chat-find-match]")?.textContent)
      .toBe("Ready");
  } finally {
    await screen.unmount();
  }
});

it("keeps invalid source without breaking the following diagram or leaking error markup", async () => {
  const invalid = "flowchart LR\nUnfinished[";
  const screen = await render(
    <ChatMarkdown text={`${fence(invalid)}\n\n${fence(diagram)}`} cwd={undefined} />,
  );
  try {
    await renderedSvg("Review flow");
    expect(document.querySelector(".chat-markdown pre")?.textContent).toContain(invalid);
    expect(document.querySelectorAll(".chat-markdown img")).toHaveLength(1);
    expect(document.querySelector('[id^="dsynara-mermaid-"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Syntax error in text");
  } finally {
    await screen.unmount();
  }
});

it("does not let diagram directives enable active HTML, links or application CSS", async () => {
  const opacity = getComputedStyle(document.body).opacity;
  const source = [
    '%%{init: {"securityLevel":"loose","htmlLabels":true,"themeCSS":"body { opacity: 0 }"}}%%',
    "flowchart LR",
    "accTitle: Untrusted diagram",
    "A[Ready] --> B[Safe]",
    'click B "javascript:alert(1)"',
  ].join("\n");
  const hostileLabel = 'flowchart LR\nX["<img src=x onerror=alert(1)>"] --> Y[Safe]';
  const screen = await render(
    <ChatMarkdown text={`${fence(hostileLabel)}\n\n${fence(source)}`} cwd={undefined} />,
  );
  try {
    const svg = await renderedSvg("Untrusted diagram");
    const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(parsed.querySelector("script, iframe, [onerror], [onclick], a[href]")).toBeNull();
    expect(document.querySelector(".chat-markdown script, .chat-markdown iframe")).toBeNull();
    expect(getComputedStyle(document.body).opacity).toBe(opacity);
  } finally {
    await screen.unmount();
  }
});
