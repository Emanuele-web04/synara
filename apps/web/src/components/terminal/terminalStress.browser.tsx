// FILE: terminalStress.browser.tsx
// Purpose: Exercise real xterm parsing/rendering in Chromium under large output bursts.
// Layer: Browser performance test
// Depends on: @xterm/xterm and the browser Vitest Playwright provider.

import "../../index.css";
import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

type SynaraTerminalOptions = NonNullable<ConstructorParameters<typeof Terminal>[0]> & {
  vtExtensions?: { kittyKeyboard?: boolean };
};

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => {
    terminal.write(data, resolve);
  });
}

function readBufferTail(terminal: Terminal, lineCount: number): string {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.baseY + buffer.cursorY - lineCount);
  const end = buffer.baseY + buffer.cursorY;
  const lines: string[] = [];
  for (let line = start; line <= end; line += 1) {
    lines.push(buffer.getLine(line)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function canvasHasPaintedPixels(canvas: HTMLCanvasElement): boolean {
  if (canvas.width === 0 || canvas.height === 0) return false;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return false;

  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 3; index < data.length; index += 32) {
    if (data[index] !== 0) return true;
  }
  return false;
}

function surfaceHasRenderedContent(host: HTMLElement): boolean {
  if ((host.textContent ?? "").trim().length > 0) return true;
  return Array.from(host.querySelectorAll("canvas")).some(canvasHasPaintedPixels);
}

describe("terminal browser stress", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the terminal surface nonblank after a large output burst", async () => {
    const host = document.createElement("div");
    host.style.width = "960px";
    host.style.height = "520px";
    host.style.position = "relative";
    document.body.append(host);

    const fitAddon = new FitAddon();
    const terminalOptions: SynaraTerminalOptions = {
      allowProposedApi: true,
      cols: 120,
      cursorBlink: false,
      fontFamily: "monospace",
      fontSize: 12,
      rows: 30,
      scrollback: 5_000,
      vtExtensions: { kittyKeyboard: true },
    };
    const terminal = new Terminal(terminalOptions);
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();

    try {
      const payload = Array.from({ length: 2_400 }, (_, index) => {
        const marker = String(index).padStart(4, "0");
        return `stress-${marker} ${"x".repeat(96)}\r\n`;
      }).join("");

      const startedAt = performance.now();
      await writeTerminal(terminal, payload);
      const elapsedMs = performance.now() - startedAt;

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      expect(elapsedMs).toBeLessThan(5_000);
      expect(readBufferTail(terminal, 60)).toContain("stress-2399");
      expect(surfaceHasRenderedContent(host)).toBe(true);
    } finally {
      terminal.dispose();
    }
  });
});
