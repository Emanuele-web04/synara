// FILE: useComposerDropzone.browser.tsx
// Purpose: Verify native drag events at the shared composer boundary in Chromium.
// Layer: Web browser regressions; uses real DataTransfer payloads and React handlers.

import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { formatComposerMentionToken } from "~/lib/composerMentions";

import { useComposerDropzone } from "./useComposerDropzone";

// Keep the hook's observable draft, attachments and focus on a small native host.
function Dropzone({ disabled = false }: { disabled?: boolean }) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<readonly File[]>([]);
  const [files, setFiles] = useState<readonly File[]>([]);
  const [dragging, setDragging] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const { onComposerDragEnter, onComposerDragOver, onComposerDragLeave, onComposerDrop } =
    useComposerDropzone({
      disabled,
      addImages: setImages,
      fileSupport: { genericFiles: "accept", addFiles: setFiles },
      appendPathMentions: (paths) => setDraft(paths.map(formatComposerMentionToken).join(" ")),
      focusComposer: () => composer.current?.focus(),
      setIsDragOverComposer: setDragging,
    });

  return (
    <div
      data-testid="dropzone"
      data-dragging={dragging}
      onDragEnter={onComposerDragEnter}
      onDragOver={onComposerDragOver}
      onDragLeave={onComposerDragLeave}
      onDrop={onComposerDrop}
    >
      <textarea ref={composer} value={draft} disabled={disabled} readOnly />
      <output data-testid="images">{images.map((file) => file.name).join(",")}</output>
      <output data-testid="files">{files.map((file) => file.name).join(",")}</output>
    </div>
  );
}

// Dispatch through the DOM so cancellation and bubbling come from the real hook.
function dispatchDrag(target: Element, type: string, dataTransfer: DataTransfer) {
  const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer });
  flushSync(() => target.dispatchEvent(event));
  return event;
}

describe("composer native path drops", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([false, true])("leaves normal link drops alone when disabled=%s", async (disabled) => {
    vi.stubGlobal("desktopBridge", {});
    await render(<Dropzone disabled={disabled} />);
    const target = document.querySelector('[data-testid="dropzone"]')!;
    const transfer = new DataTransfer();
    transfer.setData("text/uri-list", "https://example.com/page");
    transfer.setData("text/plain", "https://example.com/page");

    expect(dispatchDrag(target, "dragenter", transfer).defaultPrevented).toBe(false);
    dispatchDrag(target, "dragover", transfer);
    expect(target.getAttribute("data-dragging")).toBe("false");
    expect(dispatchDrag(target, "drop", transfer).defaultPrevented).toBe(false);
    expect(target.querySelector("textarea")?.value).toBe("");
  });

  it.each([
    ["codefiles", JSON.stringify(["/Users/me/My Repo/src"])],
    ["text/uri-list", "# folder\r\nfile:///Users/me/My%20Repo/src"],
  ])("accepts desktop folders from %s and blocks them when disabled", async (type, payload) => {
    vi.stubGlobal("desktopBridge", {});
    const screen = await render(<Dropzone />);
    const target = document.querySelector('[data-testid="dropzone"]')!;
    const composer = target.querySelector("textarea")!;
    const transfer = new DataTransfer();
    transfer.setData(type, payload);

    dispatchDrag(target, "dragenter", transfer);
    expect(dispatchDrag(target, "dragover", transfer).defaultPrevented).toBe(true);
    expect(dispatchDrag(target, "drop", transfer).defaultPrevented).toBe(true);
    expect(composer.value).toBe('@"/Users/me/My Repo/src"');
    expect(document.activeElement).toBe(composer);
    expect(target.getAttribute("data-dragging")).toBe("false");

    await screen.rerender(<Dropzone disabled />);
    dispatchDrag(target, "dragenter", transfer);
    dispatchDrag(target, "dragover", transfer);
    expect(dispatchDrag(target, "drop", transfer).defaultPrevented).toBe(true);
    expect(composer.value).toBe('@"/Users/me/My Repo/src"');
    expect(target.getAttribute("data-dragging")).toBe("false");
  });

  it.each([
    [
      "POSIX",
      "codefiles",
      JSON.stringify(["/repo/src", "/repo/shot.png", "/repo/notes.txt"]),
      "/repo/",
      "@/repo/src",
    ],
    [
      "Windows",
      "text/uri-list",
      "file:///C:/repo/src\nfile:///C:/repo/shot.png\nfile:///C:/repo/notes.txt",
      "C:\\repo\\",
      "@C:/repo/src",
    ],
    [
      "unresolved",
      "codefiles",
      JSON.stringify(["/repo/src", "/repo/shot.png", "/repo/notes.txt"]),
      "",
      "",
    ],
  ])(
    "preserves %s mixed attachments and only unrepresented folder paths",
    async (_label, type, payload, prefix, draft) => {
      vi.stubGlobal("desktopBridge", {
        getPathForFile: (file: File) => (prefix ? `${prefix}${file.name}` : ""),
      });
      await render(<Dropzone />);
      const target = document.querySelector('[data-testid="dropzone"]')!;
      const transfer = new DataTransfer();
      transfer.items.add(new File(["image"], "shot.png", { type: "image/png" }));
      transfer.items.add(new File(["text"], "notes.txt", { type: "text/plain" }));
      transfer.setData(type, payload);

      dispatchDrag(target, "dragenter", transfer);
      dispatchDrag(target, "dragover", transfer);
      expect(dispatchDrag(target, "drop", transfer).defaultPrevented).toBe(true);
      expect(target.querySelector("textarea")?.value).toBe(draft);
      expect(target.querySelector('[data-testid="images"]')?.textContent).toBe("shot.png");
      expect(target.querySelector('[data-testid="files"]')?.textContent).toBe("notes.txt");
    },
  );

  it("leaves path-only drags alone in the browser and still accepts real Files", async () => {
    vi.stubGlobal("desktopBridge", undefined);
    await render(<Dropzone />);
    const target = document.querySelector('[data-testid="dropzone"]')!;
    const paths = new DataTransfer();
    paths.setData("codefiles", JSON.stringify(["/repo/src"]));
    paths.setData("text/uri-list", "file:///repo/src");

    expect(dispatchDrag(target, "dragenter", paths).defaultPrevented).toBe(false);
    expect(dispatchDrag(target, "dragover", paths).defaultPrevented).toBe(false);
    expect(dispatchDrag(target, "drop", paths).defaultPrevented).toBe(false);
    expect(target.querySelector("textarea")?.value).toBe("");
    expect(target.getAttribute("data-dragging")).toBe("false");

    const files = new DataTransfer();
    files.items.add(new File(["text"], "notes.txt", { type: "text/plain" }));
    expect(dispatchDrag(target, "drop", files).defaultPrevented).toBe(true);
    expect(target.querySelector('[data-testid="files"]')?.textContent).toBe("notes.txt");
  });
});
